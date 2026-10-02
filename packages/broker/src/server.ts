import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { Nexus } from "@nexus-js/core";
import type { RelayHandle } from "@nexus-js/core";
import { usingNodeIpcDaemon } from "@nexus-js/node-ipc";
import type { NodeIpcAdapterModel, NodeIpcSocketAddress } from "@nexus-js/node-ipc";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import {
  connectionConfig,
  connectionToken,
  workspaceToken,
  backgroundControlToken,
  protocolVersion,
  type ConnectionService,
  type VerifiedSocketFacts,
  connectionStatusResultCodec,
} from "@mpctl/contracts";
import { Result } from "better-result";
import type { Result as BetterResult } from "better-result";
import { UnixSocketServerEndpoint } from "@nexus-js/node-ipc";
import { WebSocketServerEndpoint } from "@nexus-js/websocket/server";
import type { WebSocketAdapterModel } from "@nexus-js/websocket/server";

const protocol = connectionConfig.selectedSubprotocol;
const credentialPrefix = connectionConfig.credentialSubprotocolPrefix;
type BrokerSocketFacts = VerifiedSocketFacts & { readonly sessionId: string };

export type BrokerOptions = {
  ipcAddress: NodeIpcSocketAddress;
  websocketPort: number;
  pairingCredential: string;
  host?: string;
};

export type Broker = {
  address(): BetterResult<{ host: string; port: number }, BrokerError>;
  close(): Promise<BetterResult<void, BrokerError>>;
  disconnectPlugin(): Promise<BetterResult<void, BrokerError>>;
};

export type BrokerError = {
  code:
    | "pairing_not_configured"
    | "ipc_endpoint_missing"
    | "broker_start_failed"
    | "broker_close_failed";
  cleanupFailed?: true;
};

export async function createBroker(
  options: BrokerOptions,
): Promise<BetterResult<Broker, BrokerError>> {
  if (!options.pairingCredential) return Result.err({ code: "pairing_not_configured" });
  const created = await Result.tryPromise({
    try: () => createBrokerInternal(options),
    catch: () => ({ code: "broker_start_failed" as const }),
  });
  return Result.isError(created) ? Result.err(created.error) : created.value;
}

