import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Nexus } from "@nexus-js/core";
import { Result } from "better-result";
import type { Connection, Remote } from "@nexus-js/core";
import { usingNodeIpcClient } from "@nexus-js/node-ipc";
import type { NodeIpcAdapterModel } from "@nexus-js/node-ipc";
import { WebSocketClientEndpoint } from "@nexus-js/websocket";
import type { WebSocketClientEndpoint as WebSocketClientEndpointType } from "@nexus-js/websocket";
import {
  connectionToken,
  createPairingSubprotocols,
  workspaceToken,
  protocolVersion,
  cleanupWorkspaceResultCodec,
  listArticlesResultCodec,
  articleResultCodec,
  workspaceResultCodec,
  writeBodyResultCodec,
  connectionStatusResultCodec,
  type ConnectionService,
  type WorkspaceService,
} from "@mpctl/contracts";
import { cleanupBrokerResources, createBroker, type Broker } from "../src/server";
const fixtureHash = "0".repeat(64);

describe("broker relay integration", () => {
  test("attempts every broker cleanup operation and returns a typed cleanup failure", async () => {
    const attempted: string[] = [];
    const result = await cleanupBrokerResources({
      endpoint: () => {
        attempted.push("endpoint");
        throw new Error("endpoint close failed");
      },
      server: async () => {
        attempted.push("server");
      },
    });

    expect(attempted).toEqual(["endpoint", "server"]);
    expect(result).toEqual(Result.err({ code: "broker_close_failed" }));
  });

  test("preserves broker IPC when the plugin disconnects and reconnects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mpctl-relay-capability-"));
    const socketPath = join(directory, "broker.sock");
    const credential = "session-bound-pairing-secret";
    let broker: Broker | undefined;
    let endpointA: WebSocketClientEndpointType | undefined;
    let endpointB: WebSocketClientEndpointType | undefined;
    let ipcA: Nexus<NodeIpcAdapterModel> | undefined;
    let ipcB: Nexus<NodeIpcAdapterModel> | undefined;
    let connectionA: Connection<NodeIpcAdapterModel> | undefined;
    let connectionB: Connection<NodeIpcAdapterModel> | undefined;

    try {
      const created = await createBroker({
        ipcAddress: { kind: "path", path: socketPath },
        websocketPort: 0,
        pairingCredential: credential,
      });
      if (Result.isError(created)) throw new Error(created.error.code);
      broker = created.value;
      const addressResult = broker.address();
      if (Result.isError(addressResult)) throw new Error(addressResult.error.code);
      const address = addressResult.value;
      const pluginA = createPlugin("session-A", credential);
      endpointA = pluginA.endpoint;
      await pluginA.nexus.ready();
      await pluginA.nexus.connect({
        target: { context: "websocket-server", url: `ws://127.0.0.1:${address.port}/bridge` },
      });

      ipcA = createIpcClient(socketPath, "ipc-session-A");
      await ipcA.ready();
      connectionA = await connectBroker(ipcA);
      await waitForConnected(connectionA.get(connectionToken));
      const proxyA = connectionA.get(workspaceToken);
      expect(await workspaceResultCodec.deserialize(await proxyA.readBody("from-A"))).toEqual(
        Result.ok({ html: "session-A:from-A", bodyHash: fixtureHash }),
      );
      const delayedCallStart = performance.now();
      expect(
        await workspaceResultCodec.deserialize(await proxyA.readBody("takes-over-two-seconds")),
      ).toEqual(Result.ok({ html: "session-A:takes-over-two-seconds", bodyHash: fixtureHash }));
      expect(performance.now() - delayedCallStart).toBeGreaterThanOrEqual(2_500);
      const boundedProxyA = connectionA.get(workspaceToken, { callTimeout: 500 });
      await expect(
        Promise.resolve(boundedProxyA.readBody("takes-over-two-seconds")),
      ).rejects.toMatchObject({ code: "E_CALL_TIMEOUT" });

      expect(await broker.disconnectPlugin()).toEqual(Result.ok(undefined));
      expect(connectionA.status).toBe("connected");
      expect(
        await connectionStatusResultCodec.deserialize(
          await connectionA.get(connectionToken).getStatus(),
        ),
      ).toEqual(Result.ok({ connected: false, brokerVersion: protocolVersion }));
      await expect(Promise.resolve(proxyA.readBody("offline"))).rejects.toBeDefined();

      const pluginB = createPlugin("session-B", credential);
      endpointB = pluginB.endpoint;
      await pluginB.nexus.ready();
      await pluginB.nexus.connect({
        target: { context: "websocket-server", url: `ws://127.0.0.1:${address.port}/bridge` },
      });

      ipcB = createIpcClient(socketPath, "ipc-session-B");
      await ipcB.ready();
      connectionB = await connectBroker(ipcB);
      await waitForConnected(connectionB.get(connectionToken));
      const proxyB = connectionB.get(workspaceToken, { callTimeout: 1_000 });
      expect(await workspaceResultCodec.deserialize(await proxyB.readBody("from-B"))).toEqual(
        Result.ok({ html: "session-B:from-B", bodyHash: fixtureHash }),
      );
      expect(
        await writeBodyResultCodec.deserialize(
          await proxyB.writeBody("written-by-B", "<p>B</p>", fixtureHash),
        ),
      ).toEqual(Result.ok({ bodyHash: fixtureHash }));

      expect(connectionA.status).toBe("connected");
      expect(
        await workspaceResultCodec.deserialize(await proxyA.readBody("later-root-call")),
      ).toEqual(Result.ok({ html: "session-B:later-root-call", bodyHash: fixtureHash }));
      const replacement = connectionA.get(workspaceToken);
      expect(
        await workspaceResultCodec.deserialize(await replacement.readBody("same-ipc-new-plugin")),
      ).toEqual(Result.ok({ html: "session-B:same-ipc-new-plugin", bodyHash: fixtureHash }));
    } finally {
      endpointA?.close();
      endpointB?.close();
      connectionA?.disconnect();
      connectionB?.disconnect();
      if (broker) {
        const closed = await within(broker.close(), 2_000, "capability test broker shutdown");
        expect(closed).toEqual(Result.ok(undefined));
      }
      await within(
        rm(directory, { recursive: true, force: true }),
        2_000,
        "capability test cleanup",
      );
    }
  });

  test("keeps status local, authenticates one plugin, relays calls, and accepts explicit reconnect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mpctl-broker-test-"));
    const socketPath = join(directory, "broker.sock");
    const credential = "test-pairing-secret";
    let broker: Broker | undefined;
    let pluginEndpoint: WebSocketClientEndpointType | undefined;
    let plugin: Nexus | undefined;
    let ipc: Nexus<NodeIpcAdapterModel> | undefined;
    let activeConnection: Connection<NodeIpcAdapterModel> | undefined;

    try {
      const created = await createBroker({
        ipcAddress: { kind: "path", path: socketPath },
        websocketPort: 0,
        pairingCredential: credential,
      });
      if (Result.isError(created)) throw new Error(created.error.code);
      broker = created.value;
      const addressResult = broker.address();
      if (Result.isError(addressResult)) throw new Error(addressResult.error.code);
      const address = addressResult.value;
      ipc = new Nexus<NodeIpcAdapterModel>();
      ipc.configure(
        usingNodeIpcClient({
          appId: "mpctl-broker-test",
          resolveAddress: () => ({ kind: "path", path: socketPath }),
          configure: false,
        }),
      );
      await ipc.ready();
      activeConnection = await ipc.connect({
        target: { context: "node-ipc-daemon", appId: "mpctl", instance: "default" },
      });
      const status = activeConnection.get(connectionToken);
      expect(await connectionStatusResultCodec.deserialize(await status.getStatus())).toEqual(
        Result.ok({ connected: false, brokerVersion: protocolVersion }),
      );

      await expect(rejectedConnection(address.port, "wrong-secret")).resolves.toBe(true);
      expect(await connectionStatusResultCodec.deserialize(await status.getStatus())).toEqual(
        Result.ok({ connected: false, brokerVersion: protocolVersion }),
      );

      const workspace: WorkspaceService = {
        async currentArticle() {
          return encode(articleResultCodec, Result.err({ code: "target_unavailable" }));
        },
        async cleanupWorkspace() {
          return encode(
            cleanupWorkspaceResultCodec,
            Result.ok({ groupsRemoved: 0, tabsMoved: 0, groupsRemaining: 1 }),
          );
        },
        async listArticles() {
          return encode(
            listArticlesResultCodec,
            Result.ok([{ candidate: "first", title: "First" }]),
          );
        },
        async openArticle(candidate) {
          return encode(
            articleResultCodec,
            Result.ok({ article: candidate, title: "Opened", bodyHash: fixtureHash }),
          );
        },
        async newArticle() {
          return encode(
            articleResultCodec,
            Result.ok({ article: "new", title: "New", bodyHash: fixtureHash }),
          );
        },
        async readBody(article) {
          return encode(
            workspaceResultCodec,
            Result.ok({ html: `<p>${article}</p>`, bodyHash: fixtureHash }),
          );
        },
        async writeBody(_article, _html) {
          return encode(writeBodyResultCodec, Result.ok({ bodyHash: fixtureHash }));
        },
      };
      plugin = new Nexus();
      const protocols = createPairingSubprotocols(credential);
      if (Result.isError(protocols)) throw new Error("Invalid fixed test credential");
      pluginEndpoint = new WebSocketClientEndpoint({
        protocols: protocols.value,
      });
      plugin.configure({
        endpoint: { meta: { context: "websocket-client" }, implementation: pluginEndpoint },
        providers: [{ token: workspaceToken, service: workspace }],
      } as never);
      await plugin.ready();
      await plugin.connect({
        target: { context: "websocket-server", url: `ws://127.0.0.1:${address.port}/bridge` },
      });

      await waitForConnected(status);
      const firstSession = await connectionStatusResultCodec.deserialize(await status.getStatus());
      expect(Result.isOk(firstSession) && firstSession.value).toMatchObject({
        connected: true,
        sessionId: expect.any(String),
      });
      const workspaceRemote = activeConnection.get(workspaceToken, { callTimeout: 1_000 });
      expect(
        await workspaceResultCodec.deserialize(await workspaceRemote.readBody("article-7")),
      ).toEqual(Result.ok({ html: "<p>article-7</p>", bodyHash: fixtureHash }));
      expect(
        await writeBodyResultCodec.deserialize(
          await workspaceRemote.writeBody("article-7", "<p>UTF-8 文章</p>", fixtureHash),
        ),
      ).toEqual(Result.ok({ bodyHash: fixtureHash }));
      await expect(rejectedConnection(address.port, credential)).resolves.toBe(true);

      expect(await broker.disconnectPlugin()).toEqual(Result.ok(undefined));
      const disconnectedStatusClient = createIpcClient(socketPath, "mpctl-disconnected-status");
      await disconnectedStatusClient.ready();
      const disconnectedStatusConnection = await connectBroker(disconnectedStatusClient);
      expect(
        await connectionStatusResultCodec.deserialize(
          await disconnectedStatusConnection.get(connectionToken).getStatus(),
        ),
      ).toEqual(Result.ok({ connected: false, brokerVersion: protocolVersion }));
      pluginEndpoint.close();
      pluginEndpoint = new WebSocketClientEndpoint({
        protocols: valueOrThrow(createPairingSubprotocols(credential)),
      });
      plugin = new Nexus();
      plugin.configure({
        endpoint: { meta: { context: "websocket-client" }, implementation: pluginEndpoint },
        providers: [{ token: workspaceToken, service: workspace }],
      } as never);
      await plugin.ready();
      await plugin.connect({
        target: { context: "websocket-server", url: `ws://127.0.0.1:${address.port}/bridge` },
      });
      const reconnectClient = new Nexus<NodeIpcAdapterModel>();
      reconnectClient.configure(
        usingNodeIpcClient({
          appId: "mpctl-reconnect-test",
          resolveAddress: () => ({ kind: "path", path: socketPath }),
          configure: false,
        }),
      );
      await reconnectClient.ready();
      const reconnected = await reconnectClient.connect({
        target: { context: "node-ipc-daemon", appId: "mpctl", instance: "default" },
      });
      await waitForConnected(reconnected.get(connectionToken));
      const nextSession = await connectionStatusResultCodec.deserialize(
        await reconnected.get(connectionToken).getStatus(),
      );
      if (Result.isError(firstSession) || Result.isError(nextSession))
        throw new Error("status failed");
      expect(nextSession.value.sessionId).not.toBe(firstSession.value.sessionId);
      const reconnectedWorkspace = reconnected.get(workspaceToken, { callTimeout: 1_000 });
      expect(
        await workspaceResultCodec.deserialize(
          await reconnectedWorkspace.readBody("after-reconnect-read"),
        ),
      ).toEqual(Result.ok({ html: "<p>after-reconnect-read</p>", bodyHash: fixtureHash }));
      expect(
        await writeBodyResultCodec.deserialize(
          await reconnectedWorkspace.writeBody(
            "after-reconnect-write",
            "<p>重连后写入</p>",
            fixtureHash,
          ),
        ),
      ).toEqual(Result.ok({ bodyHash: fixtureHash }));
    } finally {
      pluginEndpoint?.close();
      activeConnection?.disconnect();
      if (broker) {
        const closed = await within(broker.close(), 2_000, "broker shutdown");
        expect(closed).toEqual(Result.ok(undefined));
      }
      await within(
        rm(directory, { recursive: true, force: true }),
        2_000,
        "temporary directory cleanup",
      );
    }
  });
});

