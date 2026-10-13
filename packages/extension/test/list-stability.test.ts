import { afterEach, beforeEach, expect, test } from "bun:test";
import { installIdbFixture } from "./idb-fixture";
let restoreIdb: () => void;
beforeEach(() => {
  restoreIdb = installIdbFixture();
});
afterEach(() => {
  restoreIdb();
});
import { Nexus } from "@nexus-js/core";
import { Result } from "better-result";
import { createWorkspace } from "../src/workspace";
import { createPageManager } from "../src/pages";
import {
  articleResultCodec,
  cleanupWorkspaceResultCodec,
  listArticlesResultCodec,
  workspaceResultCodec,
  protocolVersion,
  operationResultCodec,
} from "@mpctl/contracts";
import {
  pageEditorContentResultCodec,
  pageEditorReadyResultCodec,
  pageEditorToken,
} from "../src/page-contracts";
import { createPageEndpoint } from "../src/transport/page-bridge";
import { createOperations } from "../src/operations";

const endpointCleanup: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of endpointCleanup.splice(0)) cleanup();
});

function fixture() {
  const target = new EventTarget();
  const channelId = crypto.randomUUID();
  const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
  const providerEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
  const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
  endpointCleanup.push(() => {
    providerEndpoint.close();
    clientEndpoint.close();
  });
  const provider = new Nexus()
    .configure({
      endpoint: { implementation: providerEndpoint, meta: { app: { protocolVersion } } },
    })
    .provide(pageEditorToken, {
      ready: async () =>
        encoded(
          pageEditorReadyResultCodec,
          Result.ok({ isReady: true as const, isNew: true, executorId: crypto.randomUUID() }),
        ),
      getReceipt: async () => ({ status: "ok" as const, value: null }),
      setCoverFromBody: async () => ({
        status: "error" as const,
        error: { code: "unsupported" as const },
      }),
      getCoverReceipt: async () => ({ status: "ok" as const, value: null }),
      getContent: async () => encoded(pageEditorContentResultCodec, Result.ok("<p>A</p>")),
      setContent: async () => {
        throw new Error("not used");
      },
    });
  const client = new Nexus().configure({
    endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
  });
  let groups = [{ groupId: "draft-A", title: "A" }];
  let failList = false;
  let opens = 0;
  const list = {
    tabId: 1,
    documentId: "list",
    url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10",
  };
  const editor = {
    tabId: 2,
    documentId: "editor",
    url: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=draft-A",
  };
  const initialized = createOperations();
  const service = createWorkspace({
    operations: initialized,
    pages: {
      ...createPageManager({
        async getGroup() {
          throw new Error("not used");
        },
        async createTab() {
          throw new Error("not used");
        },
        async groupTabs() {
          throw new Error("not used");
        },
        async updateGroup() {
          throw new Error("not used");
        },
        async queryGroup() {
          throw new Error("not used");
        },
        async getTab() {
          throw new Error("not used");
        },
        async getSession() {
          throw new Error("not used");
        },
        async setSession() {
          throw new Error("not used");
        },
      }),
      async ensureDraftList() {
        return Result.ok(list);
      },
      async listDraftGroups() {
        if (failList) return Result.err({ code: "page_failed" as const });
        return Result.ok(groups);
      },
      async isCurrent() {
        return Result.ok(true);
      },
      async openDraftGroup(
        _binding: unknown,
        _id: string,
        progress?: import("../src/pages").NavigationProgress,
      ) {
        opens++;
        await progress?.created("editor");
        await progress?.bound(editor);
        return Result.ok(editor);
      },
      async validateSavedArticle() {
        return Result.ok({ valid: true, title: "A" });
      },
      async open() {
        await Promise.all([provider.ready(), client.ready()]);
        const remote = (await client.connect({ target: {} })).get(pageEditorToken);
        const manager = createPageManager(
          { getTab: async () => ({ id: editor.tabId, url: editor.url }) } as never,
          async () => remote,
        );
        manager.observe(editor);
        endpointCleanup.push(() => manager.dispose());
        return manager.open(editor);
      },
      async pageStatus() {
        return Result.ok({ state: "ready" as const, route: "", documentReady: true });
      },
    },
  });
  const workspace = {
    async cleanupWorkspace() {
      return decode(await service.cleanupWorkspace(), cleanupWorkspaceResultCodec);
    },
    async listArticles() {
      return decode(await service.listArticles(), listArticlesResultCodec);
    },
    async openArticle(id: string) {
      const ledger = (await (await initialized).unwrap().keyLedger()).unwrap();
      const reply = await operationResultCodec.deserialize(
        await service.openArticle({
          candidate: id,
          operationId: `op:${ledger}:${crypto.randomUUID()}`,
        }),
      );
      if (reply.isErr())
        return {
          ok: false as const,
          error: { code: "failure" in reply.error ? reply.error.failure.code : reply.error.code },
        };
      const snapshot = reply.value.snapshot;
      return "result" in snapshot && snapshot.result.status === "error"
        ? { ok: false as const, error: snapshot.result.error }
        : { ok: true as const, value: snapshot };
    },
    async newArticle() {
      const ledger = (await (await initialized).unwrap().keyLedger()).unwrap();
      return decode(
        await service.newArticle({
          operationId: `op:${ledger}:${crypto.randomUUID()}`,
        }),
        operationResultCodec,
      );
    },
    async currentArticle() {
      return decode(await service.currentArticle(), articleResultCodec);
    },
    async readBody(id: string) {
      return decode(await service.readBody(id), workspaceResultCodec);
    },
    async writeBody(id: string, html: string, hash: string) {
      return decode(
        await service.writeBody({
          article: id,
          html,
          expectedHash: hash,
          operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        }),
        operationResultCodec,
      );
    },
  };
  return {
    workspace,
    fail: (value: boolean) => {
      failList = value;
    },
    remove: () => {
      groups = [];
    },
    opens: () => opens,
  };
}

