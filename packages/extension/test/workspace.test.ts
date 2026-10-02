import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { createWorkspace } from "../src/workspace";
import { createEditorService } from "../src/mp/jsapi";
import {
  articleResultCodec,
  cleanupWorkspaceResultCodec,
  listArticlesResultCodec,
  workspaceResultCodec,
  writeBodyResultCodec,
} from "@mpctl/contracts";
import { pageEditorContentResultCodec, pageEditorWriteResultCodec } from "../src/page-contracts";

const hash = (html: string) =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(html))
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );

function fixture(
  options: {
    groups?: Array<{ groupId: string; title: string }>;
    html?: string;
    saved?: boolean;
    setResult?:
      | { ok: true; bodyHash: string }
      | { ok: false; code: "content_conflict" | "write_unknown" | "page_failed" };
  } = {},
) {
  let body = options.html ?? "<p>baseline</p>";
  let current = true;
  let state: "ready" | "loading" | "not_logged_in" = "ready";
  let failLoginAfterDraftOpen = false;
  let failEditorLookup = false;
  const setBody = (html: string) => {
    body = html;
  };
  const calls: string[] = [];
  const list = {
    tabId: 1,
    documentId: "list-document",
    url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77",
  };
  const editorBinding = {
    tabId: 2,
    documentId: options.saved ? "saved-editor" : "new-editor",
    url: options.saved
      ? "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=g1"
      : "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
  };
  const editor = createEditorService({
    invoke(request) {
      if (request.apiName === "mp_editor_get_isready")
        request.sucCb({ isReady: true, isNew: true });
      else if (request.apiName === "mp_editor_get_content") {
        calls.push("get");
        request.sucCb({ content: body });
      } else {
        calls.push("mutation");
        body = (request.apiParam.content as string).trim().replace(/\s+/g, " ");
        request.sucCb({ msg: "ok" });
      }
    },
  });
  const wireEditor = {
    ready: () => editor.ready(),
    getContent: () => editor.getContent(),
    async setContent(html: string, expectedHash: string) {
      if (options.setResult) {
        const result = options.setResult;
        const encoded = await pageEditorWriteResultCodec.serialize(
          result.ok ? Result.ok({ bodyHash: result.bodyHash }) : Result.err({ code: result.code }),
        );
        return Result.isOk(encoded) ? encoded.value : { status: "error", error: encoded.error };
      }
      return editor.setContent(html, expectedHash);
    },
  };
  const pages = {
    async ensureDraftList() {
      return Result.ok(list);
    },
    async ensureEditorTab() {
      const binding = Result.ok(editorBinding);
      if (failEditorLookup) return Result.err({ code: "page_failed" as const, pageCreated: true });
      return binding;
    },
    async isCurrent(binding: typeof list | typeof editorBinding) {
      if (failEditorLookup && binding.tabId === editorBinding.tabId)
        return Result.err({ code: "page_failed" as const, pageCreated: true });
      return Result.ok(current && binding.documentId !== "replaced");
    },
    async pageStatus(binding: typeof list | typeof editorBinding) {
      if (failLoginAfterDraftOpen && binding.tabId === editorBinding.tabId) state = "not_logged_in";
      return Result.ok({ state, route: "", documentReady: true });
    },
    async listDraftGroups() {
      calls.push("list");
      return Result.ok(options.groups ?? [{ groupId: "g1", title: "Draft" }]);
    },
    async openDraftGroup(_binding: unknown, groupId: string) {
      calls.push(`edit:${groupId}`);
      if (failLoginAfterDraftOpen) state = "not_logged_in";
      return Result.ok(groupId === "g1" ? editorBinding : undefined);
    },
    async findCurrentEditor() {
      return Result.ok(editorBinding);
    },
    async validateSavedArticle(_binding: unknown, groupId: string) {
      return Result.ok({ valid: groupId === "g1", title: "Draft" });
    },
    async open() {
      return Result.ok(wireEditor);
    },
    loseCurrent() {
      current = false;
    },
    setStatus(value: typeof state) {
      state = value;
    },
    setLoginAfterDraftOpen() {
      failLoginAfterDraftOpen = true;
    },
    setEditorLookupFailure() {
      failEditorLookup = true;
    },
  };
  return {
    workspace: domainWorkspace(createWorkspace({ pages: pages as never })),
    calls,
    pages,
    editorBinding,
    setBody,
    editor,
  };
}

