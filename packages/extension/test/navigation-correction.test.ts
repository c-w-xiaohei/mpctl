import { afterEach, beforeEach, expect, test } from "bun:test";
import { Result } from "better-result";
import { installIdbFixture } from "./idb-fixture";
import { navigationFixture } from "./browser/fixtures/navigation-workspace";
import { assetListResultCodec } from "@mpctl/contracts";
import { Nexus } from "@nexus-js/core";
import {
  usingNodeIpcDaemon,
  type UnixSocketServerEndpoint,
} from "../../cli/node_modules/@nexus-js/node-ipc";
import { workspaceToken, connectionToken, protocolVersion } from "@mpctl/contracts";
import { mkdtemp, rm } from "node:fs/promises";
let restore: () => void;
beforeEach(() => {
  restore = installIdbFixture();
});
afterEach(() => restore());

test("correction F3 before material invocation refusal ends with zero provider calls and permits a new intent", async () => {
  const f = await navigationFixture();
  try {
    f.addSaved("A");
    const current = await f.current("A");
    let validations = 0;
    let calls = 0;
    f.manager.validateSavedArticle = async () =>
      ++validations === 2
        ? Result.err({ code: "not_logged_in" })
        : Result.ok({ valid: true, title: "A" });
    f.manager.listMaterials = async () => {
      calls++;
      return Result.ok({ scope: "visible-page" as const, cards: [] });
    };
    const reply = await f.workspace.listAssets(current.article);
    expect(validations).toBe(2);
    expect(calls).toBe(0);
    expect(reply).toMatchObject({
      status: "error",
      error: {
        snapshot: {
          state: "settled",
          effect: { outcome: "not_dispatched" },
          result: { error: { code: "not_logged_in" } },
        },
      },
    });
    expect((await f.operations.pending()).unwrap()).toEqual([]);
    expect(await f.workspace.listAssets(current.article)).toEqual({
      status: "ok",
      value: { scope: "visible-page", cards: [] },
    });
    expect(calls).toBe(1);
  } finally {
    f.dispose();
  }
});

test("correction F4 zero-placement settled material failure keeps authoritative cause cleanup and queryable ID", async () => {
  const f = await navigationFixture();
  try {
    f.addSaved("A");
    const current = await f.current("A");
    let calls = 0;
    const failure = {
      code: "dialog_unavailable" as const,
      cause: {
        at: "content.library_open" as const,
        kind: "domain" as const,
        code: "dialog_changed",
      },
      cleanup: {
        at: "content.library_cleanup" as const,
        kind: "runtime" as const,
        code: "dialog_observe_exception",
      },
    };
    f.manager.listMaterials = async (_binding, onInvoke) => {
      calls++;
      onInvoke?.();
      return Result.err({ code: "page_failed", ended: true, failure });
    };
    const decoded = await assetListResultCodec.deserialize(
      await f.workspace.listAssets(current.article),
    );
    if (decoded.isOk()) throw new Error("expected maintenance failure");
    const response = decoded.error;
    expect(response).toMatchObject({
      snapshot: {
        state: "settled",
        effect: { placements: 0, auxiliaryCreated: [] },
        result: { status: "error", error: failure },
      },
    });
    if (!("snapshot" in response) || !response.snapshot) throw new Error("public snapshot missing");
    for (let i = 0; i < 2; i++)
      expect(
        (await f.decode(await f.workspace.getOperation(response.snapshot.operationId))).snapshot,
      ).toEqual(response.snapshot);
    expect(calls).toBe(1);
    expect((await f.operations.pending()).unwrap()).toEqual([]);
  } finally {
    f.dispose();
  }
});

