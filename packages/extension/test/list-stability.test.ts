import { expect, test } from "bun:test";
import { Result } from "better-result";
import { createWorkspace } from "../src/workspace";
import {
  articleResultCodec,
  cleanupWorkspaceResultCodec,
  listArticlesResultCodec,
  workspaceResultCodec,
  writeBodyResultCodec,
} from "@mpctl/contracts";
import { pageEditorContentResultCodec, pageEditorReadyResultCodec } from "../src/page-contracts";

function fixture() {
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
  const service = createWorkspace({
    pages: {
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
      async openDraftGroup() {
        opens++;
        return Result.ok(editor);
      },
      async validateSavedArticle() {
        return Result.ok({ valid: true, title: "A" });
      },
      async open() {
        return Result.ok({
          ready: async () =>
            encoded(pageEditorReadyResultCodec, Result.ok({ isReady: true, isNew: true })),
          getContent: async () => encoded(pageEditorContentResultCodec, Result.ok("<p>A</p>")),
          setContent: async () => {
            throw new Error("not used");
          },
        });
      },
      async pageStatus() {
        return Result.ok({ state: "ready" as const, route: "", documentReady: true });
      },
    } as never,
  });
  const workspace = {
    async cleanupWorkspace() {
      return decode(await service.cleanupWorkspace(), cleanupWorkspaceResultCodec);
    },
    async listArticles() {
      return decode(await service.listArticles(), listArticlesResultCodec);
    },
    async openArticle(id: string) {
      return decode(await service.openArticle(id), articleResultCodec);
    },
    async newArticle() {
      return decode(await service.newArticle(), articleResultCodec);
    },
    async currentArticle() {
      return decode(await service.currentArticle(), articleResultCodec);
    },
    async readBody(id: string) {
      return decode(await service.readBody(id), workspaceResultCodec);
    },
    async writeBody(id: string, html: string, hash: string) {
      return decode(await service.writeBody(id, html, hash), writeBodyResultCodec);
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