function domainWorkspace(service: ReturnType<typeof createWorkspace>) {
  return {
    async cleanupWorkspace() {
      return unwrap(await service.cleanupWorkspace(), cleanupWorkspaceResultCodec);
    },
    async listArticles() {
      return unwrap(await service.listArticles(), listArticlesResultCodec);
    },
    async openArticle(candidate: string) {
      return unwrap(await service.openArticle(candidate), articleResultCodec);
    },
    async newArticle() {
      return unwrap(await service.newArticle(), articleResultCodec);
    },
    async currentArticle() {
      return unwrap(await service.currentArticle(), articleResultCodec);
    },
    async readBody(article: string) {
      return unwrap(await service.readBody(article), workspaceResultCodec);
    },
    async writeBody(article: string, html: string, hash: string) {
      return unwrap(await service.writeBody(article, html, hash), writeBodyResultCodec);
    },
  };
}

async function unwrap<T, E>(
  wire: import("better-result").SerializedResult<T, E | { code: "invalid_result_envelope" }>,
  codec: {
    deserialize(
      value: unknown,
    ): Promise<import("better-result").Result<T, E | { code: "invalid_result_envelope" }>>;
  },
) {
  const result = await codec.deserialize(wire);
  return Result.isOk(result)
    ? { ok: true as const, value: result.value }
    : { ok: false as const, error: result.error };
}

