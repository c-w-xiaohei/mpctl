// The real extension controller is compiled here for reciprocal WS admission;
// Chrome is declared by the extension's existing dev dependency, not broker.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="../../extension/node_modules/@types/chrome/index.d.ts" />
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference lib="dom" />
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, test, spyOn } from "bun:test";
import { Nexus } from "@nexus-js/core";
import { Result } from "better-result";
import type { Connection, Remote } from "@nexus-js/core";
import { usingNodeIpcClient } from "@nexus-js/node-ipc";
import type { NodeIpcAdapterModel } from "@nexus-js/node-ipc";
import { WebSocketClientEndpoint } from "@nexus-js/websocket";
import type { WebSocketClientEndpoint as WebSocketClientEndpointType } from "@nexus-js/websocket";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { WebSocketServerEndpoint } from "@nexus-js/websocket/server";
import { createConnectionController } from "../../extension/src/connection";
import { spawn } from "node:child_process";
import { connectionConfig } from "@mpctl/contracts";
import { createServer as createHttpServer } from "node:http";
import {
  connectionToken,
  createPairingSubprotocols,
  workspaceToken,
  protocolVersion,
  cleanupWorkspaceResultCodec,
  listArticlesResultCodec,
  articleResultCodec,
  articleFieldsResultCodec,
  articleCheckResultCodec,
  assetListResultCodec,
  operationResultCodec,
  articleCoverResultCodec,
  workspaceResultCodec,
  connectionStatusResultCodec,
  backgroundControlToken,
  connectResultCodec,
  disconnectResultCodec,
  controlStatusResultCodec,
  reloadResultCodec,
  type ConnectionService,
  type WorkspaceService,
  type BackgroundControlService,
} from "@mpctl/contracts";
import { cleanupBrokerResources, createBroker, type Broker } from "../src/server";
const fixtureHash = "0".repeat(64);