async function createBrokerInternal(
  options: BrokerOptions,
): Promise<BetterResult<Broker, BrokerError>> {
  const expectedCredential = Buffer.from(options.pairingCredential);
  const host = options.host ?? "127.0.0.1";
  const wsEndpoint = new WebSocketServerEndpoint<BrokerSocketFacts>({ maxConnections: 1 });
  const ipcNexus = new Nexus<NodeIpcAdapterModel>();
  const websocketNexus = new Nexus<WebSocketAdapterModel<BrokerSocketFacts>>();
  const httpServer = createServer((_request, response) => response.writeHead(404).end());
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
    handleProtocols: (requested) => (requested.has(protocol) ? protocol : false),
  });
  let activeSocket: WebSocket | undefined;
  let pluginConnected = false;
  let pluginSessionId: string | undefined;
  let extensionVersion: string | undefined;
  let relay: RelayHandle | undefined;
  let stopObserving: (() => void) | undefined;
  let ipcEndpoint: UnixSocketServerEndpoint | undefined;
  const ipcConnections = new Set<import("@nexus-js/core").Connection<NodeIpcAdapterModel>>();
  let sessionGeneration = 0;
  let relayRegistration = Promise.resolve();

  const connectionService: ConnectionService = {
    async getStatus() {
      const encoded = await connectionStatusResultCodec.serialize(
        Result.ok({
          connected: pluginConnected,
          brokerVersion: protocolVersion,
          ...(extensionVersion ? { extensionVersion } : {}),
          ...(pluginSessionId ? { sessionId: pluginSessionId } : {}),
        }),
      );
      if (Result.isError(encoded)) {
        return { status: "error", error: encoded.error };
      }
      return encoded.value;
    },
  };
  const ipcConfig = usingNodeIpcDaemon({
    appId: "mpctl",
    address: options.ipcAddress,
    callTimeout: 2_000,
    configure: false,
    providers: [{ token: connectionToken, service: connectionService }],
  });
  ipcEndpoint = ipcConfig.endpoint?.implementation as UnixSocketServerEndpoint | undefined;
  if (!ipcEndpoint) {
    const cleaned = await cleanupBrokerResources({
      closeWebSocketEndpoint: () => wsEndpoint.close(),
      closeWebSocketServer: () => closeWsServer(wsServer),
    });
    return Result.err({
      code: "ipc_endpoint_missing",
      ...(Result.isError(cleaned) ? { cleanupFailed: true as const } : {}),
    });
  }
  ipcNexus.configure(ipcConfig as never);
  ipcNexus.onConnect((connection) => {
    ipcConnections.add(connection);
    connection.onDisconnected(() => ipcConnections.delete(connection));
  });

  websocketNexus.configure({
    endpoint: { meta: { context: "websocket-server" }, implementation: wsEndpoint },
    policy: {
      canConnect: ({ connection }) =>
        connection.role === "server" && connection.pairingVerified === true,
      canCall: ({ connection }) =>
        connection.role === "server" && connection.pairingVerified === true,
    },
    callTimeout: 2_000,
  });

  const clearSession = (socket?: WebSocket): void => {
    if (socket && activeSocket !== socket) return;
    sessionGeneration += 1;
    stopObserving?.();
    stopObserving = undefined;
    relay?.dispose();
    relay = undefined;
    activeSocket = undefined;
    pluginConnected = false;
    pluginSessionId = undefined;
    extensionVersion = undefined;
  };

  wsServer.on("connection", (socket) => {
    const facts: BrokerSocketFacts = Object.freeze({
      pairingVerified: true,
      sessionId: randomUUID(),
    });
    const attached = wsEndpoint.safeAttach(socket, facts);
    if (attached.isErr()) {
      socket.close();
      return;
    }
    activeSocket = socket;
    socket.once("close", () => clearSession(socket));
    stopObserving = websocketNexus.onConnect((connection) => {
      const meta = connection.connectionMeta;
      if (
        socket !== activeSocket ||
        meta.role !== "server" ||
        meta.pairingVerified !== true ||
        meta.sessionId !== facts.sessionId
      )
        return;
      const generation = sessionGeneration;
      const remoteVersion = (connection.contextMeta as { app?: { protocolVersion?: string } }).app
        ?.protocolVersion;
      extensionVersion = typeof remoteVersion === "string" ? remoteVersion : undefined;
      relayRegistration = relayRegistration.then(async () => {
        const installed = await Result.try({
          try: () => installRelayFor(socket, facts.sessionId, generation),
          catch: () => ({ code: "broker_start_failed" as const }),
        });
        if (Result.isError(installed)) {
          if (activeSocket === socket && sessionGeneration === generation) {
            pluginConnected = false;
          }
        }
      });
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/bridge") {
      socket.destroy();
      return;
    }
    const offered = parseProtocols(request.headers["sec-websocket-protocol"]);
    const credentials = offered.filter((value) => value.startsWith(credentialPrefix));
    const credential =
      credentials.length === 1 ? credentials[0]!.slice(credentialPrefix.length) : "";
    if (!secureEqual(Buffer.from(credential), expectedCredential) || !offered.includes(protocol)) {
      rejectUpgrade(socket, 401);
      return;
    }
    if (activeSocket && activeSocket.readyState === activeSocket.OPEN) {
      rejectUpgrade(socket, 409);
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (websocket) =>
      wsServer.emit("connection", websocket, request),
    );
  });

  const [ipcReady, websocketReady] = await Promise.all([
    Result.tryPromise({
      try: () => ipcNexus.ready(),
      catch: () => ({ code: "broker_start_failed" as const }),
    }),
    Result.tryPromise({
      try: () => websocketNexus.ready(),
      catch: () => ({ code: "broker_start_failed" as const }),
    }),
  ]);
  if (Result.isError(ipcReady) || Result.isError(websocketReady)) {
    const cleaned = await cleanupBrokerResources({
      closeIpc: Result.isOk(ipcReady) ? () => ipcEndpoint.close() : undefined,
      closeWebSocketEndpoint: () => wsEndpoint.close(),
      closeWebSocketServer: () => closeWsServer(wsServer),
      closeHttpServer: () => closeHttpServer(httpServer),
    });
    return Result.err({
      code: "broker_start_failed",
      ...(Result.isError(cleaned) ? { cleanupFailed: true as const } : {}),
    });
  }
  const listening = await Result.tryPromise({
    try: () => listen(httpServer, options.websocketPort, host),
    catch: () => ({ code: "broker_start_failed" as const }),
  });
  if (Result.isError(listening)) {
    const cleaned = await cleanupBrokerResources({
      closeIpc: () => ipcEndpoint.close(),
      closeWebSocketEndpoint: () => wsEndpoint.close(),
      closeWebSocketServer: () => closeWsServer(wsServer),
      closeHttpServer: () => closeHttpServer(httpServer),
    });
    return Result.err({
      ...listening.error,
      ...(Result.isError(cleaned) ? { cleanupFailed: true as const } : {}),
    });
  }

  async function installRelayFor(
    socket: WebSocket,
    sessionId: string,
    generation: number,
  ): Promise<void> {
    relay?.dispose();
    relay = undefined;
    if (
      activeSocket !== socket ||
      socket.readyState !== socket.OPEN ||
      sessionGeneration !== generation
    )
      return;
    relay = Nexus.relay<NodeIpcAdapterModel, WebSocketAdapterModel<BrokerSocketFacts>>({
      from: ipcNexus,
      to: {
        nexus: websocketNexus,
        where: (
          _identity: WebSocketAdapterModel<BrokerSocketFacts>["contextMeta"],
          observed: WebSocketAdapterModel<BrokerSocketFacts>["connectionMeta"],
        ) =>
          observed.role === "server" &&
          observed.pairingVerified === true &&
          observed.sessionId === sessionId,
      },
      services: [workspaceToken, backgroundControlToken],
    });
    pluginConnected = true;
    pluginSessionId = sessionId;
  }

  const disconnectPlugin = async (): Promise<BetterResult<void, BrokerError>> => {
    const socket = activeSocket;
    if (!socket) return Result.ok(undefined);
    return cleanupBrokerResources({
      clearSession: () => clearSession(socket),
      terminatePlugin: () => {
        if (socket.readyState < socket.CLOSING) socket.terminate();
      },
      awaitRelayRegistration: () => relayRegistration,
    });
  };

  return Result.ok({
    address() {
      const address = httpServer.address();
      if (!address || typeof address === "string")
        return Result.err({ code: "broker_start_failed" });
      return Result.ok({ host, port: address.port });
    },
    disconnectPlugin,
    async close() {
      const disconnected = await disconnectPlugin();
      const operations: Record<string, (() => unknown) | undefined> = {
        disposeRelay: () => {
          relay?.dispose();
          relay = undefined;
        },
        closeWebSocketEndpoint: () => wsEndpoint.close(),
        terminateWebSockets: () => {
          for (const socket of wsServer.clients) socket.terminate();
        },
        closeIpc: () => ipcEndpoint?.close(),
        closeHttpConnections: () => httpServer.closeAllConnections(),
        closeWebSocketServer: () => closeWsServer(wsServer),
        closeHttpServer: () => closeHttpServer(httpServer),
      };
      for (const [index, connection] of [...ipcConnections].entries()) {
        operations[`disconnectIpcClient${index}`] = () => connection.disconnect();
      }
      ipcConnections.clear();
      const cleaned = await cleanupBrokerResources(operations);
      if (Result.isError(disconnected) || Result.isError(cleaned))
        return Result.err({
          code: "broker_close_failed",
          ...(Result.isError(disconnected) && Result.isError(cleaned)
            ? { cleanupFailed: true as const }
            : {}),
        });
      return Result.ok(undefined);
    },
  });
}

function parseProtocols(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .map((part) => part.trim());
}

function secureEqual(candidate: Buffer, expected: Buffer): boolean {
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function rejectUpgrade(socket: Duplex, status: 401 | 409): void {
  const label = status === 401 ? "Unauthorized" : "Conflict";
  socket.write(
    `HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.end(),
  );
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeWsServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function cleanupBrokerResources(
  operations: Record<string, (() => unknown) | undefined>,
): Promise<BetterResult<void, BrokerError>> {
  let failed = false;
  for (const operation of Object.values(operations)) {
    if (!operation) continue;
    const result = await Result.tryPromise({
      try: () => Promise.resolve(operation()),
      catch: () => ({ code: "broker_close_failed" as const }),
    });
    if (Result.isError(result)) failed = true;
  }
  return failed ? Result.err({ code: "broker_close_failed" }) : Result.ok(undefined);
}