describe("workspace hash and article lifecycle", () => {
  test("returns actual editor hashes on list-open, new, and pull paths", async () => {
    const saved = fixture({ saved: true, html: "<p>saved</p>" });
    const listed = await saved.workspace.listArticles();
    expect(listed).toEqual({ ok: true, value: [{ candidate: "g1", title: "Draft" }] });
    if (!listed.ok) return;
    const opened = await saved.workspace.openArticle(listed.value[0]!.candidate);
    expect(opened).toEqual({
      ok: true,
      value: { article: expect.any(String), title: "Draft", bodyHash: await hash("<p>saved</p>") },
    });
    if (!opened.ok) return;
    expect(await saved.workspace.readBody(opened.value.article)).toEqual({
      ok: true,
      value: { html: "<p>saved</p>", bodyHash: await hash("<p>saved</p>") },
    });

    const blank = fixture({ html: "" });
    const created = await blank.workspace.newArticle();
    expect(created).toMatchObject({ ok: true, value: { title: "", bodyHash: await hash("") } });
  });

  test("maps hash failures to page_failed on open, new, current, and read paths", async () => {
    const originalDigest = crypto.subtle.digest;
    crypto.subtle.digest = (() =>
      Promise.reject(new Error("offline crypto"))) as typeof originalDigest;
    try {
      const opened = await fixture({ saved: true }).workspace.openArticle("g1");
      expect(opened).toEqual({
        ok: false,
        error: { code: "page_failed", stage: "editor_bootstrap_failed", pageCreated: true },
      });

      const created = await fixture().workspace.newArticle();
      expect(created).toEqual({
        ok: false,
        error: { code: "page_failed", stage: "editor_bootstrap_failed", pageCreated: true },
      });

      const current = await fixture().workspace.currentArticle();
      expect(current).toEqual({ ok: false, error: { code: "page_failed" } });
    } finally {
      crypto.subtle.digest = originalDigest;
    }

    const readable = fixture();
    const article = await readable.workspace.newArticle();
    if (!article.ok) throw new Error("article setup failed");
    crypto.subtle.digest = (() =>
      Promise.reject(new Error("offline crypto"))) as typeof originalDigest;
    try {
      expect(await readable.workspace.readBody(article.value.article)).toEqual({
        ok: false,
        error: { code: "page_failed" },
      });
    } finally {
      crypto.subtle.digest = originalDigest;
    }
  });

  test("preserves write certainty when hashing fails before versus after dispatch", async () => {
    const before = fixture({ html: "baseline" });
    const beforeArticle = await before.workspace.newArticle();
    if (!beforeArticle.ok) throw new Error("article setup failed");

    const originalDigest = crypto.subtle.digest;
    crypto.subtle.digest = (() =>
      Promise.reject(new Error("offline crypto"))) as typeof originalDigest;
    try {
      expect(
        await before.workspace.writeBody(
          beforeArticle.value.article,
          "replacement",
          beforeArticle.value.bodyHash,
        ),
      ).toEqual({ ok: false, error: { code: "page_failed" } });
      expect(before.calls).not.toContain("mutation");
    } finally {
      crypto.subtle.digest = originalDigest;
    }

    const after = fixture({ html: "baseline" });
    const afterArticle = await after.workspace.newArticle();
    if (!afterArticle.ok) throw new Error("article setup failed");
    let digestCalls = 0;
    crypto.subtle.digest = ((...args: Parameters<typeof originalDigest>) => {
      digestCalls++;
      return digestCalls === 2
        ? Promise.reject(new Error("offline crypto"))
        : originalDigest.apply(crypto.subtle, args);
    }) as typeof originalDigest;
    try {
      expect(
        await after.workspace.writeBody(
          afterArticle.value.article,
          "replacement",
          afterArticle.value.bodyHash,
        ),
      ).toEqual({ ok: false, error: { code: "write_unknown" } });
      expect(after.calls.filter((call) => call === "mutation")).toHaveLength(1);
    } finally {
      crypto.subtle.digest = originalDigest;
    }
  });

  test("a repeated or failed list does not invalidate an already listed group", async () => {
    const { workspace } = fixture();
    const first = await workspace.listArticles();
    if (!first.ok) throw new Error("initial list failed");
    const again = await workspace.listArticles();
    expect(again.ok).toBe(true);
    expect((await workspace.openArticle(first.value[0]!.candidate)).ok).toBe(true);
  });

  test("revalidates the current group and document before opening saved content", async () => {
    const { workspace, calls } = fixture({
      saved: true,
      groups: [{ groupId: "g1", title: "Draft" }],
    });
    const listed = await workspace.listArticles();
    if (!listed.ok) throw new Error("list failed");
    const opened = await workspace.openArticle("missing-group");
    expect(opened).toMatchObject({ ok: false, error: { code: "target_unavailable" } });
    expect(calls).not.toContain("edit:missing-group");
    expect((await workspace.openArticle(listed.value[0]!.candidate)).ok).toBe(true);
  });

  test("caller-owned hash rejects stale writes, while a refreshed hash permits normalized writes", async () => {
    const { workspace, calls, setBody } = fixture({ html: "<p>H0</p>" });
    const created = await workspace.newArticle();
    if (!created.ok) throw new Error("new article failed");
    const stale = created.value.bodyHash;
    const externalBody = "<p>external H1</p>";
    setBody(externalBody);
    const pulled = await workspace.readBody(created.value.article);
    if (!pulled.ok) throw new Error("pull failed");
    expect(pulled.value.bodyHash).toBe(await hash(externalBody));

    const conflict = await workspace.writeBody(created.value.article, "stale A", stale);
    expect(conflict).toEqual({ ok: false, error: { code: "content_conflict" } });
    expect(calls.filter((call) => call === "mutation")).toHaveLength(0);

    const refreshed = await workspace.readBody(created.value.article);
    if (!refreshed.ok) throw new Error("refresh pull failed");
    expect(refreshed.value.bodyHash).toBe(await hash(externalBody));
    const winner = await workspace.writeBody(
      created.value.article,
      "<p> winner </p>",
      refreshed.value.bodyHash,
    );
    expect(winner).toMatchObject({ ok: true, value: { bodyHash: await hash("<p> winner </p>") } });
    if (!winner.ok) return;
    expect(
      await workspace.writeBody(created.value.article, "<p>next</p>", winner.value.bodyHash),
    ).toMatchObject({ ok: true });
  });

  test("preserves conflict and unknown-write outcomes from the editor bridge", async () => {
    for (const code of ["content_conflict", "write_unknown"] as const) {
      const { workspace } = fixture({ setResult: { ok: false, code } });
      const created = await workspace.newArticle();
      if (!created.ok) throw new Error("new article failed");
      expect(
        await workspace.writeBody(created.value.article, "replacement", created.value.bodyHash),
      ).toEqual({ ok: false, error: { code } });
    }
  });

  test("retains login and current-document guards before body access", async () => {
    const { workspace, pages, calls } = fixture();
    const created = await workspace.newArticle();
    if (!created.ok) throw new Error("new article failed");
    pages.loseCurrent();
    expect(await workspace.readBody(created.value.article)).toEqual({
      ok: false,
      error: { code: "target_unavailable" },
    });
    expect(
      await workspace.writeBody(created.value.article, "replacement", created.value.bodyHash),
    ).toEqual({ ok: false, error: { code: "target_unavailable" } });
    expect(calls.filter((call) => call === "get" || call === "mutation")).toEqual(["get"]);
  });

  test("independent refs share MAIN serialization and cannot overwrite another caller's new version", async () => {
    const f = fixture();
    const a = await f.workspace.newArticle();
    const b = await f.workspace.newArticle();
    if (!a.ok || !b.ok) throw new Error("new failed");
    expect(a.value.article).not.toBe(b.value.article);
    const results = await Promise.all([
      f.workspace.writeBody(a.value.article, "first", a.value.bodyHash),
      f.workspace.writeBody(b.value.article, "second", b.value.bodyHash),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: "content_conflict" } },
    ]);
    expect(f.calls.filter((call) => call === "mutation")).toHaveLength(1);
  });

  test("pre-dispatch page lookup failure is not reported as an uncertain mutation", async () => {
    const f = fixture();
    const created = await f.workspace.newArticle();
    if (!created.ok) throw new Error("new failed");
    f.pages.pageStatus = async () => Result.err({ code: "page_failed" as const }) as never;
    expect(
      await f.workspace.writeBody(created.value.article, "replacement", created.value.bodyHash),
    ).toEqual({ ok: false, error: { code: "page_failed" } });
    expect(f.calls).not.toContain("mutation");
  });

  test("complete login timeout blocks new and saved refs before body access", async () => {
    for (const saved of [false, true]) {
      const f = fixture({ saved });
      const opened = saved ? await f.workspace.openArticle("g1") : await f.workspace.newArticle();
      if (!opened.ok) throw new Error("open failed");
      f.pages.setStatus("not_logged_in");
      expect(await f.workspace.readBody(opened.value.article)).toEqual({
        ok: false,
        error: { code: "not_logged_in" },
      });
      expect(
        await f.workspace.writeBody(opened.value.article, "replacement", opened.value.bodyHash),
      ).toEqual({ ok: false, error: { code: "not_logged_in" } });
      expect(f.calls).not.toContain("mutation");
    }
  });

  test("new and saved target login failures retain pageCreated without navigation-stage substitution", async () => {
    const fresh = fixture();
    fresh.pages.setLoginAfterDraftOpen();
    expect(await fresh.workspace.newArticle()).toEqual({
      ok: false,
      error: { code: "not_logged_in", pageCreated: true },
    });

    const saved = fixture({ saved: true });
    saved.pages.setLoginAfterDraftOpen();
    expect(await saved.workspace.openArticle("g1")).toEqual({
      ok: false,
      error: { code: "not_logged_in", pageCreated: true },
    });
  });

  test("new and saved target lookup failures retain pageCreated and original error code", async () => {
    const fresh = fixture();
    fresh.pages.setEditorLookupFailure();
    expect(await fresh.workspace.newArticle()).toEqual({
      ok: false,
      error: { code: "page_failed", pageCreated: true },
    });

    const saved = fixture({ saved: true });
    saved.pages.setEditorLookupFailure();
    expect(await saved.workspace.openArticle("g1")).toEqual({
      ok: false,
      error: { code: "page_failed", pageCreated: true },
    });
  });

  test("stored article refs and current-editor failures do not retain a historical pageCreated fact", async () => {
    const stored = fixture();
    const created = await stored.workspace.newArticle();
    if (!created.ok) throw new Error("article setup failed");
    stored.pages.setStatus("not_logged_in");
    expect(await stored.workspace.readBody(created.value.article)).toEqual({
      ok: false,
      error: { code: "not_logged_in" },
    });

    const current = fixture();
    current.pages.setStatus("not_logged_in");
    expect(await current.workspace.currentArticle()).toEqual({
      ok: false,
      error: { code: "not_logged_in" },
    });
  });

  test("page change during initial HTML read prevents new and saved ref issuance", async () => {
    for (const saved of [false, true]) {
      const f = fixture({ saved });
      f.pages.open = async () =>
        Result.ok({
          ...f.editor,
          getContent: async () => {
            f.pages.loseCurrent();
            const encoded = await pageEditorContentResultCodec.serialize(Result.ok("old body"));
            return Result.isOk(encoded) ? encoded.value : { status: "error", error: encoded.error };
          },
        });
      const result = saved ? await f.workspace.openArticle("g1") : await f.workspace.newArticle();
      expect(result).toEqual({
        ok: false,
        error: { code: "target_unavailable", pageCreated: true },
      });
    }
  });
  test("a fresh background can reacquire a unique existing editor without creating a new page", async () => {
    const f = fixture();
    const old = await f.workspace.newArticle();
    if (!old.ok) throw new Error("new failed");
    f.setBody("unsaved user content");
    const restarted = domainWorkspace(createWorkspace({ pages: f.pages as never }));
    expect(await restarted.readBody(old.value.article)).toEqual({
      ok: false,
      error: { code: "target_unavailable" },
    });
    const current = await restarted.currentArticle();
    if (!current.ok) throw new Error("current failed");
    expect(current.value.bodyHash).toBe(await hash("unsaved user content"));
    expect(await restarted.readBody(current.value.article)).toEqual({
      ok: true,
      value: { html: "unsaved user content", bodyHash: current.value.bodyHash },
    });
    expect(f.calls).not.toContain("mutation");
    expect(f.calls.some((call) => call.startsWith("edit:"))).toBe(false);
  });
});
