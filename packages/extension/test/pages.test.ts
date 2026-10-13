import {
  coverExecution,
  saveExecution,
  coverIdentity,
  coverReceipt,
  saveReceipt,
} from "./cover-save-fixture";
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { materialIdentity, uploadExecution, uploadReceipt } from "./upload-fixture";
import { Nexus } from "@nexus-js/core";
import { protocolVersion } from "@mpctl/contracts";
import { Result } from "better-result";
import {
  appmsgRouteIdentity,
  classifyAppmsgUrl,
  createPageManager,
  draftListUrl,
  editorPageUrl,
  isDraftListUrl,
  isEditorPageUrl,
  type PageBinding,
} from "../src/pages";
import {
  draftPageToken,
  contentStatusToken,
  contentStatusResultCodec,
  homePageToken,
  materialPageToken,
  materialUploadResultCodec,
  articleFieldsToken,
  articleFieldsResultCodec,
  articleFieldUpdateResultCodec,
  articleCoverPageToken,
  articleCoverHashResultCodec,
  coverSaveReceiptResultCodec,
  type MaterialPageService,
} from "../src/background-contracts";

const fixtureCleanup: Array<() => void> = [];
function actionRuntime() {
  const target = new EventTarget();
  const channelId = crypto.randomUUID();
  const eventNames = { fromIsolated: `${channelId}:isolated`, fromMain: `${channelId}:main` };
  const serverEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
  const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
  fixtureCleanup.push(() => {
    serverEndpoint.close();
    clientEndpoint.close();
  });
  const runtime = new Nexus().configure({
    endpoint: { implementation: serverEndpoint, meta: { app: { protocolVersion } } },
  });
  const client = new Nexus().configure({
    endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
  });
  return {
    runtime,
    async connect() {
      await Promise.all([runtime.ready(), client.ready()]);
      return client.connect({ target: {} });
    },
  };
}
test("R3 receipt lookup rejects mismatched historical document without acquiring BODY", async () => {
  let acquired = 0;
  const manager = createPageManager(
    api({
      getTab: async () => ({ id: 1, url: editorPageUrl }),
      getFrame: async () => ({ documentId: "replacement", url: editorPageUrl }),
    }),
    undefined,
    undefined,
    undefined,
    async () => {
      acquired++;
      throw new Error("must not connect");
    },
  );
  const result = await manager.getBodyReceipt(
    {
      tabId: 1,
      documentId: "original",
      route: appmsgRouteIdentity(editorPageUrl)!,
      executorId: crypto.randomUUID(),
    },
    `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
  );
  expect(result.isErr()).toBe(true);
  expect(acquired).toBe(0);
});
test("R20 shared cover provider cannot return the other operation's receipt", async () => {
  const f = actionRuntime();
  const cover = coverExecution();
  const save = { ...saveExecution(), operationId: cover.operationId };
  let reply: Awaited<ReturnType<typeof saveReceipt>> | Awaited<ReturnType<typeof coverReceipt>> =
    await saveReceipt(save);
  expect((await coverSaveReceiptResultCodec.deserialize(reply)).isOk()).toBe(true);
  let calls = 0;
  f.runtime.provide(articleCoverPageToken, {
    ...coverIdentity,
    getReceipt: async () => {
      calls++;
      return reply;
    },
  } as never);
  const connection = await f.connect();
  const manager = createPageManager(
    api({
      getTab: async () => ({ id: 1, url: editorPageUrl }),
      getFrame: async () => ({ documentId: "original", url: editorPageUrl }),
    }),
    undefined,
    undefined,
    undefined,
    async () => connection,
  );
  const target = {
    tabId: 1,
    documentId: "original",
    route: appmsgRouteIdentity(editorPageUrl)!,
    executorId: cover.executorId,
  };
  try {
    expect(
      (await manager.getExecutionReceipt(target, cover.operationId, "save")).unwrap(),
    ).toMatchObject({
      effect: { outcome: "confirmed", persistence: "unverified" },
      result: { status: "ok" },
    });
    expect(await manager.getExecutionReceipt(target, cover.operationId, "cover")).toEqual(
      Result.err({ code: "invalid_result_envelope" }),
    );
    reply = await coverReceipt(cover, "a".repeat(64));
    expect((await coverSaveReceiptResultCodec.deserialize(reply)).isOk()).toBe(true);
    expect(
      (await manager.getExecutionReceipt(target, cover.operationId, "cover")).unwrap(),
    ).toMatchObject({ effect: { cover: true, outcome: "confirmed" }, result: { status: "ok" } });
    expect(await manager.getExecutionReceipt(target, cover.operationId, "save")).toEqual(
      Result.err({ code: "invalid_result_envelope" }),
    );
    expect(calls).toBe(4);
  } finally {
    manager.dispose();
  }
});
test("R3 receipt lookup has a whole-call deadline even when Chrome observation never returns", async () => {
  let reached!: () => void;
  const entered = new Promise<void>((done) => {
    reached = done;
  });
  let deadline!: () => void;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: () => void,
    delay: number,
  ) => {
    if (delay === 4_000) deadline = handler;
    return 1;
  }) as typeof setTimeout);
  const manager = createPageManager(
    api({
      getTab: async () => {
        reached();
        return new Promise(() => {});
      },
      getFrame: async () => ({ documentId: "doc", url: editorPageUrl }),
    }),
  );
  try {
    const pending = manager.getBodyReceipt(
      {
        tabId: 1,
        documentId: "doc",
        route: appmsgRouteIdentity(editorPageUrl)!,
        executorId: crypto.randomUUID(),
      },
      `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
    );
    await entered;
    deadline();
    expect(await pending).toEqual(Result.err({ code: "receipt_unreachable" }));
  } finally {
    timer.mockRestore();
  }
});
afterEach(() => {
  for (const cleanup of fixtureCleanup.splice(0)) cleanup();
});
test.each([
  "login",
  "missing",
  "false",
  "malformed",
  "late",
  "during-current",
  "document",
  "route",
  "version",
  "disconnect",
] as const)("B1 login identity %s uses the bound document without a terminal RPC", async (mode) => {
  const target = new EventTarget();
  const channelId = crypto.randomUUID();
  const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
  const server = createPageEndpoint({ target, channelId, side: "main", eventNames });
  const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
  let statusCalls = 0;
  let bodyAcquisitions = 0;
  let nativeCalls = 0;
  const provider = new Nexus()
    .configure({
      endpoint: { implementation: server, meta: { app: { protocolVersion, editorReady: false } } },
    })
    .provide(contentStatusToken, {
      async status() {
        statusCalls++;
        throw new Error("identity classification must not call status");
      },
    });
  const client = new Nexus().configure({
    endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
  });
  await Promise.all([provider.ready(), client.ready()]);
  const connection = await client.connect({ target: {} });
  const dial = spyOn(backgroundNexus, "safeConnect").mockResolvedValue(Result.ok(connection));
  const get = connection.safeGet.bind(connection);
  const acquisition = spyOn(connection, "safeGet").mockImplementation((token, options) => {
    if (token === pageEditorToken) bodyAcquisitions++;
    return get(token, options);
  });
  const binding = { tabId: 44, documentId: "login-document", url: editorPageUrl };
  const started = deferred<void>();
  const observed = deferred<void>();
  const release = deferred<void>();
  let nextUrl = binding.url;
  let hold = false;
  const manager = createPageManager(
    api({
      executeMain: async () => {
        nativeCalls++;
        throw new Error("must not run native");
      },
      async getTab() {
        if (hold) {
          observed.resolve();
          await release.promise;
        }
        return { id: binding.tabId, url: nextUrl };
      },
    }),
  );
  manager.observe(binding);
  const subscribe = connection.subscribeIdentity.bind(connection);
  const identity = spyOn(connection, "subscribeIdentity").mockImplementation((listener) => {
    const stop = subscribe(listener);
    started.resolve();
    return stop;
  });
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const timers = spyOn(globalThis, "setTimeout");
  try {
    const opening = manager.open(binding);
    await started.promise;
    await manager.isCurrent(binding);
    const waitTimers = timers.mock.calls
      .map((call, index) => ({ call, handle: timers.mock.results[index]!.value }))
      .filter(({ call: [, delay] }) => typeof delay === "number" && delay >= 8000 && delay <= 10000)
      .sort((a, b) => Number(a.call[1]) - Number(b.call[1]));
    expect(waitTimers).toHaveLength(2);
    clock.mockReturnValue(now + (mode === "late" ? 10124 : 2300));
    hold = true;
    await provider.updateIdentity({
      app: {
        protocolVersion: mode === "version" ? "0.9.0" : protocolVersion,
        editorReady: false,
        ...(mode === "missing"
          ? {}
          : { loginExpired: mode === "malformed" ? "true" : mode !== "false" }),
      },
    });
    if (mode !== "version") {
      await observed.promise;
      if (mode === "document") manager.observe({ ...binding, documentId: "successor" });
      if (mode === "route") nextUrl = draftListUrl;
      if (mode === "disconnect") connection.disconnect();
      if (mode === "during-current") clock.mockReturnValue(now + 10124);
      release.resolve();
      await manager.isCurrent(binding);
    }
    clock.mockReturnValue(now + 10124);
    waitTimers[0]!.call[0]();
    waitTimers[1]!.call[0]();
    const result = await opening;
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("must not acquire BODY");
    if (mode === "login") expect(result.error.code).toBe("not_logged_in");
    else if (mode === "document" || mode === "route")
      expect(result.error.code).toBe("target_unavailable");
    else
      expect(result.error.readFailure?.causeCode).toBe(
        mode === "version"
          ? "version_mismatch"
          : mode === "disconnect"
            ? "E_CONN_CLOSED"
            : "editor_bootstrap_timeout",
      );
    expect([statusCalls, bodyAcquisitions, nativeCalls]).toEqual([0, 0, 0]);
    expect(dial.mock.calls).toHaveLength(1);
  } finally {
    release.resolve();
    manager.dispose();
    for (const r of timers.mock.results) if (r.type === "return") clearTimeout(r.value);
    timers.mockRestore();
    clock.mockRestore();
    identity.mockRestore();
    acquisition.mockRestore();
    dial.mockRestore();
    connection.disconnect();
    server.close();
    clientEndpoint.close();
  }
});
test.each(["before-status", "after-status"] as const)(
  "R1 fallback %s prioritizes ready plus expired while identity current check is held",
  async (mode) => {
    const target = new EventTarget();
    const channelId = crypto.randomUUID();
    const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
    const server = createPageEndpoint({ target, channelId, side: "main", eventNames });
    const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
    const statusStarted = deferred<void>();
    const statusRelease = deferred<void>();
    const fallbackStarted = deferred<void>();
    const fallbackRelease = deferred<void>();
    const identityStarted = deferred<void>();
    const identityRelease = deferred<void>();
    const subscribed = deferred<void>();
    let statusCalls = 0;
    let bodyAcquisitions = 0;
    let nativeCalls = 0;
    const binding = { tabId: 45, documentId: "fallback-race", url: editorPageUrl };
    const provider = new Nexus()
      .configure({
        endpoint: {
          implementation: server,
          meta: { app: { protocolVersion, editorReady: false } },
        },
      })
      .provide(contentStatusToken, {
        async status() {
          statusCalls++;
          statusStarted.resolve();
          await statusRelease.promise;
          return wire(
            contentStatusResultCodec,
            Result.ok({
              state: "loading" as const,
              route: appmsgRouteIdentity(binding.url)!,
              documentReady: true,
            }),
          );
        },
      })
      .provide(pageEditorToken, {
        async ready() {
          nativeCalls++;
          throw new Error("must not acquire BODY");
        },
        async getContent() {
          nativeCalls++;
          throw new Error("must not read BODY");
        },
        async setContent() {
          nativeCalls++;
          throw new Error("must not write BODY");
        },
        async getReceipt() {
          return { status: "ok" as const, value: null };
        },
        setCoverFromBody: async () => ({
          status: "error" as const,
          error: { code: "unsupported" as const },
        }),
        async getCoverReceipt() {
          return { status: "ok" as const, value: null };
        },
      });
    const client = new Nexus().configure({
      endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
    });
    await Promise.all([provider.ready(), client.ready()]);
    const connection = await client.connect({ target: {} });
    const dial = spyOn(backgroundNexus, "safeConnect").mockResolvedValue(Result.ok(connection));
    const get = connection.safeGet.bind(connection);
    const acquisition = spyOn(connection, "safeGet").mockImplementation((token, options) => {
      if (token === pageEditorToken) bodyAcquisitions++;
      return get(token, options);
    });
    let phase: "initial" | "fallback" | "identity" | "final" = "initial";
    const manager = createPageManager(
      api({
        async getTab() {
          if (phase === "fallback" && mode === "before-status") {
            fallbackStarted.resolve();
            await fallbackRelease.promise;
          } else if (phase === "identity") {
            identityStarted.resolve();
            await identityRelease.promise;
          }
          return { id: binding.tabId, url: binding.url };
        },
      }),
    );
    manager.observe(binding);
    const subscribe = connection.subscribeIdentity.bind(connection);
    const identity = spyOn(connection, "subscribeIdentity").mockImplementation((listener) => {
      const stop = subscribe(listener);
      subscribed.resolve();
      return stop;
    });
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const timers = spyOn(globalThis, "setTimeout");
    try {
      const opening = manager.open(binding);
      await subscribed.promise;
      await manager.isCurrent(binding);
      const fallback = timers.mock.calls.find(([, delay]) => delay === 9000)!;
      expect(fallback).toBeDefined();
      phase = "fallback";
      clock.mockReturnValue(now + 9000);
      fallback[0]();
      await (mode === "before-status" ? fallbackStarted.promise : statusStarted.promise);
      phase = "identity";
      await provider.updateIdentity({
        app: { protocolVersion, editorReady: true, loginExpired: true },
      });
      await identityStarted.promise;
      phase = "final";
      fallbackRelease.resolve();
      statusRelease.resolve();
      const result = await opening;
      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expired BODY was returned");
      expect(result.error.code).toBe("not_logged_in");
      expect([statusCalls, bodyAcquisitions, nativeCalls]).toEqual([
        mode === "before-status" ? 0 : 1,
        0,
        0,
      ]);
      expect(dial.mock.calls).toHaveLength(1);
    } finally {
      identityRelease.resolve();
      fallbackRelease.resolve();
      statusRelease.resolve();
      manager.dispose();
      for (const r of timers.mock.results) if (r.type === "return") clearTimeout(r.value);
      timers.mockRestore();
      clock.mockRestore();
      identity.mockRestore();
      acquisition.mockRestore();
      dial.mockRestore();
      connection.disconnect();
      server.close();
      clientEndpoint.close();
    }
  },
);
import { createPageEndpoint } from "../src/transport/page-bridge";
import { backgroundNexus } from "../src/background-runtime";
import { pageEditorToken, pageEditorReadyResultCodec } from "../src/page-contracts";
const executorId = crypto.randomUUID();
import {
  currentItemCountResultCodec,
  homeIsReadyResultCodec,
  openDraftListResultCodec,
  listDraftsResultCodec,
  validateDraftResultCodec,
} from "../src/background-contracts";