describe("broker relay integration", () => {
  test.each(["held", "acquire", "missing", "error"] as const)(
    "R1 actual CLI %s optional status preserves diagnostics/original history and refuses fresh work",
    async (mode) => {
      const directory = await mkdtemp("/tmp/opencode/mpctl-integration-r1-status-");
      const previous = globalThis.WebSocket;
      globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
      const socket = join(directory, "broker.sock");
      const broker = valueOrThrow(
        await createBroker({
          ipcAddress: { kind: "path", path: socket },
          websocketPort: 0,
          pairingCredential: "secret",
        }),
      );
      const epoch = crypto.randomUUID();
      const originalId = `op:58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975:${crypto.randomUUID()}`;
      let healthy = true;
      let historyCalls = 0;
      let newCalls = 0;
      let held = 0;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      let reached = Promise.resolve();
      const arm = () => {
        reached = new Promise<void>((done) => {
          entered = done;
        });
      };
      const control: BackgroundControlService = {
        ...connectedControlService(),
        getStatus: async () => {
          if (!healthy && mode === "held") {
            held++;
            entered();
            await gate;
          }
          if (!healthy && mode === "error")
            return encode(controlStatusResultCodec, Result.err({ code: "status_failed" }));
          return encode(
            controlStatusResultCodec,
            Result.ok({
              connected: true,
              ...(healthy || mode === "held" ? { keyLedgerId: epoch } : {}),
            }),
          );
        },
      };
      const plugin = createPlugin("r1", "secret", control);
      const snapshot = {
        operationId: originalId,
        operation: "body" as const,
        state: "settled" as const,
        effect: { outcome: "confirmed" as const, bodyHash: "a".repeat(64) },
        result: { status: "ok" as const, value: {} },
      };
      const denied = async () => ({
        status: "error" as const,
        error: { code: "page_failed" as const },
      });
      const mutationDenied = async () => ({
        status: "error" as const,
        error: { failure: { code: "operation_unresolved" as const } },
      });
      plugin.nexus.provide(workspaceToken, {
        cleanupWorkspace: denied,
        listArticles: denied,
        openArticle: mutationDenied,
        currentArticle: denied,
        readBody: denied,
        writeBody: mutationDenied,
        inspectArticle: denied,
        updateArticleFields: mutationDenied,
        checkArticle: denied,
        resolveAsset: denied,
        listAssets: denied,
        uploadAsset: mutationDenied,
        readArticleCover: denied,
        setArticleCover: mutationDenied,
        saveArticle: mutationDenied,
        getOperation: async (id: string) => {
          expect(id).toBe(originalId);
          historyCalls++;
          return encode(operationResultCodec, Result.ok({ snapshot }));
        },
        newArticle: async () => {
          newCalls++;
          throw new Error("fresh write must not reach provider");
        },
      });
      const ipc = createIpcClient(socket, "r1-observer");
      let connection: Connection<NodeIpcAdapterModel> | undefined;
      let acquisition: ReturnType<typeof spyOn> | undefined;
      const acquiring: Promise<unknown>[] = [];
      const children = new Set<ReturnType<typeof spawn>>();
      const cli = async (args: string[]) => {
        const child = spawn("bun", ["run", "../cli/src/main.ts", ...args], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MPCTL_BROKER_SOCKET: socket,
            XDG_RUNTIME_DIR: directory,
            XDG_CONFIG_HOME: directory,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.add(child);
        let stdout = "",
          stderr = "";
        child.stdout!.on("data", (data) => (stdout += data));
        child.stderr!.on("data", (data) => (stderr += data));
        const exit = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        children.delete(child);
        return { exit, stdout, stderr };
      };
      const whileHeld = async (args: string[]) => {
        arm();
        const task = cli(args);
        if (mode === "held" || mode === "acquire") await reached;
        const result = await task;
        expect(newCalls).toBe(0);
        return result;
      };
      try {
        await plugin.nexus.ready();
        await plugin.nexus.connect({
          target: {
            context: "websocket-server",
            url: `ws://127.0.0.1:${valueOrThrow(broker.address()).port}/bridge`,
          },
        });
        await ipc.ready();
        connection = await connectBroker(ipc);
        const status = connection.get(connectionToken);
        await waitForConnected(status);
        expect(
          (await connectionStatusResultCodec.deserialize(await status.getStatus())).unwrap()
            .keyLedgerId,
        ).toBe(epoch);
        healthy = false;
        if (mode === "acquire") {
          const real = Nexus.prototype.safeConnect;
          acquisition = spyOn(Nexus.prototype, "safeConnect").mockImplementation(
            function (this: Nexus, options) {
              // Delay only optional broker acquisition; actual IPC/WS is still used
              // after release. This tests the total envelope before RPC even starts.
              if (
                !healthy &&
                options?.where &&
                options.signal &&
                options.timeout === 750 &&
                !options.target
              ) {
                held++;
                entered();
                const task = gate.then(() => real.call(this, options));
                acquiring.push(task);
                return task;
              }
              return real.call(this, options);
            },
          );
        }
        const diagnostic = await whileHeld(["status", "--details"]);
        const history = await whileHeld(["operation", "status", originalId]);
        const fresh = await whileHeld(["article", "new"]);
        // Original control barrier is still held through all actual CLI exits.
        console.log("R1 optional status", {
          mode,
          diagnostic,
          history,
          fresh,
          held,
          historyCalls,
          newCalls,
        });
        expect(diagnostic.exit).toBe(0);
        expect(JSON.parse(diagnostic.stdout)).toMatchObject({
          connected: true,
          brokerVersion: protocolVersion,
          extensionVersion: protocolVersion,
        });
        expect(history.exit).toBe(0);
        expect(JSON.parse(history.stdout).snapshot).toEqual(snapshot);
        expect(historyCalls).toBe(1);
        expect(fresh.exit).toBe(1);
        expect(JSON.parse(fresh.stderr.trim()).error.code).toBe("storage_failed");
        expect(newCalls).toBe(0);
        arm();
        const raw = connectionStatusResultCodec.deserialize(await status.getStatus());
        const fallback = (await raw).unwrap();
        expect(fallback.connected).toBe(true);
        expect(fallback.keyLedgerId).toBeUndefined();
        release();
        healthy = true;
        await Promise.all(acquiring);
        expect(
          (await connectionStatusResultCodec.deserialize(await status.getStatus())).unwrap()
            .keyLedgerId,
        ).toBe(epoch);
        const same = await cli(["operation", "status", originalId]);
        expect(same.exit).toBe(0);
        expect(JSON.parse(same.stdout).snapshot).toEqual(snapshot);
        expect(historyCalls).toBe(2);
        expect(newCalls).toBe(0);
        await broker.disconnectPlugin();
        const missing = (
          await connectionStatusResultCodec.deserialize(await status.getStatus())
        ).unwrap();
        expect(missing.connected).toBe(false);
        expect(missing.keyLedgerId).toBeUndefined();
      } finally {
        release();
        await Promise.all(acquiring);
        acquisition?.mockRestore();
        for (const child of children) {
          const done = new Promise<void>((resolve) => child.once("close", () => resolve()));
          child.kill("SIGTERM");
          await done;
        }
        connection?.disconnect();
        plugin.endpoint.close();
        await broker.close();
        globalThis.WebSocket = previous;
        await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
  test("F2 delayed old-session status cannot publish its epoch into the successor session", async () => {
    const directory = await mkdtemp("/tmp/opencode/mpctl-integration-correction-stale-");
    const previous = globalThis.WebSocket;
    globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
    const socket = join(directory, "broker.sock");
    const ledger = "58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975";
    const broker = valueOrThrow(
      await createBroker({
        ipcAddress: { kind: "path", path: socket },
        websocketPort: 0,
        pairingCredential: "secret",
      }),
    );
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const reached = new Promise<void>((done) => {
      entered = done;
    });
    let oldCalls = 0;
    const oldEpoch = crypto.randomUUID(),
      nextEpoch = crypto.randomUUID();
    const first = createPlugin(
      "old-status",
      "secret",
      {
        ...connectedControlService(),
        getStatus: async () => {
          oldCalls++;
          entered();
          await gate;
          return encode(
            controlStatusResultCodec,
            Result.ok({ connected: true, keyLedgerId: oldEpoch }),
          );
        },
      },
      { protocolVersion, ledgerId: ledger },
    );
    const next = createPlugin(
      "next-status",
      "secret",
      {
        ...connectedControlService(),
        getStatus: async () =>
          encode(controlStatusResultCodec, Result.ok({ connected: true, keyLedgerId: nextEpoch })),
      },
      { protocolVersion, ledgerId: ledger },
    );
    const ipc = createIpcClient(socket, "stale-status");
    let connection: Connection<NodeIpcAdapterModel> | undefined;
    try {
      const target = {
        context: "websocket-server" as const,
        url: `ws://127.0.0.1:${valueOrThrow(broker.address()).port}/bridge`,
      };
      await first.nexus.ready();
      await first.nexus.connect({ target });
      await ipc.ready();
      connection = await connectBroker(ipc);
      const delayed = connection.get(connectionToken).getStatus();
      const waiting = Nexus.safeCall(delayed);
      await reached;
      // Revoke the first admitted socket while its original status waits.
      first.endpoint.close();
      await waitForCondition(
        async () => {
          const decoded = await connectionStatusResultCodec.deserialize(
            await connection!.get(connectionToken).getStatus(),
          );
          return decoded.isOk() && !decoded.value.connected;
        },
        2_000,
        "old session closed",
      );
      await next.nexus.ready();
      await next.nexus.connect({ target });
      await waitForCondition(
        async () => {
          const decoded = await connectionStatusResultCodec.deserialize(
            await connection!.get(connectionToken).getStatus(),
          );
          return decoded.isOk() && decoded.value.keyLedgerId === nextEpoch;
        },
        2_000,
        "successor epoch published",
      );
      release();
      await waiting;
      const current = (
        await connectionStatusResultCodec.deserialize(
          await connection.get(connectionToken).getStatus(),
        )
      ).unwrap();
      expect(current.keyLedgerId).toBe(nextEpoch);
      expect(oldCalls).toBe(1);
    } finally {
      release();
      connection?.disconnect();
      first.endpoint.close();
      next.endpoint.close();
      await broker.close();
      globalThis.WebSocket = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
  test.each(["0.11.0", protocolVersion])(
    "G1 actual extension dial to broker %s cannot publish a current workspace to an old reader",
    async (version) => {
      const previous = globalThis.WebSocket;
      globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
      const endpoint = new WebSocketServerEndpoint();
      const http = createHttpServer();
      const tcp = new Set<import("node:net").Socket>();
      http.on("connection", (socket) => {
        tcp.add(socket);
      });
      const server = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) =>
          protocols.has(connectionConfig.selectedSubprotocol)
            ? connectionConfig.selectedSubprotocol
            : false,
      });
      const upgraded = new Set<import("node:stream").Duplex>();
      http.on("upgrade", (request, socket, head) => {
        upgraded.add(socket);
        server.handleUpgrade(request, socket, head, (ws) => server.emit("connection", ws, request));
      });
      const sockets = new Set<NodeWebSocket>();
      const nexus = new Nexus<import("@nexus-js/websocket").WebSocketAdapterModel>();
      nexus.configure({
        endpoint: {
          implementation: endpoint,
          meta: { context: "websocket-server", app: { protocolVersion: version } },
        },
      });
      let reads = 0;
      let writes = 0;
      let connected!: (value: import("@nexus-js/core").Connection) => void;
      const accepted = new Promise<import("@nexus-js/core").Connection>((done) => {
        connected = done;
      });
      nexus.onConnect(connected);
      server.on("connection", (socket) => {
        sockets.add(socket);
        endpoint.attach(socket, {});
      });
      const denied = async () => ({
        status: "error" as const,
        error: { code: "page_failed" as const },
      });
      const operationDenied = async () => ({
        status: "error" as const,
        error: { failure: { code: "operation_unresolved" as const } },
      });
      const workspace: WorkspaceService = {
        cleanupWorkspace: denied,
        listArticles: denied,
        currentArticle: denied,
        openArticle: operationDenied,
        newArticle: operationDenied,
        readBody: async () => {
          reads++;
          return { status: "ok", value: { html: "", bodyHash: fixtureHash } };
        },
        writeBody: async () => {
          writes++;
          return operationDenied();
        },
        getOperation: operationDenied,
        inspectArticle: denied,
        checkArticle: denied,
        updateArticleFields: operationDenied,
        resolveAsset: denied,
        listAssets: denied,
        uploadAsset: operationDenied,
        readArticleCover: denied,
        setArticleCover: operationDenied,
        saveArticle: operationDenied,
      };
      const controller = createConnectionController({
        ledger: Promise.resolve(Result.ok({ ledgerId: crypto.randomUUID() })),
        workspace,
      });
      try {
        await nexus.ready();
        await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
        const address = http.address();
        if (!address || typeof address === "string") throw new Error("server address unavailable");
        const result = await controller.connect("secret", `ws://127.0.0.1:${address.port}`);
        if (version !== protocolVersion) expect(result.isErr()).toBe(true);
        else {
          expect(result.isOk()).toBe(true);
          const connection = await accepted;
          const remote = connection.get(workspaceToken);
          expect((await Nexus.safeCall(remote.readBody("ref"))).isOk()).toBe(true);
          expect((await Nexus.safeCall(remote.writeBody(bodyInput("ref", "once")))).isOk()).toBe(
            true,
          );
        }
        expect({ reads, writes }).toEqual({
          reads: version === protocolVersion ? 1 : 0,
          writes: version === protocolVersion ? 1 : 0,
        });
      } finally {
        controller.disconnect();
        endpoint.close();
        for (const socket of sockets) socket.terminate();
        // Endpoint owns socket listeners; release the host's inventory explicitly
        // after termination rather than waiting on a removed host close listener.
        server.clients.clear();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of tcp) socket.destroy();
        for (const socket of upgraded) socket.destroy();
        http.closeAllConnections();
        if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
        globalThis.WebSocket = previous;
      }
    },
  );
  test("G1 exact current reader/writer only; identity downgrade revokes cached real IPC Relay", async () => {
    const directory = await mkdtemp("/tmp/opencode/mpctl-t6-protocol-");
    const previous = globalThis.WebSocket;
    globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
    const socket = join(directory, "broker.sock");
    const broker = valueOrThrow(
      await createBroker({
        ipcAddress: { kind: "path", path: socket },
        websocketPort: 0,
        pairingCredential: "secret",
      }),
    );
    let writes = 0;
    const plugin = createPlugin(
      "t6",
      "secret",
      undefined,
      { protocolVersion, ledgerId: "58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975" },
      () => {
        writes++;
      },
    );
    const ipc = createIpcClient(socket, "t6-current");
    let connection: Connection<NodeIpcAdapterModel> | undefined;
    try {
      await plugin.nexus.ready();
      await plugin.nexus.connect({
        target: {
          context: "websocket-server",
          url: `ws://127.0.0.1:${valueOrThrow(broker.address()).port}/bridge`,
        },
      });
      await ipc.ready();
      connection = await connectBroker(ipc);
      await waitForConnected(connection.get(connectionToken));
      const workspace = connection.get(workspaceToken);
      expect((await Nexus.safeCall(workspace.readBody("ref"))).isOk()).toBe(true);
      expect((await Nexus.safeCall(workspace.writeBody(bodyInput("ref", "once")))).isOk()).toBe(
        true,
      );
      await ipc.updateIdentity({ app: { protocolVersion: "0.11.0" } });
      expect((await Nexus.safeCall(workspace.readBody("ref"))).isErr()).toBe(true);
      expect((await Nexus.safeCall(workspace.writeBody(bodyInput("ref", "twice")))).isErr()).toBe(
        true,
      );
      expect(writes).toBe(1);
      // Old clients retain diagnostics, not read/mutation capability.
      expect((await Nexus.safeCall(connection.get(connectionToken).getStatus())).isOk()).toBe(true);
    } finally {
      connection?.disconnect();
      plugin.endpoint.close();
      await broker.close();
      globalThis.WebSocket = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("G1 exact-version peer without ledger metadata has no usable workspace Relay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mpctl-no-ledger-"));
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
    const broker = valueOrThrow(
      await createBroker({
        ipcAddress: { kind: "path", path: join(directory, "broker.sock") },
        websocketPort: 0,
        pairingCredential: "secret",
      }),
    );
    const plugin = createPlugin("no-ledger", "secret", undefined, { protocolVersion });
    try {
      await plugin.nexus.ready();
      const connected = await plugin.nexus.safeConnect({
        target: {
          context: "websocket-server",
          url: `ws://127.0.0.1:${valueOrThrow(broker.address()).port}/bridge`,
        },
        timeout: 500,
      });
      expect(connected.isErr()).toBe(true);
    } finally {
      plugin.endpoint.close();
      await broker.close();
      globalThis.WebSocket = previousWebSocket;
      await rm(directory, { recursive: true, force: true });
    }
  });
  test.each([undefined, "", "0.9.0", "0.11.0", protocolVersion])(
    "W2 broker admits exact peer version %s only",
    async (version) => {
      const directory = await mkdtemp(join(tmpdir(), "mpctl-w2-version-"));
      const previousWebSocket = globalThis.WebSocket;
      globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
      const socketPath = join(directory, "broker.sock");
      const broker = valueOrThrow(
        await createBroker({
          ipcAddress: { kind: "path", path: socketPath },
          websocketPort: 0,
          pairingCredential: "w2-secret",
        }),
      );
      const plugin = createPlugin(
        "w2",
        "w2-secret",
        {
          ...connectedControlService(),
          async connect() {
            controlCalls++;
            return encode(connectResultCodec, Result.ok({ connected: true }));
          },
        },
        version === undefined
          ? {}
          : { protocolVersion: version, ledgerId: "58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975" },
        () => {
          mutations++;
        },
      );
      let mutations = 0;
      let controlCalls = 0;
      let connection: Connection<NodeIpcAdapterModel> | undefined;
      try {
        await plugin.nexus.ready();
        await plugin.nexus.safeConnect({
          target: {
            context: "websocket-server",
            url: `ws://127.0.0.1:${valueOrThrow(broker.address()).port}/bridge`,
          },
          timeout: 500,
        });
        const ipc = createIpcClient(socketPath, "w2-ipc");
        await ipc.ready();
        connection = await connectBroker(ipc);
        if (version === protocolVersion) await waitForConnected(connection.get(connectionToken));
        else await new Promise((resolve) => setTimeout(resolve, 50));
        const status = await connectionStatusResultCodec.deserialize(
          await connection.get(connectionToken).getStatus(),
        );
        expect(Result.isOk(status) && status.value.connected).toBe(version === protocolVersion);
        const workspace = connection.safeGet(workspaceToken);
        const control = connection.safeGet(backgroundControlToken);
        if (workspace.isOk())
          expect(
            (await Nexus.safeCall(workspace.value.writeBody(bodyInput("ref", "once")))).isOk(),
          ).toBe(version === protocolVersion);
        if (control.isOk())
          expect((await Nexus.safeCall(control.value.connect())).isOk()).toBe(
            version === protocolVersion,
          );
        if (version !== protocolVersion) {
          expect(workspace.isErr()).toBe(true);
          expect(control.isErr()).toBe(true);
        }
        expect(mutations).toBe(version === protocolVersion ? 1 : 0);
        expect(controlCalls).toBe(version === protocolVersion ? 1 : 0);
      } finally {
        plugin.endpoint.close();
        connection?.disconnect();
        expect(await broker.close()).toEqual(Result.ok(undefined));
        globalThis.WebSocket = previousWebSocket;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("W2 identity invalidation revokes cached Relay and cannot close a successor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mpctl-w2-cached-"));
    const socketPath = join(directory, "broker.sock");
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
    const broker = valueOrThrow(
      await createBroker({
        ipcAddress: { kind: "path", path: socketPath },
        websocketPort: 0,
        pairingCredential: "cached-secret",
      }),
    );
    let firstMutations = 0;
    let successorMutations = 0;
    const first = createPlugin(
      "first",
      "cached-secret",
      undefined,
      { protocolVersion, ledgerId: "58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975" },
      () => {
        firstMutations++;
      },
    );
    const successor = createPlugin(
      "successor",
      "cached-secret",
      undefined,
      { protocolVersion, ledgerId: "58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975" },
      () => {
        successorMutations++;
      },
    );
    let connection: Connection<NodeIpcAdapterModel> | undefined;
    const url = `ws://127.0.0.1:${valueOrThrow(broker.address()).port}/bridge`;
    try {
      await first.nexus.ready();
      await first.nexus.connect({ target: { context: "websocket-server", url } });
      const ipc = createIpcClient(socketPath, "cached-ipc");
      await ipc.ready();
      connection = await connectBroker(ipc);
      await waitForConnected(connection.get(connectionToken));
      const cached = connection.get(workspaceToken);
      expect((await Nexus.safeCall(cached.writeBody(bodyInput("ref", "html")))).isOk()).toBe(true);
      await first.nexus.updateIdentity({ app: { protocolVersion: "0.9.0" } });
      await waitForCondition(
        async () => {
          const status = await connectionStatusResultCodec.deserialize(
            await connection!.get(connectionToken).getStatus(),
          );
          return Result.isOk(status) && !status.value.connected;
        },
        1000,
        "invalid peer revoked",
      );
      expect((await Nexus.safeCall(cached.writeBody(bodyInput("ref", "again")))).isErr()).toBe(
        true,
      );
      expect(firstMutations).toBe(1);
      await successor.nexus.ready();
      await successor.nexus.connect({ target: { context: "websocket-server", url } });
      await waitForConnected(connection.get(connectionToken));
      first.endpoint.close();
      expect(
        await workspaceResultCodec.deserialize(
          await connection.get(workspaceToken).readBody("ref"),
        ),
      ).toEqual(Result.ok({ html: "successor:ref", bodyHash: fixtureHash }));
      expect(
        (
          await Nexus.safeCall(
            connection.get(workspaceToken).writeBody(bodyInput("ref", "successor-once")),
          )
        ).isOk(),
      ).toBe(true);
      expect({ firstMutations, successorMutations }).toEqual({
        firstMutations: 1,
        successorMutations: 1,
      });
    } finally {
      first.endpoint.close();
      successor.endpoint.close();
      connection?.disconnect();
      expect(await broker.close()).toEqual(Result.ok(undefined));
      globalThis.WebSocket = previousWebSocket;
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("sends one typed status RPC on the authenticated session and disconnects on a false reply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mpctl-broker-heartbeat-"));
    const socketPath = join(directory, "broker.sock");
    const credential = "heartbeat-test-pairing-secret";
    let broker: Broker | undefined;
    let pluginEndpoint: WebSocketClientEndpointType | undefined;
    let ipc: Nexus<NodeIpcAdapterModel> | undefined;
    let connection: Connection<NodeIpcAdapterModel> | undefined;
    let statusCalls = 0;
    let mode: "connected" | "disconnected" = "connected";
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
    try {
      const created = await createBroker({
        ipcAddress: { kind: "path", path: socketPath },
        websocketPort: 0,
        pairingCredential: credential,
      });
      if (Result.isError(created)) throw new Error(created.error.code);
      broker = created.value;
      const address = valueOrThrow(broker.address());
      const control: BackgroundControlService = {
        async connect() {
          return encode(connectResultCodec, Result.ok({ connected: true }));
        },
        requestConnect: async () => ({ status: "ok" as const, value: undefined }),
        async disconnect() {
          return encode(disconnectResultCodec, Result.ok({ connected: false as const }));
        },
        async getStatus() {
          statusCalls++;
          return mode === "connected"
            ? encode(controlStatusResultCodec, Result.ok({ connected: true }))
            : encode(controlStatusResultCodec, Result.ok({ connected: false }));
        },
        async reload() {
          return encode(reloadResultCodec, Result.ok(undefined));
        },
      };
      const plugin = createPlugin("heartbeat-session", credential, control);
      pluginEndpoint = plugin.endpoint;
      await plugin.nexus.ready();
      const pluginConnection = await plugin.nexus.connect({
        target: { context: "websocket-server", url: `ws://127.0.0.1:${address.port}/bridge` },
      });
      const closed = new Promise<void>((resolve) =>
        pluginConnection.onDisconnected(() => resolve()),
      );
      ipc = createIpcClient(socketPath, "heartbeat-ipc");
      await ipc.ready();
      connection = await connectBroker(ipc);
      const activeConnection = connection;
      await waitForConnected(activeConnection.get(connectionToken));
      expect(statusCalls).toBe(1); // Existing IPC status now reads the committed namespace.
      await waitForCondition(() => statusCalls === 2, 22_500, "one session status heartbeat");
      expect(statusCalls).toBe(2);
      expect(
        await connectionStatusResultCodec.deserialize(
          await activeConnection.get(connectionToken).getStatus(),
        ),
      ).toMatchObject({ status: "ok", value: { connected: true } });

      mode = "disconnected";
      await within(closed, 22_500, "typed false heartbeat closes the plugin session");
      expect(statusCalls).toBe(4);
      const closedAt = statusCalls;
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(statusCalls).toBe(closedAt);
      expect(pluginEndpoint).toBeDefined();
      expect(activeConnection.status).toBe("connected");
      expect(
        await connectionStatusResultCodec.deserialize(
          await activeConnection.get(connectionToken).getStatus(),
        ),
      ).toEqual(Result.ok({ connected: false, brokerVersion: protocolVersion }));
    } finally {
      globalThis.WebSocket = previousWebSocket;
      pluginEndpoint?.close();
      connection?.disconnect();
      if (broker) expect(await broker.close()).toEqual(Result.ok(undefined));
      await rm(directory, { recursive: true, force: true });
    }
  }, 50_000);

  test("does not let a delayed status reply from a replaced session disconnect its successor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mpctl-broker-stale-heartbeat-"));
    const socketPath = join(directory, "broker.sock");
    const credential = "stale-heartbeat-pairing-secret";
    let broker: Broker | undefined;
    let endpointA: WebSocketClientEndpointType | undefined;
    let endpointB: WebSocketClientEndpointType | undefined;
    let connection: Connection<NodeIpcAdapterModel> | undefined;
    let releaseOldStatus!: () => void;
    let markOldStatusStarted!: () => void;
    const oldStatusStarted = new Promise<void>((resolve) => (markOldStatusStarted = resolve));
    const oldStatusResult = new Promise<void>((resolve) => (releaseOldStatus = resolve));
    let oldStatusCalls = 0;
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
    try {
      const created = await createBroker({
        ipcAddress: { kind: "path", path: socketPath },
        websocketPort: 0,
        pairingCredential: credential,
      });
      if (Result.isError(created)) throw new Error(created.error.code);
      broker = created.value;
      const address = valueOrThrow(broker.address());
      const oldControl = connectedControlService(async () => {
        oldStatusCalls++;
        markOldStatusStarted();
        await oldStatusResult;
        return true;
      });
      const pluginA = createPlugin("old-status-session", credential, oldControl);
      endpointA = pluginA.endpoint;
      await pluginA.nexus.ready();
      await pluginA.nexus.connect({
        target: { context: "websocket-server", url: `ws://127.0.0.1:${address.port}/bridge` },
      });
      const ipc = createIpcClient(socketPath, "stale-heartbeat-ipc");
      await ipc.ready();
      connection = await connectBroker(ipc);
      const activeConnection = connection;
      await waitForConnected(activeConnection.get(connectionToken));
      await within(oldStatusStarted, 22_500, "old-session status call start");
      expect(oldStatusCalls).toBe(1);

      expect(await broker.disconnectPlugin()).toEqual(Result.ok(undefined));
      endpointA.close();
      const pluginB = createPlugin("replacement-status-session", credential);
      endpointB = pluginB.endpoint;
      await pluginB.nexus.ready();
      await pluginB.nexus.connect({
        target: { context: "websocket-server", url: `ws://127.0.0.1:${address.port}/bridge` },
      });
      await waitForConnected(activeConnection.get(connectionToken));
      releaseOldStatus();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(oldStatusCalls).toBe(1);
      expect(
        await connectionStatusResultCodec.deserialize(
          await activeConnection.get(connectionToken).getStatus(),
        ),
      ).toMatchObject({
        status: "ok",
        value: { connected: true, extensionVersion: protocolVersion },
      });
      expect(
        await workspaceResultCodec.deserialize(
          await activeConnection.get(workspaceToken).readBody("replacement-still-relays"),
        ),
      ).toEqual(
        Result.ok({
          html: "replacement-status-session:replacement-still-relays",
          bodyHash: fixtureHash,
        }),
      );
    } finally {
      globalThis.WebSocket = previousWebSocket;
      releaseOldStatus?.();
      endpointA?.close();
      endpointB?.close();
      connection?.disconnect();
      if (broker) expect(await broker.close()).toEqual(Result.ok(undefined));
      await rm(directory, { recursive: true, force: true });
    }
  }, 35_000);

  test("ends the current session after a status RPC transport failure without reconnecting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mpctl-broker-failed-heartbeat-"));
    const socketPath = join(directory, "broker.sock");
    const credential = "failed-heartbeat-pairing-secret";
    let broker: Broker | undefined;
    let pluginEndpoint: WebSocketClientEndpointType | undefined;
    let connection: Connection<NodeIpcAdapterModel> | undefined;
    let statusCalls = 0;
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
    try {
      const created = await createBroker({
        ipcAddress: { kind: "path", path: socketPath },
        websocketPort: 0,
        pairingCredential: credential,
      });
      if (Result.isError(created)) throw new Error(created.error.code);
      broker = created.value;
      const address = valueOrThrow(broker.address());
      const control = connectedControlService(async () => {
        statusCalls++;
        throw new Error("isolated status endpoint failure");
      });
      const plugin = createPlugin("failed-status-session", credential, control);
      pluginEndpoint = plugin.endpoint;
      await plugin.nexus.ready();
      const pluginConnection = await plugin.nexus.connect({
        target: { context: "websocket-server", url: `ws://127.0.0.1:${address.port}/bridge` },
      });
      const closed = new Promise<void>((resolve) =>
        pluginConnection.onDisconnected(() => resolve()),
      );
      const ipc = createIpcClient(socketPath, "failed-heartbeat-ipc");
      await ipc.ready();
      connection = await connectBroker(ipc);
      const activeConnection = connection;
      await waitForConnected(activeConnection.get(connectionToken));
      await within(closed, 22_500, "transport heartbeat error closes the existing session");
      expect(statusCalls).toBe(2);
      expect(
        await connectionStatusResultCodec.deserialize(
          await activeConnection.get(connectionToken).getStatus(),
        ),
      ).toEqual(Result.ok({ connected: false, brokerVersion: protocolVersion }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(statusCalls).toBe(2);
    } finally {
      globalThis.WebSocket = previousWebSocket;
      pluginEndpoint?.close();
      connection?.disconnect();
      if (broker) expect(await broker.close()).toEqual(Result.ok(undefined));
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

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
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;

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
        await operationResultCodec.deserialize(
          await proxyB.writeBody(bodyInput("written-by-B", "<p>B</p>")),
        ),
      ).toMatchObject(
        Result.ok({
          snapshot: { state: "settled", effect: { outcome: "confirmed", bodyHash: fixtureHash } },
        }),
      );

      expect(connectionA.status).toBe("connected");
      expect(
        await workspaceResultCodec.deserialize(await proxyA.readBody("later-root-call")),
      ).toEqual(Result.ok({ html: "session-B:later-root-call", bodyHash: fixtureHash }));
      const replacement = connectionA.get(workspaceToken);
      expect(
        await workspaceResultCodec.deserialize(await replacement.readBody("same-ipc-new-plugin")),
      ).toEqual(Result.ok({ html: "session-B:same-ipc-new-plugin", bodyHash: fixtureHash }));
    } finally {
      globalThis.WebSocket = previousWebSocket;
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
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;

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
      ipc.configure({
        endpoint: {
          meta: {
            context: "node-ipc-client",
            appId: "mpctl-broker-test",
            pid: process.pid,
            app: { protocolVersion },
          },
        },
      });
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

      let releaseImageEcho!: () => void;
      const imageEchoGate = new Promise<void>((resolve) => {
        releaseImageEcho = resolve;
      });
      let markImageEchoStarted!: () => void;
      let receivedUploadHash = "";
      const imageEchoStarted = new Promise<void>((resolve) => {
        markImageEchoStarted = resolve;
      });
      const workspace = {
        async currentArticle() {
          return encode(articleResultCodec, Result.err({ code: "target_unavailable" }));
        },
        async inspectArticle() {
          return encode(
            articleFieldsResultCodec,
            Result.ok({ title: "title", author: "", summary: "", fieldsHash: fixtureHash }),
          );
        },
        async updateArticleFields() {
          return encode(operationResultCodec, Result.err({ failure: { code: "unsupported" } }));
        },
        async checkArticle() {
          return encode(articleCheckResultCodec, Result.ok({ errors: [], warnings: [] }));
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
        async openArticle(input) {
          return encode(
            operationResultCodec,
            Result.ok({
              snapshot: {
                operationId: input.operationId,
                operation: "open",
                state: "settled",
                effect: {
                  navigation: true,
                  outcome: "confirmed",
                  pageCreated: true,
                  auxiliaryCreated: [],
                  targetBound: true,
                  bodyHash: fixtureHash,
                },
                result: { status: "ok", value: {} },
              },
            }),
          );
        },
        async newArticle(input) {
          return encode(
            operationResultCodec,
            Result.ok({
              snapshot: {
                operationId: input.operationId,
                operation: "new",
                state: "settled",
                effect: {
                  navigation: true,
                  outcome: "confirmed",
                  pageCreated: true,
                  auxiliaryCreated: [],
                  targetBound: true,
                  bodyHash: fixtureHash,
                },
                result: { status: "ok", value: {} },
              },
            }),
          );
        },
        async readBody(article) {
          return encode(
            workspaceResultCodec,
            Result.ok({ html: `<p>${article}</p>`, bodyHash: fixtureHash }),
          );
        },
        async writeBody(input) {
          return encode(operationResultCodec, bodyReply(input.operationId));
        },
        getOperation: async () => ({
          status: "error" as const,
          error: { failure: { code: "operation_not_found" as const } },
        }),
        resolveAsset: async () => ({
          status: "error" as const,
          error: { code: "page_failed" as const },
        }),
        async listAssets() {
          return encode(assetListResultCodec, Result.ok({ scope: "visible-page", cards: [] }));
        },
        async uploadAsset(payload) {
          receivedUploadHash = createHash("sha256")
            .update(new Uint8Array(await payload.blob.arrayBuffer()))
            .digest("hex");
          return encode(
            operationResultCodec,
            Result.ok({
              snapshot: {
                operationId: payload.operationId,
                operation: "upload",
                state: "settled",
                effect: {
                  outcome: "confirmed",
                  filename: payload.filename,
                  thumbnailUrl: "https://mmbiz.qpic.cn/test/300",
                },
                result: { status: "ok", value: {} },
              },
            }),
          );
        },
        async readArticleCover() {
          return encode(articleCoverResultCodec, Result.ok({ coverHash: fixtureHash }));
        },
        async setArticleCover(input) {
          return encode(
            operationResultCodec,
            Result.ok({
              snapshot: {
                operationId: input.operationId,
                operation: "cover",
                state: "settled",
                effect: { cover: true, outcome: "confirmed", coverHash: fixtureHash },
                result: { status: "ok", value: {} },
              },
            }),
          );
        },
        async saveArticle() {
          return encode(operationResultCodec, Result.err({ failure: { code: "unsupported" } }));
        },
        async echoBinary(payload: { blob: Blob; bytes: Uint8Array; nested: { blob: Blob } }) {
          return payload;
        },
        async echoImage(payload: { blob: Blob; filename: string }) {
          markImageEchoStarted();
          await imageEchoGate;
          return payload;
        },
      } satisfies WorkspaceService & {
        echoBinary(payload: {
          blob: Blob;
          bytes: Uint8Array;
          nested: { blob: Blob };
        }): Promise<{ blob: Blob; bytes: Uint8Array; nested: { blob: Blob } }>;
        echoImage(payload: {
          blob: Blob;
          filename: string;
        }): Promise<{ blob: Blob; filename: string }>;
      };
      plugin = new Nexus();
      const protocols = createPairingSubprotocols(credential);
      if (Result.isError(protocols)) throw new Error("Invalid fixed test credential");
      pluginEndpoint = new WebSocketClientEndpoint({
        protocols: protocols.value,
      });
      plugin.configure({
        endpoint: {
          meta: {
            context: "websocket-client",
            app: { protocolVersion, ledgerId: "58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975" },
          },
          implementation: pluginEndpoint,
        },
        providers: [
          { token: workspaceToken, service: workspace },
          { token: backgroundControlToken, service: connectedControlService() },
        ],
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
        await operationResultCodec.deserialize(
          await workspaceRemote.writeBody(bodyInput("article-7", "<p>UTF-8 文章</p>")),
        ),
      ).toMatchObject(
        Result.ok({
          snapshot: { state: "settled", effect: { outcome: "confirmed", bodyHash: fixtureHash } },
        }),
      );
      const uploadRemote = activeConnection.get(workspaceToken, { callTimeout: 10_000 });
      const uploadBytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 251);
      const uploadHash = createHash("sha256").update(uploadBytes).digest("hex");
      const uploadId = `op:${crypto.randomUUID()}:${crypto.randomUUID()}`;
      const uploaded = await uploadRemote.uploadAsset({
        article: "article-7",
        operationId: uploadId,
        blob: new Blob([uploadBytes], { type: "image/png" }),
        filename: "real-asset-fixture.png",
        mimeType: "image/png",
      });
      const uploadedResult = await operationResultCodec.deserialize(uploaded);
      expect(uploadedResult).toEqual(
        Result.ok({
          snapshot: {
            operationId: uploadId,
            operation: "upload",
            state: "settled",
            effect: {
              outcome: "confirmed",
              filename: "real-asset-fixture.png",
              thumbnailUrl: "https://mmbiz.qpic.cn/test/300",
            },
            result: { status: "ok", value: {} },
          },
        }),
      );
      expect(receivedUploadHash).toBe(uploadHash);
      const binaryRemote = activeConnection.get(workspaceToken, {
        callTimeout: 5_000,
      }) as unknown as {
        echoBinary(payload: {
          blob: Blob;
          bytes: Uint8Array;
          nested: { blob: Blob };
        }): Promise<{ blob: Blob; bytes: Uint8Array; nested: { blob: Blob } }>;
      };
      const payloadBytes = Uint8Array.from({ length: 100 * 1024 }, (_, index) => index % 251);
      const backing = new Uint8Array([0xaa, 41, 42, 0xbb]);
      const binaryResult = await binaryRemote.echoBinary({
        blob: new Blob([payloadBytes], { type: "image/png" }),
        bytes: new Uint8Array(backing.buffer, 1, 2),
        nested: { blob: new Blob(["nested"], { type: "text/plain" }) },
      });
      expect(binaryResult.blob.type).toBe("image/png");
      expect([...new Uint8Array(await binaryResult.blob.arrayBuffer())]).toEqual([...payloadBytes]);
      expect([...binaryResult.bytes]).toEqual([41, 42]);
      expect(binaryResult.nested.blob.type).toBe("text/plain;charset=utf-8");
      expect(await binaryResult.nested.blob.text()).toBe("nested");

      const imageRemote = activeConnection.get(workspaceToken, {
        callTimeout: 10_000,
      }) as unknown as {
        echoImage(payload: {
          blob: Blob;
          filename: string;
        }): Promise<{ blob: Blob; filename: string }>;
      };
      const imageBytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 251);
      const imageHash = createHash("sha256").update(imageBytes).digest("hex");
      const imageFileName = "bounded-image.png";
      const rssBeforeImage = process.memoryUsage().rss;
      const imageStartedAt = performance.now();
      const imageEcho = imageRemote.echoImage({
        blob: new Blob([imageBytes], { type: "image/png" }),
        filename: imageFileName,
      });
      try {
        await Promise.race([
          within(imageEchoStarted, 5_000, "2 MiB image RPC start"),
          imageEcho.then(
            () => {
              throw new Error("2 MiB image RPC returned before the provider gate");
            },
            (error: unknown) => {
              throw error;
            },
          ),
        ]);
        expect(await connectionStatusResultCodec.deserialize(await status.getStatus())).toEqual(
          Result.ok({
            connected: true,
            extensionVersion: protocolVersion,
            sessionId: expect.any(String),
            brokerVersion: protocolVersion,
            ledgerId: "58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975",
          }),
        );
      } finally {
        releaseImageEcho();
      }
      const imageResult = await imageEcho;
      const imageResultBytes = new Uint8Array(await imageResult.blob.arrayBuffer());
      const imageResultHash = createHash("sha256").update(imageResultBytes).digest("hex");
      const imageElapsedMs = performance.now() - imageStartedAt;
      const rssAfterImage = process.memoryUsage().rss;
      expect(imageResult.blob.size).toBe(2 * 1024 * 1024);
      expect(imageResult.blob.type).toBe("image/png");
      expect(imageResult.filename).toBe(imageFileName);
      expect(imageResultHash).toBe(imageHash);
      console.info(
        `2 MiB image IPC→Relay→WebSocket echo: ${imageElapsedMs.toFixed(1)} ms; RSS before/after ${rssBeforeImage}/${rssAfterImage}`,
      );
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
        endpoint: {
          meta: {
            context: "websocket-client",
            app: { protocolVersion, ledgerId: "58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975" },
          },
          implementation: pluginEndpoint,
        },
        providers: [
          { token: workspaceToken, service: workspace },
          { token: backgroundControlToken, service: connectedControlService() },
        ],
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
      reconnectClient.configure({
        endpoint: {
          meta: {
            context: "node-ipc-client",
            appId: "mpctl-reconnect-test",
            pid: process.pid,
            app: { protocolVersion },
          },
        },
      });
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
        await operationResultCodec.deserialize(
          await reconnectedWorkspace.writeBody(
            bodyInput("after-reconnect-write", "<p>重连后写入</p>"),
          ),
        ),
      ).toMatchObject(
        Result.ok({
          snapshot: { state: "settled", effect: { outcome: "confirmed", bodyHash: fixtureHash } },
        }),
      );
    } finally {
      globalThis.WebSocket = previousWebSocket;
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
  }, 20_000);
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