for (const maintenance of [false, true])
  test(`correction F2 production list reload timeout is not ended by unrelated HOME (${maintenance ? "maintenance" : "navigation"})`, async () => {
    const f = await navigationFixture();
    try {
      const original = f.manager.isCurrent.bind(f.manager);
      f.manager.isCurrent = async (binding) =>
        binding.tabId === 2 ? Result.ok(false) : original(binding);
      const result = maintenance
        ? await f.workspace.listArticles()
        : await f.workspace.openArticle({ operationId: f.id(), candidate: "A" });
      const pending = (await f.operations.pending()).unwrap();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.snapshot.state).toBe("unresolved");
      expect(f.counters).toMatchObject({ reload: 1, create: 0, capture: 0 });
      expect(await f.workspace.cleanupWorkspace()).toMatchObject({
        status: "error",
        error: { blockingOperationId: pending[0]!.snapshot.operationId },
      });
      expect(result.status).toBe(maintenance ? "error" : "ok");
    } finally {
      f.dispose();
    }
  }, 25000);

test("correction F3 actual Nexus material invocation lost reply remains pending; success then BG read refusal ends", async () => {
  for (const lost of [true, false]) {
    const f = await navigationFixture();
    try {
      f.addSaved("A");
      const current = await f.current("A");
      let validations = 0;
      f.manager.validateSavedArticle = async () =>
        ++validations === 3
          ? Result.err({ code: "not_logged_in" })
          : Result.ok({ valid: true, title: "A" });
      if (lost)
        f.materialReply(async () => {
          throw new Error("private lost reply");
        });
      const response = await f.workspace.listAssets(current.article);
      expect(f.materialCalls()).toBe(1);
      expect(response).toMatchObject({
        status: "error",
        error: { snapshot: { state: lost ? "unresolved" : "settled" } },
      });
      expect((await f.operations.pending()).unwrap()).toHaveLength(lost ? 1 : 0);
      if (lost) {
        await f.workspace.listAssets(current.article);
        expect(f.materialCalls()).toBe(1);
      }
    } finally {
      f.dispose();
    }
  }
});

test("correction F2 matched original reload observation retires only that attempt", async () => {
  const f = await navigationFixture();
  try {
    const tab = {
      tabId: 2,
      documentId: "list",
      url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10&token=account",
    };
    const originalCurrent = f.manager.isCurrent.bind(f.manager);
    let fresh = false;
    f.manager.isCurrent = async (binding) =>
      binding.tabId === 2
        ? Result.ok(fresh && binding.documentId === "fresh-list")
        : originalCurrent(binding);
    f.api.reloadTab = async () => {
      f.counters.reload++;
      fresh = true;
      f.manager.observe({ ...tab, documentId: "fresh-list" });
    };
    f.api.getFrame = async ({ tabId }) => ({
      documentId: tabId === 2 ? "fresh-list" : "home",
      url:
        tabId === 2
          ? tab.url
          : "https://mp.weixin.qq.com/cgi-bin/home?t=home&token=account&lang=en_US",
    });
    const result = await f.workspace.listArticles();
    expect(result.status).toBe("ok");
    expect(f.counters.reload).toBe(1);
    expect((await f.operations.pending()).unwrap()).toEqual([]);
  } finally {
    f.dispose();
  }
});

test("correction F2 wrong tab, old document and wrong route cannot complete original reload", async () => {
  const f = await navigationFixture();
  try {
    const list = {
      tabId: 2,
      documentId: "list",
      url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10&token=account",
    };
    const originalCurrent = f.manager.isCurrent.bind(f.manager);
    f.manager.isCurrent = async (binding) =>
      binding.tabId === 2 ? Result.ok(false) : originalCurrent(binding);
    f.api.reloadTab = async () => {
      f.counters.reload++;
      f.manager.observe({ ...list, tabId: 99, documentId: "wrong-tab" });
      f.manager.observe(list);
      f.manager.observe({
        ...list,
        documentId: "wrong-route",
        url: list.url.replace("count=10", "count=20"),
      });
    };
    const response = await f.workspace.openArticle({ operationId: f.id(), candidate: "A" });
    expect(response.status).toBe("ok");
    expect((await f.operations.pending()).unwrap()).toHaveLength(1);
    expect(f.counters.reload).toBe(1);
    expect(f.counters.create).toBe(0);
  } finally {
    f.dispose();
  }
}, 25000);