async function wire<T, E, W>(
  codec: {
    serialize(
      value: import("better-result").Result<T, E>,
    ): Promise<import("better-result").Result<W, unknown>>;
  },
  value: import("better-result").Result<T, E>,
) {
  const result = await codec.serialize(value);
  if (Result.isError(result)) throw result.error;
  return result.value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const api = (overrides: Record<string, unknown> = {}) => ({
  async getGroup() {
    return {};
  },
  async createTab() {
    return { id: 1 };
  },
  async groupTabs() {
    return 7;
  },
  async updateGroup() {},
  async queryGroup() {
    return [];
  },
  async queryMpTabs() {
    return [];
  },
  async getTab(id: number) {
    return { id, url: draftListUrl };
  },
  async getSession(key?: string | null) {
    return key ? {} : { managedGroupId: 7 };
  },
  async setSession() {},
  ...overrides,
});

const unwrap = <T, E>(result: import("better-result").Result<T, E>): T => {
  if (Result.isError(result)) throw result.error;
  return result.value;
};

const homeUrl = "https://mp.weixin.qq.com/cgi-bin/home?t=home&lang=en_US&token=context";
const savedUrl =
  "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=g1&token=context";

const uploadPayload = () => ({
  blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }),
  filename: "fixture.png",
  mimeType: "image/png" as const,
});

test.each([
  "L0.login",
  "L1.document-before",
  "L1.downgrade-before",
  "L1.disconnect-before",
  "L1.document-during",
  "L1.downgrade-during",
  "L1.disconnect-during",
  "L2.ready",
  "L2.loading",
  "L2.stalled-status",
  "L3.publish-before",
  "L3.publish-during",
] as const)("T0 %s at the bounded BODY terminal observation", async (mode) => {
  const target = new EventTarget();
  const channelId = crypto.randomUUID();
  const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
  const providerEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
  const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
  const binding = { tabId: 44, documentId: "terminal-doc", url: editorPageUrl };
  const statusStarted = deferred<void>();
  const releaseStatus = deferred<void>();
  const statusRevalidated = deferred<void>();
  const waitStarted = deferred<void>();
  let state: "ready" | "loading" | "not_logged_in" = "ready";
  let statusCalls = 0;
  let nativeReads = 0;
  let nativeWrites = 0;
  let statusReleased = false;
  const provider = new Nexus()
    .configure({
      endpoint: {
        implementation: providerEndpoint,
        meta: { app: { protocolVersion, editorReady: false } },
      },
    })
    .provide(contentStatusToken, {
      async status() {
        statusCalls++;
        statusStarted.resolve();
        await releaseStatus.promise;
        return wire(
          contentStatusResultCodec,
          Result.ok({ state, route: appmsgRouteIdentity(binding.url)!, documentReady: true }),
        );
      },
    });
  const client = new Nexus().configure({
    endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
  });
  await Promise.all([provider.ready(), client.ready()]);
  const connection = await client.connect({ target: {} });
  const dial = spyOn(backgroundNexus, "safeConnect").mockResolvedValue(Result.ok(connection));
  const get = connection.safeGet.bind(connection);
  let bodyAcquisitions = 0;
  const acquisition = spyOn(connection, "safeGet").mockImplementation((token, options) => {
    if (token === pageEditorToken) bodyAcquisitions++;
    return get(token, options);
  });
  let identityListeners = 0;
  let disconnectListeners = 0;
  const subscribe = connection.subscribeIdentity.bind(connection);
  const onDisconnected = connection.onDisconnected.bind(connection);
  const identity = spyOn(connection, "subscribeIdentity").mockImplementation((listener) => {
    identityListeners++;
    const stop = subscribe(listener);
    waitStarted.resolve();
    return () => {
      identityListeners--;
      stop();
    };
  });
  const disconnect = spyOn(connection, "onDisconnected").mockImplementation((listener) => {
    disconnectListeners++;
    const stop = onDisconnected(listener);
    return () => {
      disconnectListeners--;
      stop();
    };
  });
  const manager = createPageManager(
    api({
      getTab: async () => {
        if (statusReleased && statusCalls > 0) statusRevalidated.resolve();
        return { id: binding.tabId, url: binding.url };
      },
    }),
  );
  manager.observe(binding);
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const timers = spyOn(globalThis, "setTimeout");
  const clearTimer = spyOn(globalThis, "clearTimeout");
  const invalidate = async () => {
    if (mode.includes("document")) manager.observe({ ...binding, documentId: "successor" });
    else if (mode.includes("downgrade"))
      await provider.updateIdentity({ app: { protocolVersion: "0.9.0", editorReady: false } });
    else connection.disconnect();
  };
  const publish = async () => {
    provider.provide(pageEditorToken, {
      async ready() {
        return wire(
          pageEditorReadyResultCodec,
          Result.ok({ isReady: true, isNew: true, executorId }),
        );
      },
      async getContent() {
        nativeReads++;
        return { status: "ok" as const, value: "body" };
      },
      async setContent() {
        nativeWrites++;
        throw new Error("must not write");
      },
      getReceipt: async () => ({ status: "ok" as const, value: null }),
      setCoverFromBody: async () => ({
        status: "error" as const,
        error: { code: "unsupported" as const },
      }),
      getCoverReceipt: async () => ({ status: "ok" as const, value: null }),
    });
    await provider.updateIdentity({ app: { protocolVersion, editorReady: true } });
  };
  try {
    const opening = manager.open(binding);
    await waitStarted.promise;
    const waitTimers = timers.mock.calls
      .map((call, index) => ({ call, handle: timers.mock.results[index]!.value }))
      .filter(
        ({ call: [, delay] }) => typeof delay === "number" && delay >= 8000 && delay <= 10_000,
      )
      .sort((a, b) => Number(a.call[1]) - Number(b.call[1]));
    expect(waitTimers.length).toBeGreaterThan(0);
    state = mode === "L2.ready" ? "ready" : mode === "L2.loading" ? "loading" : "not_logged_in";
    if (mode.endsWith("-before")) {
      if (mode.startsWith("L3")) await publish();
      else await invalidate();
    }
    const terminal = waitTimers[0]!;
    clock.mockReturnValue(now + Number(terminal.call[1]));
    // Explicitly select the terminal event, rather than waiting for wall-clock scheduling.
    terminal.call[0]();
    if (!mode.endsWith("-before")) {
      await Promise.race([statusStarted.promise, opening.then(() => undefined)]);
      if (mode.endsWith("-during") || mode.startsWith("L2")) expect(statusCalls).toBe(1);
      if (mode.endsWith("-during")) {
        if (mode.startsWith("L3")) await publish();
        else await invalidate();
      }
      if (mode === "L2.stalled-status") {
        clock.mockReturnValue(now + 10_000);
        waitTimers.at(-1)!.call[0]();
      } else {
        statusReleased = true;
        releaseStatus.resolve();
        if (mode.startsWith("L2")) {
          await statusRevalidated.promise;
          clock.mockReturnValue(now + 10_000);
          waitTimers.at(-1)!.call[0]();
        }
      }
    }
    const result = await opening;
    if (mode.startsWith("L3")) {
      expect(result.isOk()).toBe(true);
      if (result.isErr()) throw result.error;
      expect(await result.value.getContent()).toMatchObject(Result.ok("body"));
    } else {
      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("BODY must not be acquired");
      if (mode === "L0.login") expect(result.error.code).toBe("not_logged_in");
      else if (mode.includes("document")) expect(result.error.code).toBe("target_unavailable");
      else
        expect(result.error.readFailure?.causeCode).toBe(
          mode.includes("downgrade")
            ? "version_mismatch"
            : mode.includes("disconnect")
              ? "E_CONN_CLOSED"
              : "editor_bootstrap_timeout",
        );
    }
    expect(statusCalls).toBe(mode.endsWith("-before") ? 0 : 1);
    expect(bodyAcquisitions).toBe(mode.startsWith("L3") ? 1 : 0);
    expect([nativeReads, nativeWrites]).toEqual([mode.startsWith("L3") ? 1 : 0, 0]);
    expect(dial.mock.calls).toHaveLength(1);
    expect(dial.mock.calls[0]![0]?.target).toMatchObject({
      tabId: binding.tabId,
      documentId: binding.documentId,
    });
    expect([identityListeners, disconnectListeners]).toEqual([0, 0]);
    for (const { handle } of waitTimers)
      expect(clearTimer.mock.calls.some(([cleared]) => cleared === handle)).toBe(true);
    releaseStatus.resolve();
    if (connection.status === "connected" && !mode.includes("downgrade")) await publish();
    expect(bodyAcquisitions).toBe(mode.startsWith("L3") ? 1 : 0);
  } finally {
    releaseStatus.resolve();
    manager.dispose();
    for (const result of timers.mock.results)
      if (result.type === "return") clearTimeout(result.value);
    clearTimer.mockRestore();
    timers.mockRestore();
    clock.mockRestore();
    identity.mockRestore();
    disconnect.mockRestore();
    acquisition.mockRestore();
    dial.mockRestore();
    connection.disconnect();
    providerEndpoint.close();
    clientEndpoint.close();
  }
});

test.each([
  "publish",
  "downgrade",
  "disconnect",
  "document",
  "navigate",
  "dispose",
  "absent",
  "timeout",
] as const)(
  "W2 correction BODY bootstrap %s keeps DOM independent and acquires once",
  async (mode) => {
    const target = new EventTarget();
    const channelId = crypto.randomUUID();
    const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
    const providerEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
    const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
    const binding = { tabId: 44, documentId: "bootstrap-doc", url: editorPageUrl };
    let nativeReads = 0;
    let nativeWrites = 0;
    const provider = new Nexus()
      .configure({
        endpoint: {
          implementation: providerEndpoint,
          meta: { app: { protocolVersion, editorReady: false } },
        },
      })
      .provide(articleFieldsToken, {
        ...fieldsProviderIdentity,
        async readArticleFields() {
          return wire(
            articleFieldsResultCodec,
            Result.ok({ title: "Title", author: "", summary: "" }),
          );
        },
        async updateArticleFields() {
          throw new Error("not used");
        },
      })
      .provide(contentStatusToken, {
        async status() {
          return wire(
            contentStatusResultCodec,
            Result.ok({
              state: "ready",
              route: appmsgRouteIdentity(binding.url)!,
              documentReady: true,
            }),
          );
        },
      });
    const client = new Nexus().configure({
      endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
    });
    await Promise.all([provider.ready(), client.ready()]);
    const connection = await client.connect({ target: {} });
    const dial = spyOn(backgroundNexus, "safeConnect").mockResolvedValue(Result.ok(connection));
    const get = connection.safeGet.bind(connection);
    let editorAcquisitions = 0;
    const acquisition = spyOn(connection, "safeGet").mockImplementation((token, options) => {
      if (token === pageEditorToken) editorAcquisitions++;
      return get(token, options);
    });
    const started = deferred<void>();
    let identityListeners = 0;
    let disconnectListeners = 0;
    const subscribe = connection.subscribeIdentity.bind(connection);
    const onDisconnected = connection.onDisconnected.bind(connection);
    const identity = spyOn(connection, "subscribeIdentity").mockImplementation((listener) => {
      identityListeners++;
      const stop = subscribe(listener);
      started.resolve();
      return () => {
        identityListeners--;
        stop();
      };
    });
    const disconnect = spyOn(connection, "onDisconnected").mockImplementation((listener) => {
      disconnectListeners++;
      const stop = onDisconnected(listener);
      return () => {
        disconnectListeners--;
        stop();
      };
    });
    let beforeNavigate: ((details: { tabId: number; frameId: number }) => void) | undefined;
    const manager = createPageManager(
      api({
        getTab: async () => ({ id: binding.tabId, url: binding.url }),
        onBeforeNavigate: (listener: typeof beforeNavigate) => {
          beforeNavigate = listener;
        },
      }),
    );
    manager.observe(binding);
    const timers = spyOn(globalThis, "setTimeout");
    const clearTimer = spyOn(globalThis, "clearTimeout");
    try {
      const opening = manager.open(binding);
      await Promise.race([
        started.promise,
        opening.then(() => {
          throw new Error("BODY acquisition returned before readiness subscription");
        }),
      ]);
      expect(dial.mock.calls.length).toBe(1);
      expect(editorAcquisitions).toBe(0);
      expect((await manager.readArticleFields(binding)).isOk()).toBe(true);
      expect((await manager.pageStatus(binding)).unwrap()).toMatchObject({
        state: "ready",
        documentReady: true,
      });
      expect([nativeReads, nativeWrites]).toEqual([0, 0]);
      const dialsBeforePublication = dial.mock.calls.length;
      const bootstrapTimerIndex = timers.mock.calls.findIndex(
        ([, milliseconds]) =>
          typeof milliseconds === "number" && milliseconds > 9000 && milliseconds <= 10_000,
      );
      expect(bootstrapTimerIndex).toBeGreaterThanOrEqual(0);
      const bootstrapTimer = timers.mock.results[bootstrapTimerIndex]!.value;
      if (mode === "publish") {
        provider.provide(pageEditorToken, {
          async ready() {
            nativeReads++;
            return wire(
              pageEditorReadyResultCodec,
              Result.ok({ isReady: true, isNew: true, executorId }),
            );
          },
          async getContent() {
            nativeReads++;
            return { status: "ok" as const, value: "body" };
          },
          async setContent() {
            nativeWrites++;
            throw new Error("must not write");
          },
          getReceipt: async () => ({ status: "ok" as const, value: null }),
          setCoverFromBody: async () => ({
            status: "error" as const,
            error: { code: "unsupported" as const },
          }),
          getCoverReceipt: async () => ({ status: "ok" as const, value: null }),
        });
        await provider.updateIdentity({ app: { protocolVersion, editorReady: true } });
      } else if (mode === "downgrade")
        await provider.updateIdentity({ app: { protocolVersion: "0.9.0", editorReady: true } });
      else if (mode === "disconnect") connection.disconnect();
      else if (mode === "document") manager.observe({ ...binding, documentId: "successor" });
      else if (mode === "navigate") beforeNavigate?.({ tabId: binding.tabId, frameId: 0 });
      else if (mode === "dispose") manager.dispose();
      else if (mode === "absent")
        await provider.updateIdentity({ app: { protocolVersion, editorReady: true } });
      const result = await opening;
      expect(dial.mock.calls.length).toBe(dialsBeforePublication);
      expect([nativeReads, nativeWrites]).toEqual([0, 0]);
      if (mode === "publish") {
        expect(result.isOk()).toBe(true);
        if (result.isOk()) expect((await result.value.ready()).isOk()).toBe(true);
        expect([nativeReads, nativeWrites]).toEqual([1, 0]);
      } else {
        expect(result.isErr()).toBe(true);
        if (result.isOk()) throw new Error("must refuse");
        expect(result.error.code).not.toBe("write_unknown");
        if (mode === "absent")
          expect(result.error.observedFailure?.causeCode).toBe("E_SERVICE_UNAVAILABLE");
        if (mode === "downgrade")
          expect(result.error.readFailure?.causeCode).toBe("version_mismatch");
        if (mode === "disconnect")
          expect(result.error.readFailure?.causeCode).toBe("E_CONN_CLOSED");
        if (mode === "document" || mode === "navigate" || mode === "dispose")
          expect(result.error.code).toBe("target_unavailable");
        if (mode === "timeout") {
          expect(result.error.readFailure).toMatchObject({
            stage: "page_acquire",
            causeCode: "editor_bootstrap_timeout",
          });
          expect((await manager.readArticleFields(binding)).isOk()).toBe(true);
        }
      }
      expect(editorAcquisitions).toBe(mode === "publish" || mode === "absent" ? 1 : 0);
      expect([identityListeners, disconnectListeners]).toEqual([0, 0]);
      expect(clearTimer.mock.calls.some(([handle]) => handle === bootstrapTimer)).toBe(true);
      expect(
        dial.mock.calls
          .filter(
            ([options]) =>
              options?.target &&
              "kind" in options.target &&
              options.target.kind === "content-document",
          )
          .every(
            ([options]) =>
              options?.target &&
              "documentId" in options.target &&
              options.target.documentId === binding.documentId,
          ),
      ).toBe(true);
      // No callbacks/resources remain to react to a later identity; never replay acquisition.
      const acquisitions = editorAcquisitions;
      if (connection.status === "connected")
        await provider.updateIdentity({ app: { protocolVersion, editorReady: true } });
      expect(editorAcquisitions).toBe(acquisitions);
    } finally {
      clearTimer.mockRestore();
      timers.mockRestore();
      identity.mockRestore();
      disconnect.mockRestore();
      acquisition.mockRestore();
      dial.mockRestore();
      manager.dispose();
      providerEndpoint.close();
      clientEndpoint.close();
    }
  },
  15_000,
);