async function rejectedConnection(port: number, credential: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = new globalThis.WebSocket(
      `ws://127.0.0.1:${port}/bridge`,
      valueOrThrow(createPairingSubprotocols(credential)),
    );
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket upgrade timed out"));
    }, 2_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        socket.close();
        reject(new Error("Connection unexpectedly upgraded"));
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      { once: true },
    );
  });
}

function createPlugin(
  label: string,
  credential: string,
): {
  nexus: Nexus;
  endpoint: WebSocketClientEndpointType;
} {
  const protocols = createPairingSubprotocols(credential);
  if (Result.isError(protocols)) throw new Error("Invalid static test credential");
  const endpoint = new WebSocketClientEndpoint({ protocols: protocols.value });
  const nexus = new Nexus();
  nexus.configure({
    endpoint: { meta: { context: "websocket-client" }, implementation: endpoint },
    providers: [
      {
        token: workspaceToken,
        service: {
          async currentArticle() {
            return encode(articleResultCodec, Result.err({ code: "target_unavailable" as const }));
          },
          async listArticles() {
            return encode(listArticlesResultCodec, Result.ok([]));
          },
          async openArticle(candidate: string) {
            return encode(
              articleResultCodec,
              Result.ok({ article: candidate, title: label, bodyHash: fixtureHash }),
            );
          },
          async newArticle() {
            return encode(
              articleResultCodec,
              Result.ok({ article: label, title: label, bodyHash: fixtureHash }),
            );
          },
          async readBody(article: string) {
            if (article === "takes-over-two-seconds") {
              await new Promise((resolve) => setTimeout(resolve, 2_500));
            }
            return encode(
              workspaceResultCodec,
              Result.ok({ html: `${label}:${article}`, bodyHash: fixtureHash }),
            );
          },
          async writeBody(_article: string, _html: string) {
            return encode(writeBodyResultCodec, Result.ok({ bodyHash: fixtureHash }));
          },
          async cleanupWorkspace() {
            return encode(
              cleanupWorkspaceResultCodec,
              Result.ok({ groupsRemoved: 0, tabsMoved: 0, groupsRemaining: 1 }),
            );
          },
        } satisfies WorkspaceService,
      },
    ],
  } as never);
  return { nexus, endpoint };
}

