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
  controlStatusResultCodec,
  ledgerIdSchema,
} from "@mpctl/contracts";
import { Result } from "better-result";
import type { Result as BetterResult } from "better-result";
import { UnixSocketServerEndpoint } from "@nexus-js/node-ipc";
import { WebSocketServerEndpoint } from "@nexus-js/websocket/server";
import type { WebSocketAdapterModel } from "@nexus-js/websocket/server";
import * as v from "valibot";

const protocol = connectionConfig.selectedSubprotocol;
const credentialPrefix = connectionConfig.credentialSubprotocolPrefix;
const SESSION_STATUS_INTERVAL_MS = 20_000;
const SESSION_STATUS_CALL_TIMEOUT_MS = 2_000;
// Optional authority must not consume the CLI's existing 2s diagnostic budget.
// One 750ms envelope covers acquisition, RPC and decode, leaving 1250ms for
// IPC transport/encoding/scheduling. Heartbeat timing is a separate responsibility.
const STATUS_NAMESPACE_BUDGET_MS = 750;
type BrokerSocketFacts = VerifiedSocketFacts & { readonly sessionId: string };

function peerVersion(identity: unknown): string | undefined {
  if (typeof identity !== "object" || identity === null || !("app" in identity)) return;
  const app = identity.app;
  if (typeof app !== "object" || app === null || !("protocolVersion" in app)) return;
  return typeof app.protocolVersion === "string" ? app.protocolVersion : undefined;
}
function peerLedger(identity: unknown): string | undefined {
  if (!identity || typeof identity !== "object" || !("app" in identity)) return;
  const app = identity.app;
  if (!app || typeof app !== "object" || !("ledgerId" in app)) return;
  const parsed = v.safeParse(ledgerIdSchema, app.ledgerId);
  return parsed.success ? parsed.output : undefined;
}

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
  let ledgerId: string | undefined;
  let relay: RelayHandle | undefined;
  let stopObserving: (() => void) | undefined;
  let ipcEndpoint: UnixSocketServerEndpoint | undefined;
  const ipcConnections = new Set<import("@nexus-js/core").Connection<NodeIpcAdapterModel>>();
  let sessionGeneration = 0;
  let relayRegistration = Promise.resolve();
  let sessionStatusTimer: ReturnType<typeof setTimeout> | undefined;

  const connectionService: ConnectionService = {
    async getStatus() {
      // Reuse the already-existing control status across the admitted session.
      // Never cache epoch replies: overlapping old replies cannot roll back the
      // authority used by a later call. After awaiting, recheck the exact session.
      const socket = activeSocket;
      const sessionId = pluginSessionId;
      const generation = sessionGeneration;
      const stableLedger = ledgerId;
      let keyLedgerId: string | undefined;
      if (socket && sessionId && pluginConnected) {
        const deadline = performance.now() + STATUS_NAMESPACE_BUDGET_MS;
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            abort.abort();
            resolve(undefined);
          }, STATUS_NAMESPACE_BUDGET_MS);
        });
        const namespace = async (): Promise<string | undefined> => {
          const connection = await websocketNexus.safeConnect({
            where: (
              _identity: WebSocketAdapterModel<BrokerSocketFacts>["contextMeta"],
              observed: WebSocketAdapterModel<BrokerSocketFacts>["connectionMeta"],
            ) => observed.role === "server" && observed.sessionId === sessionId,
            timeout: STATUS_NAMESPACE_BUDGET_MS,
            signal: abort.signal,
          });
          if (connection.isOk()) {
            const remaining = deadline - performance.now();
            if (remaining <= 0) return;
            const acquired = connection.value.safeGet(backgroundControlToken, {
              callTimeout: remaining,
            });
            if (acquired.isOk()) {
              const response = await Nexus.safeCall(acquired.value.getStatus());
              if (response.isOk()) {
                const decoded = await controlStatusResultCodec.deserialize(response.value);
                if (
                  decoded.isOk() &&
                  performance.now() < deadline &&
                  decoded.value.connected &&
                  isCurrentSession(socket, sessionId, generation) &&
                  ledgerId === stableLedger &&
                  peerLedger(connection.value.contextMeta) === stableLedger &&
                  peerVersion(connection.value.contextMeta) === protocolVersion
                )
                  return decoded.value.keyLedgerId;
              }
            }
          }
        };
        try {
          // The losing task cannot update reply state. safeCall has its own
          // remaining deadline; a remote handler may continue, not get cancelled.
          keyLedgerId = await Promise.race([namespace().catch(() => undefined), expired]);
        } finally {
          clearTimeout(timer);
          abort.abort();
        }
        if (!isCurrentSession(socket, sessionId, generation) || ledgerId !== stableLedger)
          keyLedgerId = undefined;
      }
      const encoded = await connectionStatusResultCodec.serialize(
        Result.ok({
          connected: pluginConnected,
          brokerVersion: protocolVersion,
          ...(extensionVersion ? { extensionVersion } : {}),
          ...(pluginSessionId ? { sessionId: pluginSessionId } : {}),
          ...(ledgerId ? { ledgerId } : {}),
          ...(keyLedgerId ? { keyLedgerId } : {}),
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
    policy: {
      // Diagnostics stay reachable to old clients; every workspace reader and
      // writer (including key acquisition) requires the exact wire version.
      canCall: ({ remoteIdentity, serviceName }) =>
        (serviceName !== workspaceToken.id && serviceName !== backgroundControlToken.id) ||
        peerVersion(remoteIdentity) === protocolVersion,
    },
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
    endpoint: {
      meta: { context: "websocket-server", app: { protocolVersion } },
      implementation: wsEndpoint,
    },
    policy: {
      canConnect: ({ connection, remoteIdentity }) =>
        connection.role === "server" &&
        connection.pairingVerified === true &&
        peerVersion(remoteIdentity) === protocolVersion &&
        peerLedger(remoteIdentity) !== undefined,
      canCall: ({ connection, remoteIdentity }) =>
        connection.role === "server" &&
        connection.pairingVerified === true &&
        peerVersion(remoteIdentity) === protocolVersion &&
        peerLedger(remoteIdentity) !== undefined,
    },
    callTimeout: 2_000,
  });

  const clearSession = (socket?: WebSocket): void => {
    if (socket && activeSocket !== socket) return;
    if (sessionStatusTimer) clearTimeout(sessionStatusTimer);
    sessionStatusTimer = undefined;
    sessionGeneration += 1;
    stopObserving?.();
    stopObserving = undefined;
    relay?.dispose();
    relay = undefined;
    activeSocket = undefined;
    pluginConnected = false;
    pluginSessionId = undefined;
    extensionVersion = undefined;
    ledgerId = undefined;
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
      extensionVersion = peerVersion(connection.contextMeta);
      ledgerId = peerLedger(connection.contextMeta);
      if (extensionVersion !== protocolVersion || !ledgerId) return;
      connection.onDisconnected(() => {
        if (activeSocket !== socket || sessionGeneration !== generation) return;
        clearSession(socket);
        if (socket.readyState < socket.CLOSING) socket.terminate();
      });
      relayRegistration = relayRegistration.then(async () => {
        const installed = await Result.try({
          try: () => installRelayFor(socket, facts.sessionId, generation, connection),
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
    connection: import("@nexus-js/core").Connection<WebSocketAdapterModel<BrokerSocketFacts>>,
  ): Promise<void> {
    if (
      activeSocket !== socket ||
      socket.readyState !== socket.OPEN ||
      sessionGeneration !== generation ||
      connection.status !== "connected" ||
      peerVersion(connection.contextMeta) !== protocolVersion ||
      peerLedger(connection.contextMeta) !== ledgerId ||
      !ledgerId
    )
      return;
    if (sessionStatusTimer) clearTimeout(sessionStatusTimer);
    sessionStatusTimer = undefined;
    relay?.dispose();
    relay = undefined;
    relay = Nexus.relay<NodeIpcAdapterModel, WebSocketAdapterModel<BrokerSocketFacts>>({
      from: ipcNexus,
      to: {
        nexus: websocketNexus,
        where: (
          identity: WebSocketAdapterModel<BrokerSocketFacts>["contextMeta"],
          observed: WebSocketAdapterModel<BrokerSocketFacts>["connectionMeta"],
        ) =>
          peerVersion(identity) === protocolVersion &&
          peerLedger(identity) === ledgerId &&
          connection.status === "connected" &&
          activeSocket === socket &&
          sessionGeneration === generation &&
          observed.role === "server" &&
          observed.pairingVerified === true &&
          observed.sessionId === sessionId,
      },
      services: [workspaceToken, backgroundControlToken],
    });
    pluginConnected = true;
    pluginSessionId = sessionId;
    if (extensionVersion === protocolVersion)
      scheduleSessionStatus(socket, sessionId, generation, connection);
  }

  function scheduleSessionStatus(
    socket: WebSocket,
    sessionId: string,
    generation: number,
    connection: import("@nexus-js/core").Connection<WebSocketAdapterModel<BrokerSocketFacts>>,
  ): void {
    if (!isCurrentSession(socket, sessionId, generation)) return;
    const timer = setTimeout(() => {
      if (sessionStatusTimer === timer) sessionStatusTimer = undefined;
      void checkSessionStatus(socket, sessionId, generation, connection);
    }, SESSION_STATUS_INTERVAL_MS);
    timer.unref();
    sessionStatusTimer = timer;
  }

  function isCurrentSession(socket: WebSocket, sessionId: string, generation: number): boolean {
    return (
      activeSocket === socket &&
      socket.readyState === socket.OPEN &&
      pluginSessionId === sessionId &&
      sessionGeneration === generation &&
      pluginConnected
    );
  }

  async function checkSessionStatus(
    socket: WebSocket,
    sessionId: string,
    generation: number,
    connection: import("@nexus-js/core").Connection<WebSocketAdapterModel<BrokerSocketFacts>>,
  ): Promise<void> {
    if (!isCurrentSession(socket, sessionId, generation)) return;
    try {
      if (
        connection.connectionMeta.role !== "server" ||
        connection.connectionMeta.pairingVerified !== true ||
        connection.connectionMeta.sessionId !== sessionId ||
        connection.status !== "connected" ||
        peerVersion(connection.contextMeta) !== protocolVersion
      ) {
        failSessionStatus(socket, sessionId, generation);
        return;
      }
      const acquired = connection.safeGet(backgroundControlToken, {
        callTimeout: SESSION_STATUS_CALL_TIMEOUT_MS,
      });
      if (acquired.isErr()) {
        failSessionStatus(socket, sessionId, generation);
        return;
      }
      const response = await Nexus.safeCall(acquired.value.getStatus());
      if (!isCurrentSession(socket, sessionId, generation)) return;
      if (response.isErr()) {
        failSessionStatus(socket, sessionId, generation);
        return;
      }
      const decoded = await controlStatusResultCodec.deserialize(response.value);
      if (!isCurrentSession(socket, sessionId, generation)) return;
      if (decoded.isErr() || decoded.value.connected !== true) {
        failSessionStatus(socket, sessionId, generation);
        return;
      }
      scheduleSessionStatus(socket, sessionId, generation, connection);
    } catch {
      if (isCurrentSession(socket, sessionId, generation))
        failSessionStatus(socket, sessionId, generation);
    }
  }

  function failSessionStatus(socket: WebSocket, sessionId: string, generation: number): void {
    if (!isCurrentSession(socket, sessionId, generation)) return;
    clearSession(socket);
    if (socket.readyState < socket.CLOSING) socket.terminate();
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