test.each([undefined, "", "0.9.0", protocolVersion])(
  "W2 content admission %s covers DOM and upload",
  async (version) => {
    const target = new EventTarget();
    const channelId = crypto.randomUUID();
    const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
    const serverEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
    const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
    let uploads = 0;
    const provider = new Nexus()
      .configure({
        endpoint: {
          implementation: serverEndpoint,
          meta: version === undefined ? {} : { app: { protocolVersion: version } },
        },
      })
      .provide(materialPageToken, {
        ...materialIdentity,
        async list() {
          return { status: "ok" as const, value: { scope: "visible-page" as const, cards: [] } };
        },
        async upload(payload, execution) {
          uploads++;
          return {
            status: "ok" as const,
            value: await uploadReceipt(payload, execution),
          };
        },
      });
    const client = new Nexus().configure({
      endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
    });
    const binding = { tabId: 44, documentId: "w2-content", url: editorPageUrl };
    try {
      await Promise.all([provider.ready(), client.ready()]);
      const connection = await client.connect({ target: {} });
      const manager = createPageManager(
        api({ getTab: async () => ({ id: 44, url: binding.url }) }),
        undefined,
        undefined,
        undefined,
        async () => connection,
      );
      manager.observe(binding);
      const result = await manager.uploadMaterial(binding, uploadPayload(), uploadExecution);
      expect(Result.isOk(result)).toBe(version === protocolVersion);
      expect(uploads).toBe(version === protocolVersion ? 1 : 0);
      if (version !== protocolVersion)
        expect(result).toMatchObject({
          error: {
            code: "page_failed",
            notInvoked: true,
            cause: { at: "bg.page_connect", kind: "protocol", code: "version_mismatch" },
          },
        });
    } finally {
      serverEndpoint.close();
      clientEndpoint.close();
    }
  },
);

test("W2 document replacement during content acquisition refuses before provider mutation", async () => {
  const target = new EventTarget();
  const channelId = crypto.randomUUID();
  const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
  const providerEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
  const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
  let uploads = 0;
  const provider = new Nexus()
    .configure({
      endpoint: { implementation: providerEndpoint, meta: { app: { protocolVersion } } },
    })
    .provide(materialPageToken, {
      ...materialIdentity,
      async list() {
        return { status: "ok" as const, value: { scope: "visible-page" as const, cards: [] } };
      },
      async upload(payload, execution) {
        uploads++;
        return {
          status: "ok" as const,
          value: await uploadReceipt(payload, execution),
        };
      },
    });
  const client = new Nexus().configure({
    endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
  });
  const binding = { tabId: 44, documentId: "before-dial", url: editorPageUrl };
  try {
    await Promise.all([provider.ready(), client.ready()]);
    const connection = await client.connect({ target: {} });
    const manager = createPageManager(
      api({ getTab: async () => ({ id: 44, url: binding.url }) }),
      undefined,
      undefined,
      undefined,
      async () => {
        manager.observe({ ...binding, documentId: "successor-document" });
        return connection;
      },
    );
    manager.observe(binding);
    expect(await manager.uploadMaterial(binding, uploadPayload(), uploadExecution)).toMatchObject(
      Result.err({ code: "target_unavailable" }),
    );
    expect(uploads).toBe(0);
  } finally {
    providerEndpoint.close();
    clientEndpoint.close();
  }
});

test.each(["remote", "malformed", "provider", "conflict"] as const)(
  "W2 field loss %s never synthesizes requested lists",
  async (mode) => {
    const target = new EventTarget();
    const channelId = crypto.randomUUID();
    const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
    const serverEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
    const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
    const provider = new Nexus()
      .configure({
        endpoint: { implementation: serverEndpoint, meta: { app: { protocolVersion } } },
      })
      .provide(articleFieldsToken, {
        ...fieldsProviderIdentity,
        async readArticleFields() {
          throw new Error("unexpected read");
        },
        async updateArticleFields(fields, hash, execution) {
          if (mode === "remote") throw new Error("private provider failure");
          if (mode === "malformed")
            return {
              status: "error" as const,
              error: { code: "invalid_result_envelope" as const },
            };
          if (mode === "conflict")
            return wire(
              articleFieldUpdateResultCodec,
              Result.err({
                code: "content_conflict",
                cause: { at: "content.preflight", kind: "domain", code: "content_conflict" },
              }),
            );
          return wire(
            articleFieldUpdateResultCodec,
            Result.ok({
              ...(await fieldsReceipt(fields, hash, execution, "a".repeat(64))),
              effect: {
                outcome: "partial",
                requested: ["title", "author", "summary"],
                attempted: ["title", "author"],
                confirmed: ["title"],
                unknown: ["author"],
              },
              result: {
                status: "error",
                error: {
                  code: "page_failed",
                  cause: { at: "content.field_edit", kind: "runtime", code: "field_setter_failed" },
                },
              },
            }),
          );
        },
      });
    const client = new Nexus().configure({
      endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
    });
    const binding = { tabId: 44, documentId: "w2-fields", url: editorPageUrl };
    try {
      await Promise.all([provider.ready(), client.ready()]);
      const connection = await client.connect({ target: {} });
      const manager = createPageManager(
        api({ getTab: async () => ({ id: 44, url: binding.url }) }),
        undefined,
        undefined,
        undefined,
        async () => connection,
      );
      manager.observe(binding);
      const result = await manager.updateArticleFields(
        binding,
        { title: "new", author: "new", summary: "unattempted" },
        "0".repeat(64),
        {
          operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
          executorId: fieldsExecutorId,
        },
      );
      if (mode === "provider") {
        expect(result.isOk()).toBe(true);
        if (result.isOk())
          expect(result.value).toMatchObject({
            effect: { attempted: ["title", "author"], confirmed: ["title"], unknown: ["author"] },
            result: { status: "error", error: { cause: { code: "field_setter_failed" } } },
          });
        return;
      }
      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("unexpected success");
      if (mode === "conflict") {
        expect(result.error).toMatchObject({
          code: "content_conflict",
          cause: { at: "content.preflight", kind: "domain", code: "content_conflict" },
        });
        return;
      }
      expect(result.error.code).toBe(
        mode === "remote" ? "receipt_unreachable" : "invalid_result_envelope",
      );
      expect(result.error).not.toHaveProperty("effect");
    } finally {
      serverEndpoint.close();
      clientEndpoint.close();
    }
  },
);

test.each(["missing", "remote", "malformed", "domain"] as const)(
  "W2 read seam %s retains acquisition/call/decode/domain without mutation outcome",
  async (mode) => {
    const target = new EventTarget();
    const channelId = crypto.randomUUID();
    const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
    const providerEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
    const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
    const provider = new Nexus().configure({
      endpoint: { implementation: providerEndpoint, meta: { app: { protocolVersion } } },
    });
    if (mode !== "missing")
      provider.provide(articleFieldsToken, {
        ...fieldsProviderIdentity,
        async readArticleFields() {
          if (mode === "remote") throw new Error("private remote read");
          if (mode === "malformed")
            return {
              status: "error" as const,
              error: { code: "invalid_result_envelope" as const },
            };
          return wire(
            articleFieldsResultCodec,
            Result.err({
              code: "page_failed",
              readFailure: {
                stage: "native_read",
                kind: "runtime",
                causeCode: "dom_read_failed",
                component: "fields",
              },
            }),
          );
        },
        async updateArticleFields() {
          throw new Error("not used");
        },
      });
    const client = new Nexus().configure({
      endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
    });
    try {
      await Promise.all([provider.ready(), client.ready()]);
      const connection = await client.connect({ target: {} });
      const binding = { tabId: 44, documentId: "read-w2", url: editorPageUrl };
      const manager = createPageManager(
        api({ getTab: async () => ({ id: 44, url: binding.url }) }),
        undefined,
        undefined,
        undefined,
        async () => connection,
      );
      manager.observe(binding);
      const result = await manager.readArticleFields(binding);
      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      const expected: NonNullable<import("../src/pages").PageManagerError["observedFailure"]> = {
        kind:
          mode === "missing" || mode === "remote"
            ? "nexus"
            : mode === "malformed"
              ? "protocol"
              : "runtime",
        causeCode:
          mode === "missing"
            ? "E_SERVICE_UNAVAILABLE"
            : mode === "remote"
              ? "E_REMOTE_EXCEPTION"
              : mode === "malformed"
                ? "invalid_result_envelope"
                : "dom_read_failed",
      };
      expect(result.error.readFailure).toMatchObject({
        stage:
          mode === "missing"
            ? "page_acquire"
            : mode === "remote"
              ? "page_call"
              : mode === "malformed"
                ? "page_decode"
                : "native_read",
        ...expected,
      });
      expect(result.error.readFailure).not.toHaveProperty("outcome");
      expect(result.error.observedFailure).toEqual(expected);
    } finally {
      providerEndpoint.close();
      clientEndpoint.close();
    }
  },
);

test.each(["cover", "save"] as const)(
  "W2 %s page boundary retains real remote failure without claiming native cause",
  async (operation) => {
    const target = new EventTarget();
    const channelId = crypto.randomUUID();
    const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
    const providerEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
    const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
    const binding = { tabId: 44, documentId: "mutation-w2", url: editorPageUrl };
    const provider = new Nexus()
      .configure({
        endpoint: { implementation: providerEndpoint, meta: { app: { protocolVersion } } },
      })
      .provide(articleCoverPageToken, {
        ...coverIdentity,
        async read() {
          return wire(articleCoverHashResultCodec, Result.ok("0".repeat(64)));
        },
        async set() {
          throw new Error("private cover exception");
        },
        async save() {
          throw new Error("private save exception");
        },
      });
    const client = new Nexus().configure({
      endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
    });
    try {
      await Promise.all([provider.ready(), client.ready()]);
      const connection = await client.connect({ target: {} });
      const manager = createPageManager(
        api({
          getTab: async () => ({ id: 44, url: binding.url }),
          getLocal: async () => ({ managedGroupId: 7 }),
          setLocal: async () => {},
          queryGroup: async () => [{ id: 44, url: binding.url }],
        }),
        undefined,
        undefined,
        undefined,
        async () => connection,
      );
      manager.observe(binding);
      const result =
        operation === "cover"
          ? await manager.setArticleCover(
              binding,
              { filename: "x.png", thumbnailUrl: "https://mmbiz.qpic.cn/x/300" },
              "0".repeat(64),
              coverExecution(),
            )
          : await manager.saveArticle(binding, saveExecution());
      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error.cause).toMatchObject({
        at: "bg.page_call",
        kind: "nexus",
        code: "E_REMOTE_EXCEPTION",
      });
      expect(result.error.notInvoked).toBeUndefined();
    } finally {
      providerEndpoint.close();
      clientEndpoint.close();
    }
  },
);