test("correction F4 real maintenance record through Nexus/production codec/actual CLI retains first cause cleanup and ID", async () => {
  const f = await navigationFixture();
  const temp = await mkdtemp("/tmp/opencode/mpctl-correction-cli-");
  const socket = `${temp}/provider.sock`;
  let endpoint: UnixSocketServerEndpoint | undefined;
  try {
    f.addSaved("A");
    const current = await f.current("A");
    const failure = {
      code: "dialog_unavailable" as const,
      cause: {
        at: "content.library_open" as const,
        kind: "domain" as const,
        code: "dialog_changed",
      },
      cleanup: {
        at: "content.library_cleanup" as const,
        kind: "runtime" as const,
        code: "dialog_observe_exception",
      },
    };
    f.materialReply(async () => ({
      status: "error",
      error: { code: "page_failed", ended: true, failure },
    }));
    const config = usingNodeIpcDaemon({
      appId: "mpctl",
      address: { kind: "path", path: socket },
      configure: false,
      providers: [
        { token: workspaceToken, service: f.workspace },
        {
          token: connectionToken,
          service: {
            getStatus: async () => ({
              status: "ok",
              value: {
                connected: true,
                brokerVersion: protocolVersion,
                extensionVersion: protocolVersion,
                ledgerId: f.operations.ledgerId,
              },
            }),
          },
        },
      ],
    });

    endpoint = config.endpoint?.implementation as UnixSocketServerEndpoint;
    await new Nexus().configure(config).ready();
    const cli = async (args: string[]) => {
      const child = Bun.spawn(["bun", "../cli/src/main.ts", ...args], {
        env: { ...process.env, MPCTL_BROKER_SOCKET: socket, MPCTL_RUNTIME_DIR: temp },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      };
    };
    const result = await cli(["asset", "list", current.article]);
    expect(result.code).toBe(1);
    const snapshot = JSON.parse(result.stderr).error.snapshot;
    expect(snapshot).toMatchObject({ state: "settled", result: { error: failure } });
    for (let i = 0; i < 2; i++) {
      const status = await cli(["operation", "status", snapshot.operationId]);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout).snapshot).toEqual(snapshot);
    }
    expect(f.materialCalls()).toBe(1);
  } finally {
    endpoint?.close();
    f.dispose();
    await rm(temp, { recursive: true, force: true });
  }
}, 15000);

test("correction F4 pre-work maintenance refusal reports its committed record without a provider call", async () => {
  const f = await navigationFixture();
  try {
    const pendingId = f.id();
    await f.operations.run({ operationId: pendingId }, (execution) =>
      execution.issue({ bg: true, purpose: "new" }, async () => ({
        effect: {
          navigation: true,
          outcome: "unknown",
          pageCreated: false,
          targetBound: false,
          auxiliaryCreated: [],
        },
        ended: false,
        result: { status: "error", error: { code: "operation_unresolved" } },
      })),
    );
    const reply = await f.workspace.cleanupWorkspace();
    expect(reply).toMatchObject({
      status: "error",
      error: {
        snapshot: {
          operation: "maintenance",
          state: "settled",
          effect: { outcome: "not_dispatched" },
          result: { error: { blockingOperationId: pendingId } },
        },
      },
    });
    if (reply.status !== "error" || !("snapshot" in reply.error) || !reply.error.snapshot)
      throw new Error("snapshot missing");
    expect(
      (await f.decode(await f.workspace.getOperation(reply.error.snapshot.operationId))).snapshot,
    ).toEqual(reply.error.snapshot);
    expect(f.counters).toEqual({ create: 0, group: 0, capture: 0, reload: 0, read: 0, set: 0 });
  } finally {
    f.dispose();
  }
});