async function decode<T, E>(
  value: unknown,
  codec: { deserialize(value: unknown): Promise<import("better-result").Result<T, E>> },
) {
  const result = await codec.deserialize(value);
  return Result.isOk(result)
    ? { ok: true as const, value: result.value }
    : { ok: false as const, error: result.error };
}

async function encoded<T, E>(
  codec: {
    serialize(
      value: import("better-result").Result<T, E>,
    ): Promise<
      import("better-result").Result<
        import("better-result").SerializedResult<T, E | { code: "invalid_result_envelope" }>,
        { code: "invalid_result_envelope" }
      >
    >;
  },
  value: import("better-result").Result<T, E>,
) {
  const result = await codec.serialize(value);
  return Result.isOk(result) ? result.value : { status: "error" as const, error: result.error };
}

test("repeated list preserves a previously returned candidate and its stable value", async () => {
  const f = fixture();
  const first = await f.workspace.listArticles();
  const second = await f.workspace.listArticles();
  if (!first.ok || !second.ok) throw new Error("list failed");
  expect(second.value[0]!.candidate).toBe(first.value[0]!.candidate);
  expect(await f.workspace.openArticle(first.value[0]!.candidate)).toMatchObject({ ok: true });
});

test("a failed list does not revoke a previous selection", async () => {
  const f = fixture();
  const first = await f.workspace.listArticles();
  if (!first.ok) throw new Error("list failed");
  f.fail(true);
  expect(await f.workspace.listArticles()).toMatchObject({ ok: false });
  f.fail(false);
  expect(await f.workspace.openArticle(first.value[0]!.candidate)).toMatchObject({ ok: true });
});

test("a removed actual target is refused when opening without dispatching navigation", async () => {
  const f = fixture();
  const first = await f.workspace.listArticles();
  if (!first.ok) throw new Error("list failed");
  f.remove();
  expect(await f.workspace.openArticle(first.value[0]!.candidate)).toMatchObject({
    ok: false,
    error: { code: "target_unavailable" },
  });
  expect(f.opens()).toBe(0);
});