function materialUploadManager(
  upload: () => ReturnType<MaterialPageService["upload"]>,
  callTimeout?: number,
): ReturnType<typeof createPageManager> {
  const binding = {
    tabId: 44,
    documentId: "asset-document",
    url: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=context",
  };
  const eventTarget = new EventTarget();
  const endpointNames = { fromIsolated: "asset-test:isolated", fromMain: "asset-test:main" };
  const mainEndpoint = createPageEndpoint({
    target: eventTarget,
    channelId: "asset-test",
    side: "main",
    eventNames: endpointNames,
  });
  const contentEndpoint = createPageEndpoint({
    target: eventTarget,
    channelId: "asset-test",
    side: "isolated",
    eventNames: endpointNames,
  });
  const pageRuntime = new Nexus()
    .provide(materialPageToken, {
      ...materialIdentity,
      list: async () => ({
        status: "ok" as const,
        value: { scope: "visible-page" as const, cards: [] },
      }),
      upload: async () => upload(),
    } satisfies MaterialPageService)
    .configure({ endpoint: { implementation: mainEndpoint, meta: { app: { protocolVersion } } } });
  const manager = createPageManager(
    api({
      async getTab(tabId: number) {
        return { id: tabId, url: binding.url };
      },
    }) as never,
    undefined,
    undefined,
    undefined,
    async () => {
      const client = new Nexus().configure({
        endpoint: { implementation: contentEndpoint, meta: { app: { protocolVersion } } },
      });
      await Promise.all([pageRuntime.ready(), client.ready()]);
      const connection = await client.connect({ target: {} });
      if (callTimeout === undefined) return connection;
      return new Proxy(connection, {
        get(target, property) {
          if (property === "safeGet")
            return () => target.safeGet(materialPageToken, { callTimeout });
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  );
  manager.observe(binding);
  return manager;
}

function uploadBinding(manager: ReturnType<typeof createPageManager>): PageBinding {
  const binding = {
    tabId: 44,
    documentId: "asset-document",
    url: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=context",
  };
  manager.observe(binding);
  return binding;
}

function navigationFixture(frameApi = true) {
  const tabs = new Map<number, { id: number; url: string }>([
    [1, { id: 1, url: homeUrl }],
    [2, { id: 2, url: draftListUrl }],
  ]);
  const created: string[] = [];
  let targetUrl = `${editorPageUrl}&token=context&timestamp=before`;
  let frameLookup: ((binding: PageBinding) => void) | undefined;
  let beforeNavigate: ((details: { tabId: number; frameId: number }) => void) | undefined;
  let committed:
    | ((details: { tabId: number; frameId: number; documentId: string }) => void)
    | undefined;
  let onStatus: ((binding: PageBinding) => void) | undefined;
  let onCapture: (() => void | Promise<void>) | undefined;
  let status: "ready" | "loading" | "not_logged_in" = "ready";
  let onCreate: ((binding: PageBinding) => void) | undefined;
  let onReload: ((tabId: number) => void) | undefined;
  let reloadUrl: string | undefined;
  const navigated: Array<{ tabId: number; url: string }> = [];
  let onUpdate: ((binding: PageBinding) => void | Promise<void>) | undefined;
  let savedTargetUrl: string | undefined;
  let captureEnded = true;
  let captureReply: unknown[] | undefined;
  const reloaded: number[] = [];
  const frameDocuments = new Map<number, string>();
  let lookupError: Error | undefined;
  let lookupTabId: number | undefined;
  let updated: ((tabId: number, status: "loading" | "complete") => void) | undefined;
  let resolveFrame:
    | ((tabId: number) => Promise<{ documentId?: string; url?: string } | null | undefined>)
    | undefined;
  let onGroupQuery: (() => void) | undefined;
  let onConnectStatus: (() => void | Promise<void>) | undefined;
  let groupTabsFilter: (
    values: Array<{ id: number; url: string }>,
  ) => Array<{ id: number; url: string }> = (values) => values;
  let observeCreated = true;
  let id = 10;
  const eventTarget = new EventTarget();
  const channelId = crypto.randomUUID();
  const eventNames = { fromIsolated: `${channelId}:isolated`, fromMain: `${channelId}:main` };
  const providerEndpoint = createPageEndpoint({
    target: eventTarget,
    channelId,
    side: "main",
    eventNames,
  });
  const clientEndpoint = createPageEndpoint({
    target: eventTarget,
    channelId,
    side: "isolated",
    eventNames,
  });
  fixtureCleanup.push(() => {
    providerEndpoint.close();
    clientEndpoint.close();
  });
  const provider = new Nexus()
    .provide(homePageToken, {
      async isReady() {
        return wire(homeIsReadyResultCodec, Result.ok(true));
      },
      async openDraftList() {
        return wire(openDraftListResultCodec, Result.ok(targetUrl));
      },
    })
    .provide(draftPageToken, {
      async listDrafts() {
        return wire(
          listDraftsResultCodec,
          Result.ok([
            { candidate: "g1", title: "Draft" },
            { candidate: "g2", title: "Other draft" },
          ]),
        );
      },
      async validateDraft() {
        return wire(validateDraftResultCodec, Result.ok({ valid: true, title: "Draft" }));
      },
      async currentItemCount() {
        return wire(currentItemCountResultCodec, Result.ok(1));
      },
    })
    .configure({
      endpoint: {
        implementation: providerEndpoint,
        meta: { app: { protocolVersion } },
      },
    });
  const client = new Nexus().configure({
    endpoint: {
      implementation: clientEndpoint,
      meta: { app: { protocolVersion } },
    },
  });
  const manager = createPageManager(
    api({
      async queryAllTabs() {
        return [...tabs.values()];
      },
      async queryMpTabs() {
        return [...tabs.values()];
      },
      async queryGroup() {
        onGroupQuery?.();
        return groupTabsFilter([...tabs.values()]);
      },
      async getTab(tabId: number) {
        const tab = tabs.get(tabId)!;
        frameLookup?.({
          tabId,
          documentId: tabId < 10 ? `source-${tabId}` : `target-${tabId}`,
          url: tab.url,
        });
        if (lookupError && (lookupTabId === undefined || lookupTabId === tabId)) throw lookupError;
        return tabs.get(tabId)!;
      },
      ...(frameApi
        ? {
            async getFrame({ tabId }: { tabId: number }) {
              if (resolveFrame) return resolveFrame(tabId);
              const tab = tabs.get(tabId);
              return {
                documentId:
                  frameDocuments.get(tabId) ?? (tabId < 10 ? `source-${tabId}` : `target-${tabId}`),
                url: tab?.url,
              };
            },
          }
        : {}),
      onTabUpdated(listener: typeof updated) {
        updated = listener;
      },
      async executeMain({ args }: { args?: string[] }) {
        await onCapture?.();
        if (captureReply) return captureReply;
        return [
          {
            result: {
              kind: "captured",
              url: args ? savedUrl.replace("appmsgid=g1", `appmsgid=${args[0]}`) : targetUrl,
              ...(args && savedTargetUrl !== undefined ? { url: savedTargetUrl } : {}),
              ended: captureEnded,
            },
          },
        ];
      },
      async reloadTab(tabId: number) {
        reloaded.push(tabId);
        if (reloadUrl) tabs.get(tabId)!.url = reloadUrl;
        const documentId = `reloaded-${tabId}-${reloaded.length}`;
        frameDocuments.set(tabId, documentId);
        beforeNavigate?.({ tabId, frameId: 0 });
        committed?.({ tabId, frameId: 0, documentId });
        manager.observe({ tabId, documentId, url: tabs.get(tabId)!.url });
        onReload?.(tabId);
      },
      async updateTab(tabId: number, { url }: { url: string }) {
        navigated.push({ tabId, url });
        tabs.get(tabId)!.url = url;
        const binding = { tabId, documentId: `updated-${tabId}-${navigated.length}`, url };
        frameDocuments.set(tabId, binding.documentId);
        beforeNavigate?.({ tabId, frameId: 0 });
        committed?.({ tabId, frameId: 0, documentId: binding.documentId });
        manager.observe(binding);
        await onUpdate?.(binding);
      },
      async createTab({ url }: { url: string }) {
        created.push(url);
        const tab = { id: id++, url };
        tabs.set(tab.id, tab);
        const binding = { tabId: tab.id, documentId: `target-${tab.id}`, url };
        if (observeCreated) manager.observe(binding);
        onCreate?.(binding);
        return tab;
      },
      onBeforeNavigate(listener: typeof beforeNavigate) {
        beforeNavigate = listener;
      },
      onCommitted(listener: typeof committed) {
        committed = listener;
      },
    }) as never,
    undefined,
    async (binding) => {
      onStatus?.(binding);
      return { state: status, route: appmsgRouteIdentity(binding.url)!, documentReady: true };
    },
    async () => [
      { candidate: "g1", title: "Draft" },
      { candidate: "g2", title: "Other draft" },
    ],
    async () => {
      await onConnectStatus?.();
      await Promise.all([provider.ready(), client.ready()]);
      const connected = await client.safeConnect({ target: {} });
      if (Result.isError(connected)) throw connected.error;
      return connected.value;
    },
  );
  const home = { tabId: 1, documentId: "source-1", url: homeUrl };
  const list = { tabId: 2, documentId: "source-2", url: draftListUrl };
  manager.observe(home);
  manager.observe(list);
  return {
    manager,
    tabs,
    created,
    reloaded,
    navigated,
    onUpdate(fn: typeof onUpdate) {
      onUpdate = fn;
    },
    setSavedTargetUrl(value: string) {
      savedTargetUrl = value;
    },
    setCaptureEnded(value: boolean) {
      captureEnded = value;
    },
    setCaptureReply(value: unknown[]) {
      captureReply = value;
    },
    home,
    list,
    setTargetUrl(value: string) {
      targetUrl = value;
    },
    setStatus(value: typeof status) {
      status = value;
    },
    onStatus(fn: typeof onStatus) {
      onStatus = fn;
    },
    onLookup(fn: typeof frameLookup) {
      frameLookup = fn;
    },
    onCapture(fn: typeof onCapture) {
      onCapture = fn;
    },
    onCreate(fn: typeof onCreate) {
      onCreate = fn;
    },
    onReload(fn: typeof onReload) {
      onReload = fn;
    },
    setReloadUrl(url: string) {
      reloadUrl = url;
    },
    removeListTab() {
      tabs.delete(2);
    },
    setLookupError(value: Error, tabId?: number) {
      lookupError = value;
      lookupTabId = tabId;
    },
    setFrameResolver(resolver: typeof resolveFrame) {
      resolveFrame = resolver;
    },
    onGroupQuery(fn: typeof onGroupQuery) {
      onGroupQuery = fn;
    },
    onConnectStatus(fn: typeof onConnectStatus) {
      onConnectStatus = fn;
    },
    setGroupTabsFilter(filter: typeof groupTabsFilter) {
      groupTabsFilter = filter;
    },
    loading(tabId: number) {
      updated?.(tabId, "loading");
    },
    delayObservation() {
      observeCreated = false;
    },
    navigate(tabId: number, documentId: string) {
      beforeNavigate?.({ tabId, frameId: 0 });
      committed?.({ tabId, frameId: 0, documentId });
    },
  };
}

describe("automatic navigation identity and bounded readiness", () => {
  test.each([
    ["rejection", () => Promise.reject(new Error("frame lookup rejected"))],
    ["missing frame", () => Promise.resolve(undefined)],
    ["absent document ID", () => Promise.resolve({})],
    [
      "synchronous throw",
      () => {
        throw new Error("frame lookup threw");
      },
    ],
  ])("settles and invalidates the observed binding after getFrame %s", async (_label, lookup) => {
    const f = navigationFixture();
    const old = f.list;
    f.setFrameResolver(lookup);
    f.loading(old.tabId);
    await Promise.resolve();
    await Promise.resolve();

    expect(await f.manager.isCurrent(old)).toMatchObject({ value: false });

    f.setFrameResolver(undefined);
    f.manager.observe({ ...old, documentId: "reobserved-document" });
    const fresh = { ...old, documentId: "reobserved-document" };
    expect(await f.manager.isCurrent(old)).toMatchObject({ value: false });
    expect(await f.manager.isCurrent(fresh)).toMatchObject({ value: true });
  });

  test("settles as unavailable when the getFrame seam is absent", async () => {
    const f = navigationFixture(false);
    f.loading(f.list.tabId);
    expect(await f.manager.isCurrent(f.list)).toMatchObject({ value: false });
    const fresh = { ...f.list, documentId: "fresh-after-missing-frame-api" };
    f.manager.observe(fresh);
    expect(await f.manager.isCurrent(f.list)).toMatchObject({ value: false });
    expect(await f.manager.isCurrent(fresh)).toMatchObject({ value: true });
  });

  test("an older failed getFrame check cannot clear a newer pending check", async () => {
    const f = navigationFixture();
    const oldLookup = deferred<{ documentId?: string } | null>();
    const newLookup = deferred<{ documentId?: string } | null>();
    let count = 0;
    f.setFrameResolver(() => (++count === 1 ? oldLookup.promise : newLookup.promise));
    f.loading(f.list.tabId);
    f.loading(f.list.tabId);
    oldLookup.reject(new Error("old lookup failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(await f.manager.isCurrent(f.list)).toMatchObject({ value: false });

    newLookup.resolve({ documentId: f.list.documentId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await f.manager.isCurrent(f.list)).toMatchObject({ value: true });
  });

  test("current lookup does not erase a document while its frame identity check is pending", async () => {
    const f = navigationFixture();
    const binding = { tabId: 3, documentId: "saved-document", url: savedUrl };
    f.tabs.set(binding.tabId, { id: binding.tabId, url: binding.url });
    f.manager.observe(binding);
    unwrap(await f.manager.managedGroup());
    const frame = deferred<{ documentId: string; url: string }>();
    f.setFrameResolver(() => frame.promise);
    f.loading(binding.tabId);
    expect(await f.manager.findCurrentEditor()).toEqual(Result.err({ code: "target_unavailable" }));
    frame.resolve({ documentId: binding.documentId, url: binding.url });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await f.manager.isCurrent(binding)).toEqual(Result.ok(true));
    expect(await f.manager.findCurrentEditor()).toEqual(Result.ok(binding));
    expect(f.created).toEqual([]);
  });

  test("new refuses to duplicate or overwrite the existing new-editor page", async () => {
    const f = navigationFixture();
    f.tabs.set(3, { id: 3, url: editorPageUrl });
    f.manager.observe({ tabId: 3, documentId: "existing", url: editorPageUrl });
    expect(await f.manager.ensureEditorTab()).toMatchObject({
      error: { code: "target_ambiguous" },
    });
    expect(f.created).toHaveLength(0);
    expect(f.tabs.get(3)?.url).toBe(editorPageUrl);
  });
  test("checks all eligible homes for ambiguity, including homes outside the group", async () => {
    const f = navigationFixture();
    f.tabs.set(4, { id: 4, url: homeUrl });
    f.manager.observe({ tabId: 4, documentId: "other-account", url: homeUrl });
    expect(await f.manager.findManagedHome()).toMatchObject({
      error: { code: "navigation_failed", stage: "source_ambiguous" },
    });
    expect(f.created).toHaveLength(0);
  });
  test("source replacement during native capture prevents creating a target", async () => {
    const f = navigationFixture();
    f.onCapture(() => f.manager.observe({ ...f.home, documentId: "replacement" }));
    expect(await f.manager.ensureEditorTab()).toMatchObject({
      error: { code: "navigation_failed", stage: "source_changed" },
    });
    expect(f.created).toHaveLength(0);
  });
  test("allows only timestamp changes in the final native target URL", async () => {
    const f = navigationFixture();
    f.onCreate((binding) => {
      const url = binding.url.replace("timestamp=before", "timestamp=after");
      f.tabs.set(binding.tabId, { id: binding.tabId, url });
      f.manager.observe({ ...binding, url });
    });
    expect(unwrap(await f.manager.ensureEditorTab()).url).toContain("timestamp=after");
  });
  for (const mutation of [
    (url: string) => url.replace("token=context", "token=changed"),
    (url: string) => `${url}#changed`,
    (url: string) => `${url}&createType=changed`,
  ])
    test("rejects final context or fragment drift despite the same semantic editor route", async () => {
      const f = navigationFixture();
      f.onCreate((binding) => {
        const url = mutation(binding.url);
        f.tabs.set(binding.tabId, { id: binding.tabId, url });
        f.manager.observe({ ...binding, url });
      });
      expect(await f.manager.ensureEditorTab()).toMatchObject({
        error: { code: "navigation_failed", stage: "target_not_ready" },
      });
    });
  test("first target document replacement while status is awaited cannot become ready", async () => {
    const f = navigationFixture();
    f.onStatus((binding) => {
      if (binding.tabId >= 10) f.manager.observe({ ...binding, documentId: "replacement" });
    });
    expect(await f.manager.ensureEditorTab()).toMatchObject({
      error: { code: "navigation_failed", stage: "target_not_ready" },
    });
  });
  test("login timeout at target readiness rejects instead of adopting another page", async () => {
    const f = navigationFixture();
    f.onCreate(() => f.setStatus("not_logged_in"));
    expect(await f.manager.ensureEditorTab()).toMatchObject({
      error: { code: "not_logged_in", pageCreated: true },
    });
  });
  test("saved target login failure carries pageCreated without a fabricated stage", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.onCreate(() => f.setStatus("not_logged_in"));
    expect(await f.manager.openDraftGroup(f.list, "g1")).toMatchObject({
      error: { code: "not_logged_in", pageCreated: true },
    });
  });
  test("saved target lookup failure carries pageCreated and keeps page_failed", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.setLookupError(new Error("target lookup unavailable"), 10);
    expect(await f.manager.openDraftGroup(f.list, "g1")).toMatchObject({
      error: { code: "page_failed", pageCreated: true },
    });
  });
  test("target lookup failure preserves page-created fact without inventing a navigation stage", async () => {
    const f = navigationFixture();
    f.setLookupError(new Error("lookup unavailable"), 10);
    expect(await f.manager.ensureEditorTab()).toMatchObject({
      error: { code: "page_failed", pageCreated: true },
    });
  });
  test("unknown Chrome lookup remains a lookup failure when the binding did not change", async () => {
    const f = navigationFixture();
    const error = new Error("indeterminate");
    f.setLookupError(error);
    expect(await f.manager.isCurrent(f.list)).toMatchObject({ error: { code: "page_failed" } });
  });
  test("lookup completion cannot return an old document or revived A-B-A route", async () => {
    const f = navigationFixture();
    let switched = false;
    f.onLookup(() => {
      if (switched) return;
      switched = true;
      f.manager.observe({ ...f.list, url: draftListUrl.replace("begin=0", "begin=10") });
      f.manager.observe(f.list);
    });
    expect(unwrap(await f.manager.isCurrent(f.list))).toBe(false);
  });
  test("navigation barrier rejects old document before the replacement is observed", async () => {
    const f = navigationFixture();
    f.navigate(2, "new-list-document");
    expect(unwrap(await f.manager.isCurrent(f.list))).toBe(false);
    f.manager.observe({ ...f.list, documentId: "new-list-document" });
    expect(unwrap(await f.manager.isCurrent({ ...f.list, documentId: "new-list-document" }))).toBe(
      true,
    );
  });
  test("list refuses a document change or timeout appearing during group inspection", async () => {
    const f = navigationFixture();
    let calls = 0;
    f.onStatus((binding) => {
      if (binding.tabId === 2 && ++calls === 2)
        f.manager.observe({ ...binding, documentId: "replaced-list" });
    });
    expect(await f.manager.listDraftGroups(f.list)).toMatchObject({
      error: { code: "target_unavailable" },
    });
    const timeout = navigationFixture();
    let reads = 0;
    timeout.onStatus(() => {
      if (++reads === 2) timeout.setStatus("not_logged_in");
    });
    expect(await timeout.manager.listDraftGroups(timeout.list)).toMatchObject({
      error: { code: "not_logged_in" },
    });
  });
  test("saved open waits for the captured group and rejects final target drift", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    const binding = unwrap(await f.manager.openDraftGroup(f.list, "g1"));
    expect(binding?.tabId).toBe(10);
    const drift = navigationFixture();
    unwrap(await drift.manager.managedGroup());
    drift.onCreate((binding) =>
      drift.tabs.set(binding.tabId, {
        id: binding.tabId,
        url: savedUrl.replace("context", "changed"),
      }),
    );
    expect(await drift.manager.openDraftGroup(drift.list, "g1")).toMatchObject({
      error: { code: "navigation_failed", stage: "target_not_ready", pageCreated: true },
    });
  });
  test("repeated ordinary opens reuse the same saved editor without adding tabs", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    const first = unwrap(await f.manager.openDraftGroup(f.list, "g1"));
    const second = unwrap(await f.manager.openDraftGroup(f.list, "g1"));
    expect(second).toEqual(first);
    expect(f.created).toHaveLength(1);
  });

  test("same-draft identity ignores timestamp but never reloads existing unsaved content", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    const existing = { tabId: 3, documentId: "source-3", url: `${savedUrl}&timestamp=other` };
    f.tabs.set(3, { id: 3, url: existing.url });
    f.manager.observe(existing);
    expect(unwrap(await f.manager.openDraftGroup(f.list, "g1"))).toEqual(existing);
    expect(f.created).toHaveLength(0);
    expect(f.reloaded).toHaveLength(0);
    expect(f.navigated).toHaveLength(0);
  });

  test("relogin opens the unique expired saved tab once at the exact native fresh URL", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.list.url += "&token=context";
    f.tabs.get(2)!.url = f.list.url;
    f.manager.observe(f.list);
    const old = {
      tabId: 3,
      documentId: "source-3",
      url: savedUrl.replace("context", "old-context"),
    };
    f.tabs.set(3, { id: 3, url: old.url });
    f.manager.observe(old);
    f.onStatus((binding) =>
      f.setStatus(binding.documentId === old.documentId ? "not_logged_in" : "ready"),
    );
    const reservations: string[] = [],
      bound: string[] = [];
    const progress: import("../src/pages").NavigationProgress = {
      dispatch: async (_: string, action) => action(),
      created: async () => {},
      sourceReady() {},
      uncertain() {},
      bound: async (binding: PageBinding) => {
        bound.push(binding.documentId);
      },
      reloading: (binding: PageBinding) => {
        reservations.push(binding.documentId);
        return (fresh: PageBinding) => {
          reservations.push(fresh.documentId);
        };
      },
    };
    const fresh = unwrap(await f.manager.openDraftGroup(f.list, "g1", progress));
    expect(fresh).toMatchObject({ tabId: 3, documentId: "updated-3-1", url: savedUrl });
    expect(f.navigated).toEqual([{ tabId: 3, url: savedUrl }]);
    expect(f.created).toHaveLength(0);
    expect(f.reloaded).toHaveLength(0);
    expect(bound).toEqual(["updated-3-1"]);
    expect(reservations).toEqual([old.documentId, "updated-3-1"]);
    expect(unwrap(await f.manager.isCurrent(old))).toBe(false);
  });

  test("relogin refreshes only the expired owned list from the ready HOME native link", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    const target = `${draftListUrl}&lang=en_US&token=context`;
    f.setTargetUrl(target);
    f.onStatus((binding) =>
      f.setStatus(binding.documentId === f.list.documentId ? "not_logged_in" : "ready"),
    );
    expect(unwrap(await f.manager.ensureDraftList())).toMatchObject({
      tabId: 2,
      documentId: "updated-2-1",
      url: target,
    });
    expect(f.navigated).toEqual([{ tabId: 2, url: target }]);
    expect(f.created).toHaveLength(0);
    expect(f.reloaded).toHaveLength(0);
  });

  test.each([
    "ready",
    "loading",
    "capture-missing",
    "capture-unended",
    "capture-empty",
    "capture-malformed",
    "capture-unended-not-dispatched",
    "wrong-candidate",
    "duplicate",
    "source-token",
    "source-document",
    "candidate-membership",
    "source-expired",
    "target-group",
    "target-ready",
    "target-token",
    "target-unbound",
    "target-navigation",
    "membership",
    "source-preflight-yield",
    "dispatch-checkpoint",
  ] as const)("relogin %s guard preserves the editor with zero navigation", async (mode) => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.list.url += "&token=context";
    f.tabs.get(2)!.url = f.list.url;
    f.manager.observe(f.list);
    const old = {
      tabId: 3,
      documentId: "source-3",
      url: savedUrl.replace("context", "old-context"),
    };
    f.tabs.set(3, { id: 3, url: old.url });
    f.manager.observe(old);
    let becameReady = mode === "ready";
    f.onStatus((binding) =>
      f.setStatus(
        binding.documentId === old.documentId
          ? becameReady
            ? "ready"
            : mode === "loading"
              ? "loading"
              : "not_logged_in"
          : "ready",
      ),
    );
    if (mode === "capture-missing") f.setSavedTargetUrl("");
    if (mode === "capture-unended") f.setCaptureEnded(false);
    if (mode === "capture-empty") f.setCaptureReply([]);
    if (mode === "capture-malformed")
      f.setCaptureReply([{ result: { kind: "captured", url: 123, ended: "true" } }]);
    if (mode === "capture-unended-not-dispatched")
      f.setCaptureReply([
        { result: { kind: "captured", url: savedUrl, ended: false, notDispatched: true } },
      ]);
    if (mode === "wrong-candidate")
      f.setSavedTargetUrl(savedUrl.replace("appmsgid=g1", "appmsgid=g2"));
    if (mode === "duplicate") f.tabs.set(4, { id: 4, url: old.url });
    let sourcePreflightChanged = false;
    f.onCapture(() => {
      if (mode === "source-token") {
        const url = f.list.url.replace("token=context", "token=changed");
        f.tabs.get(2)!.url = url;
        f.manager.observe({ ...f.list, url });
      }
      if (mode === "source-document") f.manager.observe({ ...f.list, documentId: "other-list" });
      if (mode === "candidate-membership")
        f.manager.listDraftGroups = async () => Result.ok([{ groupId: "g2", title: "Other" }]);
      if (mode === "source-expired") f.onStatus(() => f.setStatus("not_logged_in"));
      if (mode === "target-group") {
        const url = old.url.replace("appmsgid=g1", "appmsgid=g2");
        f.tabs.get(3)!.url = url;
        f.manager.observe({ ...old, url });
      }
      if (mode === "target-ready") becameReady = true;
      if (mode === "target-token") {
        f.tabs.get(3)!.url += "&lang=en_US";
        f.manager.observe({ ...old, url: f.tabs.get(3)!.url });
      }
      if (mode === "target-unbound")
        f.manager.observe({ ...old, url: "https://mp.weixin.qq.com/cgi-bin/loginpage" });
      if (mode === "target-navigation") f.navigate(3, "another-target");
      if (mode === "membership") f.setGroupTabsFilter((tabs) => tabs.filter((tab) => tab.id !== 3));
      if (mode === "source-preflight-yield") {
        f.onLookup((binding) => {
          if (binding.tabId !== f.list.tabId) return;
          f.onLookup(undefined);
          sourcePreflightChanged = true;
          const url = f.list.url.replace("token=context", "token=changed");
          f.tabs.get(2)!.url = url;
          f.manager.observe({ ...f.list, url });
        });
      }
    });
    const uncertainties: string[] = [];
    const progress: import("../src/pages").NavigationProgress = {
      dispatch: async (code, action) => {
        if (mode === "dispatch-checkpoint" && code === "relogin_navigation") becameReady = true;
        return action();
      },
      sourceReady() {},
      uncertain(code) {
        uncertainties.push(code);
      },
      created: async () => {},
      bound: async () => {},
    };
    const result = await f.manager.openDraftGroup(f.list, "g1", progress);
    if (mode === "ready") expect(result.isOk()).toBe(true);
    else expect(result.isErr()).toBe(true);
    if (mode === "source-preflight-yield") expect(sourcePreflightChanged).toBe(true);
    if (["capture-empty", "capture-malformed", "capture-unended-not-dispatched"].includes(mode))
      expect(uncertainties).toEqual(["native_capture_end_unverified"]);
    expect(f.navigated).toHaveLength(0);
    expect(f.reloaded).toHaveLength(0);
    expect(f.created).toHaveLength(0);
  });

  test.each([
    "wrong-first-url",
    "wrong-then-correct",
    "old-document",
    "second-document",
    "second-token",
    "bound-drift",
    "lost-reply",
  ] as const)(
    "relogin %s after issue never accepts a stale target or repeats navigation",
    async (mode) => {
      const f = navigationFixture();
      unwrap(await f.manager.managedGroup());
      f.list.url += "&token=context";
      f.tabs.get(2)!.url = f.list.url;
      f.manager.observe(f.list);
      const old = {
        tabId: 3,
        documentId: "source-3",
        url: savedUrl.replace("context", "old-context"),
      };
      f.tabs.set(3, { id: 3, url: old.url });
      f.manager.observe(old);
      let changed = false;
      f.onStatus((binding) => {
        f.setStatus(binding.documentId === old.documentId ? "not_logged_in" : "ready");
        if (
          binding.documentId.startsWith("updated") &&
          !changed &&
          (mode === "second-document" || mode === "second-token")
        ) {
          changed = true;
          const url =
            mode === "second-token" ? binding.url.replace("context", "other") : binding.url;
          f.tabs.get(3)!.url = url;
          f.manager.observe({
            ...binding,
            url,
            documentId: mode === "second-document" ? "second-document" : binding.documentId,
          });
        }
      });
      f.onUpdate((binding) => {
        if (mode === "wrong-first-url") {
          f.tabs.get(3)!.url = binding.url.replace("context", "other");
          f.manager.observe({ ...binding, url: f.tabs.get(3)!.url });
        }
        if (mode === "lost-reply") throw new Error("update delivery lost");
        if (mode === "old-document") f.manager.observe(old);
        if (mode === "wrong-then-correct") {
          const url = binding.url.replace("context", "other");
          f.tabs.get(3)!.url = url;
          f.manager.observe({ ...binding, url });
          f.tabs.get(3)!.url = binding.url;
          f.manager.observe(binding);
        }
      });
      let ended = 0;
      const progress: import("../src/pages").NavigationProgress = {
        dispatch: async (_, action) => action(),
        uncertain() {},
        sourceReady() {},
        created: async () => {},
        bound: async () => {
          if (mode === "bound-drift") {
            const url = f.list.url.replace("context", "other");
            f.tabs.get(2)!.url = url;
            f.manager.observe({ ...f.list, url });
          }
        },
        reloading: () => () => {
          ended++;
        },
      };
      expect((await f.manager.openDraftGroup(f.list, "g1", progress)).isErr()).toBe(
        mode !== "old-document",
      );
      expect(f.navigated).toEqual([{ tabId: 3, url: savedUrl }]);
      expect(ended).toBe(mode === "old-document" ? 1 : 0);
      expect(f.created).toHaveLength(0);
      expect(f.reloaded).toHaveLength(0);
    },
  );

  test.each([
    "ready-list",
    "no-home",
    "expired-home",
    "home-token-drift",
    "bad-native-list",
  ] as const)("relogin list dependency %s never duplicates or guesses a source", async (mode) => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    const target = `${draftListUrl}&lang=en_US&token=context`;
    f.setTargetUrl(target);
    if (mode === "no-home") f.tabs.delete(1);
    if (mode === "bad-native-list") f.setTargetUrl(savedUrl);
    f.onStatus((binding) =>
      f.setStatus(
        mode === "ready-list"
          ? "ready"
          : (binding.tabId === 2 && binding.documentId === f.list.documentId) ||
              (mode === "expired-home" && binding.tabId === 1)
            ? "not_logged_in"
            : "ready",
      ),
    );
    f.onConnectStatus(() => {
      if (mode === "home-token-drift") {
        const url = homeUrl.replace("context", "drift");
        f.tabs.get(1)!.url = url;
        f.manager.observe({ ...f.home, url });
      }
    });
    const result = await f.manager.ensureDraftList();
    expect(result.isOk()).toBe(mode === "ready-list");
    expect(f.navigated).toHaveLength(0);
    expect(f.created).toHaveLength(0);
    expect(f.reloaded).toHaveLength(0);
  });

  test("concurrent new requests cannot create two new-editor pages", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    const results = await Promise.all([f.manager.ensureEditorTab(), f.manager.ensureEditorTab()]);
    expect(results.filter(Result.isOk)).toHaveLength(1);
    expect(results.filter(Result.isError)).toHaveLength(1);
    expect(f.created).toHaveLength(1);
  });

  test("concurrent ordinary opens share one creation and do not overwrite an editor", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    const [first, second] = await Promise.all([
      f.manager.openDraftGroup(f.list, "g1"),
      f.manager.openDraftGroup(f.list, "g1"),
    ]);
    expect(unwrap(first)).toEqual(unwrap(second));
    expect(f.created).toHaveLength(1);
  });

  test("an existing unbound editor is preserved instead of replaced or duplicated", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.tabs.set(3, { id: 3, url: savedUrl });
    expect(await f.manager.openDraftGroup(f.list, "g1")).toEqual(
      Result.err({ code: "target_unavailable" }),
    );
    expect(f.created).toHaveLength(0);
    expect(f.tabs.get(3)?.url).toBe(savedUrl);
  });

  test("a second existing home/list role is never created to bypass source ambiguity", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.tabs.set(4, { id: 4, url: homeUrl });
    f.manager.observe({ tabId: 4, documentId: "second-home", url: homeUrl });
    expect(await f.manager.ensureManagedHome()).toEqual(Result.err({ code: "target_ambiguous" }));
    expect(f.created).toHaveLength(0);
  });

  test("distinct pages are not refused by an arbitrary total tab limit", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    for (let id = 3; id <= 8; id++)
      f.tabs.set(id, { id, url: `https://example.test/preserved-${id}` });
    expect(Result.isOk(await f.manager.ensureEditorTab())).toBe(true);
    expect(f.created).toHaveLength(1);
    expect(f.tabs.size).toBe(9);
  });

  test("concurrent opens from different list documents cannot create duplicate drafts", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    const otherList = { tabId: 3, documentId: "source-3", url: draftListUrl };
    f.tabs.set(3, { id: 3, url: draftListUrl });
    f.manager.observe(otherList);
    const results = await Promise.all([
      f.manager.openDraftGroup(f.list, "g1"),
      f.manager.openDraftGroup(otherList, "g1"),
    ]);
    expect(results.filter(Result.isOk)).toHaveLength(1);
    expect(results.filter(Result.isError)).toHaveLength(1);
    expect(f.created).toHaveLength(1);
    expect(f.tabs.size).toBe(4);
  });

  test("save refuses duplicate same-draft tabs before acquiring the native save capability", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    const binding = { tabId: 3, documentId: "saved-document", url: savedUrl };
    f.tabs.set(3, { id: 3, url: savedUrl });
    f.manager.observe(binding);
    f.tabs.set(4, { id: 4, url: savedUrl });
    expect(await f.manager.saveArticle(binding, saveExecution())).toEqual(
      Result.err({
        code: "target_ambiguous",
        cause: { at: "bg.page_connect", kind: "domain", code: "target_ambiguous" },
        notInvoked: true,
      }),
    );
    expect(f.created).toHaveLength(0);
  });

  test("ordinary saved open still refuses SAVE-only context rewrite at target readiness", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.onCreate((binding) => {
      if (binding.tabId >= 10) {
        f.tabs.get(binding.tabId)!.url = `${binding.url}&reprint_confirm=0`;
        f.manager.observe({ ...binding, url: `${binding.url}&reprint_confirm=0` });
      }
    });
    expect(await f.manager.openDraftGroup(f.list, "g1")).toMatchObject({
      error: { code: "navigation_failed", stage: "target_not_ready" },
    });
    expect(f.reloaded).toHaveLength(0);
    expect(f.created).toHaveLength(1);
  });

  test("saved editor replacement during final readiness cannot issue the old binding", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.onStatus((binding) => {
      if (binding.tabId >= 10) f.manager.observe({ ...binding, documentId: "saved-replacement" });
    });
    expect(await f.manager.openDraftGroup(f.list, "g1")).toMatchObject({
      error: { code: "navigation_failed", pageCreated: true },
    });
  });
  test("saved target observed before navigation commit waits for that same document", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.onCreate(() => {
      f.navigate(10, "target-10");
      setTimeout(
        () => f.manager.observe({ tabId: 10, documentId: "target-10", url: savedUrl }),
        20,
      );
    });
    expect(unwrap(await f.manager.openDraftGroup(f.list, "g1"))?.documentId).toBe("target-10");
  });
  test("committed saved document waits for its first content session instead of failing early", async () => {
    const f = navigationFixture();
    f.delayObservation();
    unwrap(await f.manager.managedGroup());
    f.onCreate(() => {
      f.navigate(10, "target-10");
      setTimeout(
        () => f.manager.observe({ tabId: 10, documentId: "target-10", url: savedUrl }),
        20,
      );
    });
    expect(unwrap(await f.manager.openDraftGroup(f.list, "g1"))?.documentId).toBe("target-10");
  });
  test("concurrent distinct draft opens keep request-local target documents", async () => {
    const f = navigationFixture();
    f.delayObservation();
    unwrap(await f.manager.managedGroup());
    f.onCreate((binding) =>
      setTimeout(() => f.manager.observe(binding), binding.tabId === 10 ? 30 : 5),
    );
    const [a, b] = (
      await Promise.all([
        f.manager.openDraftGroup(f.list, "g1"),
        f.manager.openDraftGroup(f.list, "g2"),
      ])
    ).map(unwrap);
    expect(a?.tabId).not.toBe(b?.tabId);
    expect([a?.documentId, b?.documentId].sort()).toEqual(["target-10", "target-11"]);
    expect(f.created).toHaveLength(2);
  });
  test("saved native capture hooks are serialized per source while each request keeps its own result", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    let active = 0;
    let maximum = 0;
    f.onCapture(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
    });
    const results = await Promise.all([
      f.manager.openDraftGroup(f.list, "g1"),
      f.manager.openDraftGroup(f.list, "g2"),
    ]);
    expect(maximum).toBe(1);
    expect(new Set(results.map((result) => unwrap(result)?.tabId)).size).toBe(2);
  });
  test("current refuses two existing editors even if only one has an observed session", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.tabs.set(3, { id: 3, url: editorPageUrl });
    f.tabs.set(4, { id: 4, url: editorPageUrl });
    f.manager.observe({ tabId: 3, documentId: "existing", url: editorPageUrl });
    expect(await f.manager.findCurrentEditor()).toMatchObject({
      error: { code: "target_ambiguous" },
    });
    expect(f.created).toHaveLength(0);
  });
  test("current uses the sole existing editor document without capture or creating a tab", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.tabs.set(3, { id: 3, url: editorPageUrl });
    f.manager.observe({ tabId: 3, documentId: "sole-existing", url: editorPageUrl });
    const binding = unwrap(await f.manager.findCurrentEditor());
    expect(binding?.documentId).toBe("sole-existing");
    expect(f.created).toHaveLength(0);
  });
  test("cold current observes a sole Chrome-confirmed editor frame before connecting", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.tabs.set(3, { id: 3, url: savedUrl });
    f.setFrameResolver(async (tabId) => ({
      documentId: tabId === 3 ? "cold-saved" : "list-doc",
      url: tabId === 3 ? savedUrl : draftListUrl,
    }));
    const found = await f.manager.findCurrentEditor();
    expect(found).toMatchObject({ value: { tabId: 3, documentId: "cold-saved", url: savedUrl } });
  });
  test("cold current refuses frame-route drift and duplicate editor tabs", async () => {
    const drift = navigationFixture();
    unwrap(await drift.manager.managedGroup());
    drift.tabs.set(3, { id: 3, url: savedUrl });
    drift.setFrameResolver(async (tabId) => ({
      documentId: tabId === 3 ? "cold-saved" : "list-doc",
      url: tabId === 3 ? `${savedUrl}&appmsgid=other` : draftListUrl,
    }));
    expect(await drift.manager.findCurrentEditor()).toMatchObject({
      error: { code: "target_unavailable" },
    });

    const duplicate = navigationFixture();
    unwrap(await duplicate.manager.managedGroup());
    duplicate.tabs.set(3, { id: 3, url: savedUrl });
    duplicate.tabs.set(4, { id: 4, url: savedUrl.replace("appmsgid=g1", "appmsgid=g2") });
    expect(await duplicate.manager.findCurrentEditor()).toMatchObject({
      error: { code: "target_ambiguous" },
    });
  });
  test("cold current rechecks managed membership after Chrome frame awaits", async () => {
    const moved = navigationFixture();
    unwrap(await moved.manager.managedGroup());
    moved.tabs.set(3, { id: 3, url: savedUrl });
    let movedConnects = 0;
    moved.onConnectStatus(() => {
      movedConnects++;
    });
    let releaseFrame!: () => void;
    const frameGate = new Promise<void>((resolve) => (releaseFrame = resolve));
    let frameCalls = 0;
    moved.setFrameResolver(async (tabId) => {
      if (tabId === 3 && ++frameCalls === 1) {
        await frameGate;
        moved.setGroupTabsFilter((values) => values.filter((tab) => tab.id !== 3));
      }
      return { documentId: "cold-saved", url: savedUrl };
    });
    const movedResult = moved.manager.findCurrentEditor();
    await Promise.resolve();
    releaseFrame();
    expect(await movedResult).toMatchObject({ error: { code: "target_unavailable" } });
    expect(movedConnects).toBe(0);

    const added = navigationFixture();
    unwrap(await added.manager.managedGroup());
    added.tabs.set(3, { id: 3, url: savedUrl });
    let addedConnects = 0;
    added.onConnectStatus(() => {
      addedConnects++;
    });
    let releaseSecondFrame!: () => void;
    const secondFrameGate = new Promise<void>((resolve) => (releaseSecondFrame = resolve));
    let addedFrameCalls = 0;
    added.setFrameResolver(async (tabId) => {
      if (tabId === 3 && ++addedFrameCalls === 1) {
        await secondFrameGate;
        added.tabs.set(4, { id: 4, url: savedUrl.replace("appmsgid=g1", "appmsgid=g2") });
      }
      return {
        documentId: tabId === 3 ? "cold-saved" : "second-editor",
        url: added.tabs.get(tabId)?.url,
      };
    });
    const addedResult = added.manager.findCurrentEditor();
    await Promise.resolve();
    releaseSecondFrame();
    expect(await addedResult).toMatchObject({ error: { code: "target_ambiguous" } });
    expect(addedConnects).toBe(0);

    const addedDuringConnect = navigationFixture();
    unwrap(await addedDuringConnect.manager.managedGroup());
    addedDuringConnect.tabs.set(3, { id: 3, url: savedUrl });
    addedDuringConnect.setFrameResolver(async () => ({ documentId: "cold-saved", url: savedUrl }));
    let releaseConnection!: () => void;
    const connectionGate = new Promise<void>((resolve) => (releaseConnection = resolve));
    addedDuringConnect.onConnectStatus(async () => {
      await connectionGate;
      addedDuringConnect.tabs.set(4, {
        id: 4,
        url: savedUrl.replace("appmsgid=g1", "appmsgid=g2"),
      });
    });
    const connectingResult = addedDuringConnect.manager.findCurrentEditor();
    await Promise.resolve();
    await Promise.resolve();
    releaseConnection();
    expect(await connectingResult).toMatchObject({ error: { code: "target_ambiguous" } });
  });
  test("current on an empty workspace does not create a tab or a workspace group", async () => {
    const f = navigationFixture();
    expect(unwrap(await f.manager.findCurrentEditor())).toBeUndefined();
    expect(f.created).toHaveLength(0);
  });
});