function createIpcClient(
  socketPath: string,
  appId: string,
  callTimeout = 5_000,
): Nexus<NodeIpcAdapterModel> {
  const nexus = new Nexus<NodeIpcAdapterModel>();
  nexus.configure(
    usingNodeIpcClient({
      appId,
      callTimeout,
      resolveAddress: () => ({ kind: "path", path: socketPath }),
      configure: false,
    }),
  );
  return nexus;
}

function connectBroker(
  nexus: Nexus<NodeIpcAdapterModel>,
): Promise<Connection<NodeIpcAdapterModel>> {
  return nexus.connect({
    target: { context: "node-ipc-daemon", appId: "mpctl", instance: "default" },
  });
}

async function waitForConnected(status: Remote<ConnectionService>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await status.getStatus();
    const decoded = await connectionStatusResultCodec.deserialize(result);
    if (Result.isOk(decoded) && decoded.value.connected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Plugin session did not become ready");
}

async function encode<T, E extends object>(
  codec: {
    serialize(
      result: import("better-result").Result<T, E | import("@mpctl/contracts").ResultProtocolError>,
    ): Promise<
      import("better-result").Result<
        import("better-result").SerializedResult<T, import("@mpctl/contracts").ServiceError<E>>,
        import("@mpctl/contracts").ResultProtocolError
      >
    >;
  },
  result: import("better-result").Result<T, E>,
) {
  const encoded = await codec.serialize(result);
  return Result.isError(encoded)
    ? { status: "error" as const, error: encoded.error }
    : encoded.value;
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function valueOrThrow<T, E>(result: import("better-result").Result<T, E>): T {
  if (Result.isError(result)) throw new Error("Invalid fixed test credential");
  return result.value;
}