function bodyInput(article: string, html: string) {
  return {
    article,
    html,
    expectedHash: fixtureHash,
    operationId: `op:58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975:${crypto.randomUUID()}`,
  };
}
function bodyReply(operationId: string) {
  return Result.ok({
    snapshot: {
      operationId,
      operation: "body" as const,
      state: "settled" as const,
      effect: { outcome: "confirmed" as const, bodyHash: fixtureHash },
      result: { status: "ok" as const, value: {} },
    },
  });
}
function createPlugin(
  label: string,
  credential: string,
  control: BackgroundControlService = connectedControlService(),
  app: object = { protocolVersion, ledgerId: "58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975" },
  onMutation: () => void = () => {},
): {
  nexus: Nexus;
  endpoint: WebSocketClientEndpointType;
} {
  const protocols = createPairingSubprotocols(credential);
  if (Result.isError(protocols)) throw new Error("Invalid static test credential");
  const endpoint = new WebSocketClientEndpoint({ protocols: protocols.value });
  const nexus = new Nexus();
  nexus.configure({
    endpoint: {
      meta: { context: "websocket-client", app },
      implementation: endpoint,
    },
    providers: [
      {
        token: workspaceToken,
        service: {
          async currentArticle() {
            return encode(articleResultCodec, Result.err({ code: "target_unavailable" as const }));
          },
          async inspectArticle() {
            return encode(
              articleFieldsResultCodec,
              Result.ok({ title: "title", author: "", summary: "", fieldsHash: fixtureHash }),
            );
          },
          async updateArticleFields() {
            return encode(operationResultCodec, Result.err({ failure: { code: "unsupported" } }));
          },
          async checkArticle() {
            return encode(articleCheckResultCodec, Result.ok({ errors: [], warnings: [] }));
          },
          async listArticles() {
            return encode(listArticlesResultCodec, Result.ok([]));
          },
          async openArticle(input) {
            return encode(
              operationResultCodec,
              Result.ok({
                snapshot: {
                  operationId: input.operationId,
                  operation: "open",
                  state: "settled",
                  effect: {
                    navigation: true,
                    outcome: "confirmed",
                    pageCreated: true,
                    auxiliaryCreated: [],
                    targetBound: true,
                    bodyHash: fixtureHash,
                  },
                  result: { status: "ok", value: {} },
                },
              }),
            );
          },
          async newArticle(input) {
            return encode(
              operationResultCodec,
              Result.ok({
                snapshot: {
                  operationId: input.operationId,
                  operation: "new",
                  state: "settled",
                  effect: {
                    navigation: true,
                    outcome: "confirmed",
                    pageCreated: true,
                    auxiliaryCreated: [],
                    targetBound: true,
                    bodyHash: fixtureHash,
                  },
                  result: { status: "ok", value: {} },
                },
              }),
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
          async writeBody(input: import("@mpctl/contracts").WriteBodyInput) {
            onMutation();
            return encode(operationResultCodec, bodyReply(input.operationId));
          },
          getOperation: async () => ({
            status: "error" as const,
            error: { failure: { code: "operation_not_found" as const } },
          }),
          resolveAsset: async () => ({
            status: "error" as const,
            error: { code: "page_failed" as const },
          }),
          async listAssets() {
            return encode(assetListResultCodec, Result.ok({ scope: "visible-page", cards: [] }));
          },
          async uploadAsset(payload) {
            return encode(
              operationResultCodec,
              Result.ok({
                snapshot: {
                  operationId: payload.operationId,
                  operation: "upload",
                  state: "settled",
                  effect: {
                    outcome: "confirmed",
                    filename: payload.filename,
                    thumbnailUrl: "https://mmbiz.qpic.cn/test/300",
                  },
                  result: { status: "ok", value: {} },
                },
              }),
            );
          },
          async readArticleCover() {
            return encode(articleCoverResultCodec, Result.ok({ coverHash: "a".repeat(64) }));
          },
          async setArticleCover(input) {
            return encode(
              operationResultCodec,
              Result.ok({
                snapshot: {
                  operationId: input.operationId,
                  operation: "cover",
                  state: "settled",
                  effect: { cover: true, outcome: "confirmed", coverHash: "a".repeat(64) },
                  result: { status: "ok", value: {} },
                },
              }),
            );
          },
          async saveArticle() {
            return encode(operationResultCodec, Result.err({ failure: { code: "unsupported" } }));
          },
          async cleanupWorkspace() {
            return encode(
              cleanupWorkspaceResultCodec,
              Result.ok({ groupsRemoved: 0, tabsMoved: 0, groupsRemaining: 1 }),
            );
          },
        } satisfies WorkspaceService,
      },
      { token: backgroundControlToken, service: control },
    ],
  } as never);
  return { nexus, endpoint };
}

function connectedControlService(onStatus?: () => Promise<boolean>): BackgroundControlService {
  return {
    requestConnect: async () => ({ status: "ok" as const, value: undefined }),
    async connect() {
      return encode(connectResultCodec, Result.ok({ connected: true }));
    },
    async disconnect() {
      return encode(disconnectResultCodec, Result.ok({ connected: false as const }));
    },
    async getStatus() {
      const connected = onStatus ? await onStatus() : true;
      return encode(controlStatusResultCodec, Result.ok({ connected }));
    },
    async reload() {
      return encode(reloadResultCodec, Result.ok(undefined));
    },
  };
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
  nexus.configure({
    endpoint: {
      meta: { context: "node-ipc-client", appId, pid: process.pid, app: { protocolVersion } },
    },
  });
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

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
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