describe("page route and document identity", () => {
  test("explicit fresh draft-list ensure reloads the observed list and waits for its new document", async () => {
    const tabs = new Map([[2, { id: 2, url: draftListUrl }]]);
    let manager: ReturnType<typeof createPageManager>;
    let documentId = "cached-list";
    let reloads = 0;
    const created: string[] = [];
    manager = createPageManager(
      api({
        async queryGroups() {
          return [{ id: 7, title: "mpctl" }];
        },
        async queryGroup() {
          return [...tabs.values()];
        },
        async queryMpTabs() {
          return [...tabs.values()];
        },
        async getTab(id: number) {
          return tabs.get(id)!;
        },
        async getFrame({ tabId }: { tabId: number }) {
          return { documentId: tabId === 2 ? documentId : `doc-${tabId}` };
        },
        async reloadTab(id: number) {
          reloads++;
          expect(id).toBe(2);
          documentId = "fresh-list";
          manager.observe({ tabId: 2, documentId, url: draftListUrl });
        },
        async createTab({ url }: { url: string }) {
          created.push(url);
          return { id: 3, url };
        },
      }) as never,
      undefined,
      async () => ({
        state: "ready",
        route: appmsgRouteIdentity(draftListUrl)!,
        documentReady: true,
      }),
    );
    manager.observe({ tabId: 2, documentId, url: draftListUrl });

    const fresh = unwrap(await manager.ensureDraftList({ refresh: true }));

    expect(fresh.documentId).toBe("fresh-list");
    expect(reloads).toBe(1);
    expect(created).toEqual([]);
  });

  test("concurrent fresh draft-list ensures share one native reload", async () => {
    const tabs = new Map([[2, { id: 2, url: draftListUrl }]]);
    let manager: ReturnType<typeof createPageManager>;
    let documentId = "cached-list";
    let reloads = 0;
    let finishReload!: () => void;
    const reloadGate = new Promise<void>((resolve) => {
      finishReload = resolve;
    });
    manager = createPageManager(
      api({
        async queryGroups() {
          return [{ id: 7, title: "mpctl" }];
        },
        async queryGroup() {
          return [...tabs.values()];
        },
        async queryMpTabs() {
          return [...tabs.values()];
        },
        async getTab(id: number) {
          return tabs.get(id)!;
        },
        async getFrame({ tabId }: { tabId: number }) {
          return { documentId: tabId === 2 ? documentId : `doc-${tabId}` };
        },
        async reloadTab() {
          reloads++;
          await reloadGate;
          documentId = "fresh-list";
          manager.observe({ tabId: 2, documentId, url: draftListUrl });
        },
      }) as never,
      undefined,
      async () => ({
        state: "ready",
        route: appmsgRouteIdentity(draftListUrl)!,
        documentReady: true,
      }),
    );
    manager.observe({ tabId: 2, documentId, url: draftListUrl });

    const first = manager.ensureDraftList({ refresh: true });
    const second = manager.ensureDraftList({ refresh: true });
    finishReload();
    const bindings = [unwrap(await first), unwrap(await second)];

    expect(bindings.map((binding) => binding.documentId)).toEqual(["fresh-list", "fresh-list"]);
    expect(reloads).toBe(1);
  });

  test("fresh ensure acquires and returns a ready native list when none exists yet", async () => {
    const f = navigationFixture();
    f.removeListTab();
    f.setTargetUrl(draftListUrl);

    const binding = unwrap(await f.manager.ensureDraftList({ refresh: true }));

    expect(binding.tabId).toBeGreaterThan(2);
    expect(binding.documentId).toBe(`target-${binding.tabId}`);
    expect(binding.url).toBe(draftListUrl);
  });

  test("fresh ensure propagates a failed normal ensure already in flight", async () => {
    const f = navigationFixture();
    f.setStatus("not_logged_in");

    const normal = f.manager.ensureDraftList();
    const refresh = f.manager.ensureDraftList({ refresh: true });

    expect(await normal).toMatchObject({ error: { code: "not_logged_in" } });
    expect(await refresh).toMatchObject({ error: { code: "not_logged_in" } });
    expect(f.created).toHaveLength(0);
  });

  test("normal draft-list ensure keeps the cached ready document without reloading", async () => {
    const f = navigationFixture();
    expect(unwrap(await f.manager.ensureDraftList()).documentId).toBe(f.list.documentId);
  });

  test("a failed explicit refresh does not return the cached document or open another page", async () => {
    const tabs = new Map([[2, { id: 2, url: draftListUrl }]]);
    let manager: ReturnType<typeof createPageManager>;
    const created: string[] = [];
    manager = createPageManager(
      api({
        async queryGroups() {
          return [{ id: 7, title: "mpctl" }];
        },
        async queryGroup() {
          return [...tabs.values()];
        },
        async queryMpTabs() {
          return [...tabs.values()];
        },
        async getTab(id: number) {
          return tabs.get(id)!;
        },
        async getFrame() {
          return { documentId: "cached-list" };
        },
        async reloadTab() {
          throw new Error("reload failed");
        },
        async createTab({ url }: { url: string }) {
          created.push(url);
          return { id: 3, url };
        },
      }) as never,
      undefined,
      async () => ({
        state: "ready",
        route: appmsgRouteIdentity(draftListUrl)!,
        documentReady: true,
      }),
    );
    manager.observe({ tabId: 2, documentId: "cached-list", url: draftListUrl });

    expect(await manager.ensureDraftList({ refresh: true })).toMatchObject({
      error: { code: "page_failed" },
    });
    expect(created).toEqual([]);
  });

  test("recognizes only supported observed routes and binds route-bearing fields", () => {
    expect(classifyAppmsgUrl(draftListUrl).kind).toBe("draft-list");
    expect(isDraftListUrl(draftListUrl)).toBe(true);
    expect(classifyAppmsgUrl(editorPageUrl).kind).toBe("new");
    expect(isEditorPageUrl(editorPageUrl)).toBe(true);
    expect(classifyAppmsgUrl("https://example.test/article").kind).toBe("unsupported");
    expect(appmsgRouteIdentity(`${editorPageUrl}&token=changed`)).toBe(
      appmsgRouteIdentity(editorPageUrl),
    );
    expect(appmsgRouteIdentity(draftListUrl.replace("begin=0", "begin=10"))).not.toBe(
      appmsgRouteIdentity(draftListUrl),
    );
  });

  test("status connection is acquired for the exact current document", async () => {
    const connected: string[] = [];
    const manager = createPageManager(
      api({
        async getTab(id: number) {
          return { id, url: draftListUrl };
        },
      }) as never,
      undefined,
      undefined,
      undefined,
      async (binding) => {
        connected.push(binding.documentId);
        const target = new EventTarget();
        const channelId = crypto.randomUUID();
        const eventNames = { fromIsolated: `${channelId}:isolated`, fromMain: `${channelId}:main` };
        const provider = new Nexus()
          .provide(contentStatusToken, {
            async status() {
              return wire(
                contentStatusResultCodec,
                Result.ok({
                  state: "ready",
                  route: appmsgRouteIdentity(binding.url)!,
                  documentReady: true,
                }),
              );
            },
          })
          .configure({
            endpoint: {
              implementation: createPageEndpoint({ target, channelId, side: "main", eventNames }),
              meta: { app: { protocolVersion } },
            },
          });
        const client = new Nexus().configure({
          endpoint: {
            implementation: createPageEndpoint({ target, channelId, side: "isolated", eventNames }),
            meta: { app: { protocolVersion } },
          },
        });
        await Promise.all([provider.ready(), client.ready()]);
        const acquired = await client.safeConnect({ target: {} });
        if (Result.isError(acquired)) throw acquired.error;
        return acquired.value;
      },
    );
    const first = { tabId: 9, documentId: "doc-A", url: draftListUrl };
    manager.observe(first);
    await manager.pageStatus(first);
    manager.observe({ ...first, documentId: "doc-B" });
    await manager.pageStatus({ ...first, documentId: "doc-B" });
    expect(connected).toContain("doc-A");
    expect(connected).toContain("doc-B");
  });

  test("uploadMaterial preserves a valid asset_ambiguous domain error", async () => {
    const wire = await materialUploadResultCodec.serialize(Result.err({ code: "asset_ambiguous" }));
    if (Result.isError(wire)) throw new Error("failed to encode domain error");
    const manager = materialUploadManager(() => Promise.resolve(wire.value));
    const binding = uploadBinding(manager);
    const result = await manager.uploadMaterial(binding, uploadPayload(), uploadExecution);
    expect(result).toEqual(Result.err({ code: "asset_ambiguous" }));
  });
  test("uploadMaterial acquires only the material token with the bounded 20s RPC budget", async () => {
    let options: unknown;
    const binding = {
      tabId: 44,
      documentId: "budget-doc",
      url: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=g1",
    };
    const manager = createPageManager(
      api({
        async getTab(id: number) {
          return { id, url: binding.url };
        },
        async queryGroup() {
          return [{ id: binding.tabId, url: binding.url }];
        },
      }) as never,
      undefined,
      async () => ({
        state: "ready",
        route: appmsgRouteIdentity(binding.url)!,
        documentReady: true,
      }),
      undefined,
      async () =>
        ({
          contextMeta: { app: { protocolVersion } },
          safeGet(token: unknown, supplied?: unknown) {
            expect(token).toBe(materialPageToken);
            options = supplied;
            return Result.ok({
              upload: async () =>
                wire(materialUploadResultCodec, Result.ok(await uploadReceipt(uploadPayload()))),
            });
          },
        }) as never,
    );
    manager.observe(binding);
    await manager.uploadMaterial(binding, uploadPayload(), uploadExecution);
    expect(options).toEqual({ callTimeout: 20_000 });
  });
  test("cover/save calls acquire their one native capability with a finite caller budget", async () => {
    const binding = { tabId: 44, documentId: "action-doc", url: savedUrl };
    const options: unknown[] = [];
    const manager = createPageManager(
      api({
        async getTab(id: number) {
          return { id, url: binding.url };
        },
        async queryGroup() {
          return [{ id: binding.tabId, url: binding.url }];
        },
      }) as never,
      undefined,
      async () => ({
        state: "ready",
        route: appmsgRouteIdentity(binding.url)!,
        documentReady: true,
      }),
      undefined,
      async () => {
        const { runtime, connect } = actionRuntime();

        runtime
          .provide(articleCoverPageToken, {
            ...coverIdentity,
            read: async () =>
              (await articleCoverHashResultCodec.serialize(Result.ok("a".repeat(64)))).unwrap(),
            set: async (_candidate, expected, execution) => coverReceipt(execution, expected),
            save: async (execution) => saveReceipt(execution),
          })
          .provide(draftPageToken, {
            listDrafts: async () => ({ status: "ok" as const, value: [] }),
            validateDraft: async () => ({
              status: "ok" as const,
              value: { valid: true, title: "Title" },
            }),
            currentItemCount: async () => ({ status: "ok" as const, value: 1 }),
          });

        const connection = await connect();
        return new Proxy(connection, {
          get(target, property, receiver) {
            if (property === "safeGet")
              return (token: unknown, supplied?: unknown) => {
                options.push(supplied);
                return target.safeGet(token as never, supplied as never);
              };
            return Reflect.get(target, property, receiver);
          },
        });
      },
    );
    manager.observe(binding);
    expect(await manager.readArticleCover(binding)).toEqual(Result.ok("a".repeat(64)));
    expect(
      await manager.setArticleCover(
        binding,
        { filename: "x.png", thumbnailUrl: "https://mmbiz.qpic.cn/x/300" },
        "a".repeat(64),
        coverExecution(),
      ),
    ).toMatchObject(
      Result.ok({
        effect: { cover: true, outcome: "confirmed", coverHash: "b".repeat(64) },
        ended: true,
      }),
    );
    expect(await manager.saveArticle(binding, saveExecution())).toMatchObject(
      Result.ok({ effect: { outcome: "confirmed", persistence: "unverified" }, ended: true }),
    );
    expect(options.filter((option) => option !== undefined)).toEqual([
      { callTimeout: 25_000 },
      { callTimeout: 25_000 },
    ]);
  });

  test("cover/save convert invoked mutation rejection and malformed replies to matching unknown", async () => {
    const binding = { tabId: 44, documentId: "action-doc", url: savedUrl };
    let mode: "reject" | "malformed" = "reject";
    const { runtime, connect } = actionRuntime();

    runtime
      .provide(articleCoverPageToken, {
        ...coverIdentity,
        read: async () =>
          (await articleCoverHashResultCodec.serialize(Result.ok("a".repeat(64)))).unwrap(),
        set: async () => {
          if (mode === "reject") throw new Error("synthetic dispatched set reply lost");
          return { status: "ok", value: { coverHash: "bad" } } as never;
        },
        save: async () => {
          if (mode === "reject") throw new Error("synthetic dispatched save reply lost");
          return { status: "ok", value: { confirmed: true, extra: true } } as never;
        },
      })
      .provide(draftPageToken, {
        listDrafts: async () => ({ status: "ok" as const, value: [] }),
        validateDraft: async () => ({
          status: "ok" as const,
          value: { valid: true, title: "Title" },
        }),
        currentItemCount: async () => ({ status: "ok" as const, value: 1 }),
      });

    const connection = await connect();
    const manager = createPageManager(
      api({
        async getTab(id: number) {
          return { id, url: binding.url };
        },
        async queryGroup() {
          return [{ id: binding.tabId, url: binding.url }];
        },
      }) as never,
      undefined,
      async () => ({
        state: "ready",
        route: appmsgRouteIdentity(binding.url)!,
        documentReady: true,
      }),
      undefined,
      async () => connection,
    );
    manager.observe(binding);
    const candidate = { filename: "x.png", thumbnailUrl: "https://mmbiz.qpic.cn/x/300" };
    for (const modeValue of ["reject", "malformed"] as const) {
      mode = modeValue;
      for (const result of [
        await manager.setArticleCover(binding, candidate, "a".repeat(64), coverExecution()),
        await manager.saveArticle(binding, saveExecution()),
      ]) {
        expect(result).toEqual(
          Result.err({
            code: mode === "reject" ? "receipt_unreachable" : "invalid_result_envelope",
            cause: {
              at: mode === "reject" ? "bg.page_call" : "bg.page_decode",
              kind: mode === "reject" ? "nexus" : "protocol",
              code: mode === "reject" ? "E_REMOTE_EXCEPTION" : "invalid_result_envelope",
            },
          }),
        );
      }
    }
  });

  test("cover/save preserve valid route_changed domain errors and cleanup facts", async () => {
    const binding = { tabId: 44, documentId: "action-doc", url: savedUrl };
    const { runtime, connect } = actionRuntime();

    let setCalls = 0;
    let saveCalls = 0;
    let coverRead = (
      await articleCoverHashResultCodec.serialize(Result.ok("a".repeat(64)))
    ).unwrap();
    runtime
      .provide(articleCoverPageToken, {
        ...coverIdentity,
        read: async () => coverRead,
        set: async (_candidate, expected, execution) => {
          setCalls++;
          return coverReceipt(
            execution,
            expected,
            { cover: true, outcome: "unknown" },
            {
              status: "error",
              error: {
                code: "route_changed",
                cause: { at: "content.guard", kind: "domain", code: "route_changed" },
                cleanup: { at: "content.cover_cleanup", kind: "domain", code: "cleanup_failed" },
              },
            },
            false,
          );
        },
        save: async (execution) => {
          saveCalls++;
          return saveReceipt(
            execution,
            { outcome: "confirmed", persistence: "unverified" },
            {
              status: "error",
              error: {
                code: "route_changed",
                cause: { at: "content.guard", kind: "domain", code: "history_read_failed" },
                cleanup: {
                  at: "content.history_cleanup",
                  kind: "runtime",
                  code: "history_cleanup_failed",
                },
              },
            },
          );
        },
      })
      .provide(draftPageToken, {
        listDrafts: async () => ({ status: "ok" as const, value: [] }),
        validateDraft: async () => ({
          status: "ok" as const,
          value: { valid: true, title: "Title" },
        }),
        currentItemCount: async () => ({ status: "ok" as const, value: 1 }),
      });

    const connection = await connect();
    const manager = createPageManager(
      api({
        async getTab(id: number) {
          return { id, url: binding.url };
        },
        async queryGroup() {
          return [{ id: binding.tabId, url: binding.url }];
        },
      }) as never,
      undefined,
      async () => ({
        state: "ready",
        route: appmsgRouteIdentity(binding.url)!,
        documentReady: true,
      }),
      undefined,
      async () => connection,
    );
    manager.observe(binding);
    const readFailure = {
      stage: "native_read" as const,
      kind: "runtime" as const,
      causeCode: "dom_read_failed" as const,
      component: "cover" as const,
    };
    coverRead = (
      await articleCoverHashResultCodec.serialize(
        Result.err({
          code: "cover_unavailable",
          readFailure,
          cleanupFailed: true,
          baselineHash: "a".repeat(64),
        }),
      )
    ).unwrap();
    expect(await manager.readArticleCover(binding)).toEqual(
      Result.err({
        code: "cover_unavailable",
        readFailure,
        cleanupFailed: true,
        baselineHash: "a".repeat(64),
        observedFailure: { kind: "runtime", causeCode: "dom_read_failed" },
      }),
    );
    coverRead = (
      await articleCoverHashResultCodec.serialize(
        Result.err({ code: "route_changed", readFailure }),
      )
    ).unwrap();
    expect(await manager.readArticleCover(binding)).toEqual(
      Result.err({
        code: "target_unavailable",
        readFailure,
        observedFailure: { kind: "runtime", causeCode: "dom_read_failed" },
      }),
    );
    coverRead = (
      await articleCoverHashResultCodec.serialize(Result.err({ code: "not_logged_in" }))
    ).unwrap();
    expect(await manager.readArticleCover(binding)).toEqual(
      Result.err({
        code: "not_logged_in",
        observedFailure: { kind: "domain", causeCode: "not_logged_in" },
      }),
    );
    const candidate = { filename: "x.png", thumbnailUrl: "https://mmbiz.qpic.cn/x/300" };
    expect(
      await manager.setArticleCover(binding, candidate, "a".repeat(64), coverExecution()),
    ).toMatchObject(
      Result.ok({
        effect: { cover: true, outcome: "unknown" },
        ended: false,
        result: {
          status: "error",
          error: {
            code: "route_changed",
            cleanup: { at: "content.cover_cleanup", kind: "domain", code: "cleanup_failed" },
          },
        },
      }),
    );
    expect(await manager.saveArticle(binding, saveExecution())).toMatchObject(
      Result.ok({
        effect: { outcome: "confirmed", persistence: "unverified" },
        ended: true,
        result: {
          status: "error",
          error: {
            code: "route_changed",
            cause: { at: "content.guard", kind: "domain", code: "history_read_failed" },
            cleanup: {
              at: "content.history_cleanup",
              kind: "runtime",
              code: "history_cleanup_failed",
            },
          },
        },
      }),
    );
    expect({ setCalls, saveCalls }).toEqual({ setCalls: 1, saveCalls: 1 });
  });

  test("uploadMaterial preserves confirmed asset creation and cleanup facts", async () => {
    const receipt = {
      ...(await uploadReceipt(uploadPayload())),
      result: {
        status: "error" as const,
        error: {
          code: "cleanup_failed" as const,
          cause: {
            at: "content.library_cleanup" as const,
            kind: "domain" as const,
            code: "cancel_unavailable",
          },
        },
      },
    };
    const wire = await materialUploadResultCodec.serialize(Result.ok(receipt));
    if (Result.isError(wire)) throw new Error("failed to encode upload facts");
    const manager = materialUploadManager(() => Promise.resolve(wire.value));
    const binding = uploadBinding(manager);
    expect(await manager.uploadMaterial(binding, uploadPayload(), uploadExecution)).toEqual(
      Result.ok(receipt),
    );
  });

  test("real Nexus transport preserves a domain confirmation error without replacing it with transport failure", async () => {
    const failure = {
      code: "asset_upload_unknown" as const,
      cause: {
        at: "content.upload_confirm" as const,
        kind: "domain" as const,
        code: "card_title_empty",
      },
      confirmationTimedOut: true as const,
      cleanup: {
        at: "content.library_cleanup" as const,
        kind: "domain" as const,
        code: "cancel_unavailable",
      },
    };
    const wire = await materialUploadResultCodec.serialize(Result.err(failure));
    if (Result.isError(wire)) throw new Error("encode failed");
    const manager = materialUploadManager(async () => wire.value);
    expect(
      await manager.uploadMaterial(uploadBinding(manager), uploadPayload(), uploadExecution),
    ).toEqual(Result.err(failure));
  });

  test("uploadMaterial maps malformed envelopes and rejected replies to unknown", async () => {
    const malformed = materialUploadManager(async () => {
      const encoded = await materialUploadResultCodec.serialize(
        Result.ok(await uploadReceipt(uploadPayload())),
      );
      if (Result.isError(encoded)) throw new Error("failed to encode upload receipt");
      Object.assign(encoded.value, {
        value: {
          filename: "x.png",
          thumbnailUrl: "https://mmbiz.qpic.cn/test/300",
          unexpected: true,
        },
      });
      return encoded.value;
    });
    const malformedBinding = uploadBinding(malformed);
    expect(
      await malformed.uploadMaterial(malformedBinding, uploadPayload(), uploadExecution),
    ).toEqual(
      Result.err({
        code: "invalid_result_envelope",
        cause: { at: "bg.page_decode", kind: "protocol", code: "invalid_result_envelope" },
      }),
    );

    const rejected = materialUploadManager(() => Promise.reject(new Error("reply lost")));
    const rejectedBinding = uploadBinding(rejected);
    expect(
      await rejected.uploadMaterial(rejectedBinding, uploadPayload(), uploadExecution),
    ).toEqual(
      Result.err({
        code: "receipt_unreachable",
        cause: { at: "bg.page_call", kind: "nexus", code: "E_REMOTE_EXCEPTION" },
      }),
    );
  });

  test("uploadMaterial contains a throwing result decoder as unknown", async () => {
    const wire = await materialUploadResultCodec.serialize(
      Result.ok(await uploadReceipt(uploadPayload())),
    );
    if (Result.isError(wire)) throw new Error("failed to encode upload receipt");
    const deserialize = materialUploadResultCodec.deserialize;
    materialUploadResultCodec.deserialize = async () => {
      throw new Error("decoder failed");
    };
    try {
      const manager = materialUploadManager(() => Promise.resolve(wire.value));
      const binding = uploadBinding(manager);
      expect(await manager.uploadMaterial(binding, uploadPayload(), uploadExecution)).toEqual(
        Result.err({
          code: "invalid_result_envelope",
          cause: { at: "bg.page_decode", kind: "protocol", code: "invalid_result_envelope" },
        }),
      );
    } finally {
      materialUploadResultCodec.deserialize = deserialize;
    }
  });

  test("R20 upload whole-call budget includes decoding and a late decoder cannot change the returned uncertainty", async () => {
    const wire = (
      await materialUploadResultCodec.serialize(Result.ok(await uploadReceipt(uploadPayload())))
    ).unwrap();
    let reached!: () => void;
    const decoding = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = materialUploadResultCodec.deserialize;
    let decoded!: Promise<Awaited<ReturnType<typeof original>>>;
    const decoder = spyOn(materialUploadResultCodec, "deserialize").mockImplementation((wire) => {
      decoded = (async () => {
        reached();
        await gate;
        return original(wire);
      })();
      return decoded;
    });
    let calls = 0;
    const manager = materialUploadManager(async () => {
      calls++;
      return wire;
    });
    const realTimer = globalThis.setTimeout;
    let expire!: () => void;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      delay: number,
    ) => {
      if (delay === 20_000) {
        expire ??= handler;
        return realTimer(() => {}, delay);
      }
      return realTimer(handler, delay);
    }) as typeof setTimeout);
    try {
      const pending = manager.uploadMaterial(
        uploadBinding(manager),
        uploadPayload(),
        uploadExecution,
      );
      await decoding;
      expire();
      const result = await pending;
      expect(result).toMatchObject({
        status: "error",
        error: {
          code: "receipt_unreachable",
          cause: { at: "bg.page_decode", kind: "nexus", code: "E_CALL_TIMEOUT" },
        },
      });
      expect(result.isErr() && result.error.notInvoked).toBeUndefined();
      release();
      expect((await decoded).isOk()).toBe(true);
      expect(result.isErr()).toBe(true);
      expect(calls).toBe(1);
    } finally {
      release();
      decoder.mockRestore();
      timer.mockRestore();
      manager.dispose();
    }
  });

  test("upload connect and provider acquisition errors retain Nexus codes and no-dispatch outcome", async () => {
    const { NexusError } = await import("@nexus-js/core");
    const binding = { tabId: 44, documentId: "upload-doc", url: savedUrl };
    for (const stage of [
      "page_connect",
      "page_acquire",
      "connection_version",
      "acquire_throw",
      "target_gone",
    ] as const) {
      let acquisitions = 0;
      const manager = createPageManager(
        api({
          async getTab(id: number) {
            return stage === "target_gone" ? undefined : { id, url: savedUrl };
          },
        }) as never,
        undefined,
        undefined,
        undefined,
        async () => {
          if (stage === "page_connect") throw new NexusError("private-message", "E_CONN_CLOSED");
          return {
            contextMeta: {
              app: { protocolVersion: stage === "connection_version" ? "0.9.0" : protocolVersion },
            },
            safeGet: () => {
              acquisitions++;
              if (stage === "page_acquire")
                return Result.err(new NexusError("private-message", "E_SERVICE_UNAVAILABLE"));
              throw new NexusError("private-message", "E_CONN_CLOSED");
            },
          } as never;
        },
      );
      manager.observe(binding);
      const cause = {
        at:
          stage === "page_acquire" || stage === "acquire_throw"
            ? "bg.page_acquire"
            : "bg.page_connect",
        kind:
          stage === "connection_version"
            ? "protocol"
            : stage === "target_gone"
              ? "domain"
              : "nexus",
        code:
          stage === "connection_version"
            ? "version_mismatch"
            : stage === "target_gone"
              ? "target_unavailable"
              : stage === "page_acquire"
                ? "E_SERVICE_UNAVAILABLE"
                : "E_CONN_CLOSED",
      };
      expect(await manager.uploadMaterial(binding, uploadPayload(), uploadExecution)).toMatchObject(
        { error: { notInvoked: true, cause } },
      );
      expect(await manager.materialIdentity(binding)).toMatchObject({ error: { cause } });
      expect(acquisitions).toBe(stage === "page_acquire" || stage === "acquire_throw" ? 2 : 0);
      manager.dispose();
    }
  });

  test("Nexus page-call timeout retains its code without claiming a platform-upload timeout", async () => {
    let calls = 0;
    const manager = materialUploadManager(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        status: "ok",
        value: await uploadReceipt(uploadPayload()),
      };
    }, 10);
    const result = await manager.uploadMaterial(
      uploadBinding(manager),
      uploadPayload(),
      uploadExecution,
    );
    expect(result).toMatchObject({
      error: {
        code: "receipt_unreachable",
        cause: { at: "bg.page_call", kind: "nexus", code: "E_CALL_TIMEOUT" },
      },
    });
    expect(result.isErr() && result.error.notInvoked).toBeUndefined();
    expect(calls).toBe(1);
  });

  test.each([
    "identity-loss",
    "identity-malformed",
    "identity-domain",
    "call-version",
    "identity-call-version",
  ] as const)(
    "F1a/F1b actual Nexus %s boundary retains reason and invocation knowledge",
    async (mode) => {
      const target = new EventTarget();
      const channelId = crypto.randomUUID();
      const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
      const main = createPageEndpoint({ target, channelId, side: "main", eventNames });
      const isolated = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
      let uploads = 0;
      let identities = 0;
      const provider = new Nexus()
        .configure({ endpoint: { implementation: main, meta: { app: { protocolVersion } } } })
        .provide(materialPageToken, {
          ...materialIdentity,
          async identity(): ReturnType<MaterialPageService["identity"]> {
            identities++;
            if (mode === "identity-malformed")
              return { status: "ok", value: { executorId: "invalid" } } as never;
            if (mode === "identity-domain")
              return {
                status: "error",
                error: {
                  code: "target_unavailable",
                  cause: { at: "content.guard", kind: "domain", code: "target_unavailable" },
                },
              };
            throw new Error("private identity failure");
          },
          async list() {
            return { status: "ok" as const, value: { scope: "visible-page" as const, cards: [] } };
          },
          async upload() {
            uploads++;
            return { status: "ok" as const, value: await uploadReceipt(uploadPayload()) };
          },
        });
      const client = new Nexus().configure({
        endpoint: { implementation: isolated, meta: { app: { protocolVersion } } },
      });
      const binding = { tabId: 44, documentId: "call-version", url: savedUrl };
      try {
        await Promise.all([provider.ready(), client.ready()]);
        const connection = await client.connect({ target: {} });
        const manager = createPageManager(
          api({ getTab: async () => ({ id: 44, url: binding.url }) }),
          undefined,
          undefined,
          undefined,
          async () => connection,
        );
        manager.observe(binding);
        if (
          mode === "identity-loss" ||
          mode === "identity-malformed" ||
          mode === "identity-domain"
        ) {
          expect(await manager.materialIdentity(binding)).toMatchObject({
            error: {
              cause:
                mode === "identity-malformed"
                  ? { at: "bg.page_decode", kind: "protocol", code: "invalid_result_envelope" }
                  : mode === "identity-domain"
                    ? { at: "content.guard", kind: "domain", code: "target_unavailable" }
                    : { at: "bg.page_call", kind: "nexus", code: "E_REMOTE_EXCEPTION" },
            },
          });
          expect(identities).toBe(1);
        } else {
          const get = connection.safeGet.bind(connection);
          connection.safeGet = ((...args: Parameters<typeof get>) => {
            const acquired = get(...args);
            // connectContent has already admitted the current metadata. Change it
            // only after acquisition: callPage must refuse this actual lazy call.
            connection.contextMeta.app.protocolVersion = "0.9.0";
            return acquired;
          }) as typeof connection.safeGet;
          if (mode === "identity-call-version") {
            expect(await manager.materialIdentity(binding)).toMatchObject({
              error: { cause: { at: "bg.page_call", kind: "protocol", code: "version_mismatch" } },
            });
            expect(identities).toBe(0);
          } else
            expect(
              await manager.uploadMaterial(binding, uploadPayload(), uploadExecution),
            ).toMatchObject({
              error: {
                notInvoked: true,
                cause: { at: "bg.page_call", kind: "protocol", code: "version_mismatch" },
              },
            });
          expect(uploads).toBe(0);
        }
        manager.dispose();
      } finally {
        main.close();
        isolated.close();
      }
    },
  );

  test("propagates unknown Chrome lookup failures without treating them as confirmed navigation", async () => {
    const failure = new Error("unknown tab lookup");
    const manager = createPageManager(
      api({
        async getTab() {
          throw failure;
        },
      }) as never,
    );
    const binding = { tabId: 12, documentId: "unknown-lookup", url: draftListUrl };
    manager.observe(binding);
    const result = await manager.isCurrent(binding);
    expect(result).toMatchObject({ status: "error", error: { code: "page_failed" } });
    expect(failure.message).toBe("unknown tab lookup");
  });
});
import { fieldsProviderIdentity, fieldsExecutorId, fieldsReceipt } from "./fields-fixture";
