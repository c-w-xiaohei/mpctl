import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { installIdbFixture } from "./idb-fixture";
import { materialIdentity, uploadReceipt } from "./upload-fixture";
let restoreIdb: () => void;
beforeEach(() => {
  restoreIdb = installIdbFixture();
});
afterEach(() => {
  restoreIdb();
});
import { Result } from "better-result";
import { Nexus } from "@nexus-js/core";
import { createPageManager, appmsgRouteIdentity } from "../src/pages";
import { createPageEndpoint } from "../src/transport/page-bridge";
import {
  contentStatusToken,
  draftPageToken,
  contentStatusResultCodec,
  validateDraftResultCodec,
  currentItemCountResultCodec,
} from "../src/background-contracts";
import { createWorkspace } from "../src/workspace";
import { createEditorService } from "../src/mp/jsapi";
import { createOperations } from "../src/operations";
import {
  createArticleFieldsService,
  createContentStatusService,
  initializeContentServices,
  contentAuthorizationPolicy,
} from "../entrypoints/mp.content";
import {
  pageEditorReadyResultCodec,
  bodyRequestDigest,
  type BodyExecution,
} from "../src/page-contracts";
import { articleFieldsToken } from "../src/background-contracts";
import { type ContentAppMeta } from "../src/background-runtime";
import type { ChromeAdapterModel } from "@nexus-js/chrome";
import {
  articleCoverResultCodec,
  articleResultCodec,
  listArticlesResultCodec,
  workspaceResultCodec,
  articleFieldsResultCodec,
  articleCheckResultCodec,
  assetListResultCodec,
  operationResultCodec,
  protocolVersion,
} from "@mpctl/contracts";
import {
  pageEditorContentResultCodec,
  pageEditorWriteResultCodec,
  pageEditorToken,
  type PageEditorService,
} from "../src/page-contracts";

const editorEndpoints: Array<() => void> = [];
afterEach(() => {
  for (const close of editorEndpoints.splice(0)) close();
});
async function remoteEditor(service: PageEditorService) {
  const target = new EventTarget();
  const channelId = crypto.randomUUID();
  const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
  const providerEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
  const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
  editorEndpoints.push(() => {
    providerEndpoint.close();
    clientEndpoint.close();
  });
  const provider = new Nexus()
    .configure({
      endpoint: { implementation: providerEndpoint, meta: { app: { protocolVersion } } },
    })
    .provide(pageEditorToken, service);
  const client = new Nexus().configure({
    endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
  });
  await Promise.all([provider.ready(), client.ready()]);
  const remote = (await client.connect({ target: {} })).get(pageEditorToken);
  const binding = {
    tabId: 2,
    documentId: "fixture-editor",
    url: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
  };
  const manager = createPageManager(
    { getTab: async () => ({ id: binding.tabId, url: binding.url }) } as never,
    async () => remote,
  );
  manager.observe(binding);
  editorEndpoints.push(() => manager.dispose());
  return (await manager.open(binding)).unwrap();
}

const fixtureExecutorId = crypto.randomUUID();
const confirmedNavigation = {
  state: "settled",
  effect: { outcome: "confirmed", targetBound: true },
  result: { status: "ok" },
};
async function operationId(operations: ReturnType<typeof createOperations>) {
  return `op:${(await operations).unwrap().ledgerId}:${crypto.randomUUID()}`;
}
async function receipt(wire: Promise<unknown>) {
  return (await operationResultCodec.deserialize(await wire)).unwrap();
}
async function expectSnapshot(wire: Promise<unknown>, expected: object) {
  expect((await receipt(wire)).snapshot).toMatchObject(expected);
}
const hash = (html: string) =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(html))
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );

test("G1 workspace old positional BODY invocation is rejected before target acquisition", async () => {
  let acquisitions = 0;
  const service = createWorkspace({
    pages: {
      open() {
        acquisitions++;
        throw new Error("must not acquire");
      },
    } as never,
  });
  const reply = await service.writeBody("ref" as never);
  expect(reply).toEqual({ status: "error", error: { failure: { code: "invalid_operation" } } });
  expect(acquisitions).toBe(0);
});
test("F0 unresolved BODY blocks old mutators while pure reads remain available", async () => {
  let nativeWrites = 0;
  const operations = (await createOperations()).unwrap();
  await operations.run(
    {
      operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
      article: "original",
      html: "x",
      expectedHash: "a".repeat(64),
    },
    (execution) =>
      execution.issue(
        { tabId: 2, documentId: "doc", route: "new", executorId: crypto.randomUUID() },
        async () => ({
          effect: { outcome: "unknown" },
          ended: false,
          result: { status: "error", error: { code: "operation_unresolved" } },
        }),
      ),
  );
  const pages = {
    async cleanupWorkspace() {
      nativeWrites++;
      return Result.ok({ groupsRemoved: 0, tabsMoved: 0, groupsRemaining: 0 });
    },
    async ensureEditorTab() {
      nativeWrites++;
      throw new Error("must not create");
    },
  };
  const service = createWorkspace({
    pages: pages as never,
    operations: Promise.resolve(Result.ok(operations)),
  });
  const cleanup = await service.cleanupWorkspace();
  const create = await service.newArticle(undefined as never);
  expect(cleanup.status === "error" && cleanup.error.code).toBe("operation_blocked");
  expect(create).toEqual({ status: "error", error: { failure: { code: "invalid_operation" } } });
  expect(nativeWrites).toBe(0);
});

function fixture(
  options: {
    groups?: Array<{ groupId: string; title: string }>;
    html?: string;
    saved?: boolean;
    nativeSaveFailure?: boolean;
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
  let invalidateAfterFieldRead = false;
  let failBodyRead = false;
  let invalidateAfterBodyRead = false;
  let savedCoverHash = "c".repeat(64);
  let nativeSaveCount = 0;
  let materials: Array<{ filename: string; thumbnailUrl?: string }> = [];
  let uploadGate: Promise<void> | undefined;
  let uploadFailure: import("@mpctl/contracts").Failure | undefined;
  let uploadStarted!: () => void;
  const uploadStartedPromise = new Promise<void>((resolve) => {
    uploadStarted = resolve;
  });
  const listOptions: unknown[] = [];
  const openOptions: unknown[] = [];
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
        if (failBodyRead) {
          request.errCb({ msg: "read failed" });
          return;
        }
        if (invalidateAfterBodyRead) current = false;
        request.sucCb({ content: body });
      } else {
        calls.push("mutation");
        body = ("content" in request.apiParam ? request.apiParam.content : "")
          .trim()
          .replace(/\s+/g, " ");
        request.sucCb({ msg: "ok" });
      }
    },
  });
  const wireEditor: PageEditorService = {
    setCoverFromBody: (input) => editor.setCoverFromBody(input),
    getCoverReceipt: (id) => editor.getCoverReceipt(id),
    ready: () => editor.ready(),
    getContent: () => editor.getContent(),
    getReceipt: (id) => editor.getReceipt(id),
    async setContent(html: string, expectedHash: string, execution: BodyExecution) {
      if (options.setResult) {
        const result = options.setResult;
        const encoded = await pageEditorWriteResultCodec.serialize(
          result.ok
            ? Result.ok({
                ...execution,
                requestDigest: await bodyRequestDigest(html, expectedHash),
                effect: { outcome: "confirmed" as const, bodyHash: result.bodyHash },
                ended: true,
                result: { status: "ok" as const, value: {} },
              })
            : Result.err({ code: result.code }),
        );
        return Result.isOk(encoded) ? encoded.value : { status: "error", error: encoded.error };
      }
      return editor.setContent(html, expectedHash, execution);
    },
  };
  const pages = {
    async getExecutionReceipt(
      _binding: import("../src/operations").OperationTarget,
      _id: string,
      _operation: "body" | "fields" | "upload" | "cover" | "save",
    ): Promise<
      Result<
        | import("../src/background-contracts").CoverReceipt
        | import("../src/background-contracts").SaveReceipt
        | null,
        import("@mpctl/contracts").Failure
      >
    > {
      return Result.ok(null);
    },
    async ensureDraftList(options?: { refresh?: boolean }) {
      listOptions.push(options);
      return Result.ok(list);
    },
    async ensureEditorTab(progress?: import("../src/pages").NavigationProgress) {
      await progress?.created("editor");
      await progress?.bound(editorBinding);
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
    async findDraftList() {
      return Result.ok(list);
    },
    async openDraftGroup(
      _binding: unknown,
      groupId: string,
      progress?: import("../src/pages").NavigationProgress,
    ) {
      openOptions.push(undefined);
      calls.push(`edit:${groupId}`);
      if (failLoginAfterDraftOpen) state = "not_logged_in";
      if (groupId !== "g1") return Result.ok(undefined);
      const binding = { ...editorBinding, documentId: "saved-editor-fresh" };
      await progress?.created("editor");
      await progress?.bound(binding);
      return Result.ok(binding);
    },
    async findCurrentEditor(selection?: import("@mpctl/contracts").ArticleCurrentInput) {
      if (selection?.candidate) return Result.ok(undefined);
      return Result.ok(editorBinding);
    },
    async validateSavedArticle(_binding: unknown, groupId: string) {
      return Result.ok({ valid: groupId === "g1", title: "Draft" });
    },
    async open(_binding: typeof editorBinding) {
      return Result.ok(await remoteEditor(wireEditor));
    },
    async readArticleFields(): Promise<
      import("../src/pages").PageManagerResult<{ title: string; author: string; summary: string }>
    > {
      calls.push("fields");
      if (invalidateAfterFieldRead) current = false;
      return Result.ok({
        title: " Title ",
        author: "作者",
        summary: "",
      });
    },
    async readArticleCover(): Promise<import("../src/pages").PageManagerResult<string>> {
      calls.push("cover-read");
      return Result.ok(savedCoverHash);
    },
    async coverIdentity() {
      return Result.ok({ executorId: fixtureExecutorId });
    },
    async setArticleCover(
      _binding: unknown,
      _candidate: unknown,
      expected: string,
      execution: import("../src/background-contracts").CoverExecution,
    ) {
      calls.push("cover-set");
      if (expected !== savedCoverHash) return Result.err({ code: "content_conflict" as const });
      savedCoverHash = "d".repeat(64);
      return Result.ok({
        operationId: execution.operationId,
        executorId: execution.executorId,
        requestDigest: await import("../src/background-contracts").then((m) =>
          m.coverRequestDigest(execution.asset, expected),
        ),
        effect: { cover: true as const, outcome: "confirmed" as const, coverHash: savedCoverHash },
        ended: true,
        result: { status: "ok" as const, value: {} },
      });
    },
    async saveArticle(
      _binding: unknown,
      execution: import("../src/background-contracts").SaveExecution,
    ) {
      calls.push("native-save");
      nativeSaveCount++;
      if (options.nativeSaveFailure) return Result.err({ code: "save_unknown" as const });
      return Result.ok({
        operationId: execution.operationId,
        executorId: execution.executorId,
        requestDigest: await import("../src/background-contracts").then((m) =>
          m.saveRequestDigest(execution),
        ),
        effect: { outcome: "confirmed" as const, persistence: "unverified" as const },
        ended: true,
        result: { status: "ok" as const, value: {} },
      });
    },
    async fieldsIdentity() {
      return Result.ok({ executorId: fieldsExecutorId });
    },
    async updateArticleFields(
      _binding: unknown,
      fields: { title?: string; author?: string; summary?: string },
      expectedHash: string,
      execution: import("../src/background-contracts").FieldsExecution,
    ): Promise<
      Result<
        import("../src/background-contracts").FieldsReceipt,
        import("@mpctl/contracts").Failure
      >
    > {
      const original = { title: " Title ", author: "作者", summary: "" };
      if ((await hashArticleFields(original)).unwrap() !== expectedHash)
        return Result.ok({
          ...execution,
          requestDigest: await fieldsRequestDigest(fields, expectedHash),
          effect: {
            outcome: "not_dispatched",
            requested: (["title", "author", "summary"] as const).filter(
              (name) => fields[name] !== undefined,
            ),
            attempted: [],
            confirmed: [],
            unknown: [],
          },
          ended: true,
          result: { status: "error", error: { code: "content_conflict" } },
        });
      calls.push("field-write");
      current = false;
      return Result.ok(await fieldsReceipt(fields, expectedHash, execution, "a".repeat(64)));
    },
    async listMaterials() {
      calls.push("materials-list");
      return Result.ok({ scope: "visible-page" as const, cards: materials });
    },
    async uploadMaterial(
      _binding: unknown,
      payload: import("@mpctl/contracts").AssetPayload,
      execution: import("../src/background-contracts").UploadExecution,
    ) {
      calls.push("materials-upload");
      uploadStarted();
      await uploadGate;
      if (uploadFailure)
        return Result.ok({
          ...(await uploadReceipt(payload, execution)),
          result: { status: "error" as const, error: uploadFailure },
          ended: false,
        });
      materials = [
        ...materials,
        { filename: payload.filename, thumbnailUrl: "https://mmbiz.qpic.cn/test/300" },
      ];
      return Result.ok(await uploadReceipt(payload, execution));
    },
    materialIdentity: async () => Result.ok((await materialIdentity.identity()).value),
    setMaterials(cards: typeof materials) {
      materials = cards;
    },
    setUploadGate(gate?: Promise<void>) {
      uploadGate = gate;
    },
    failUpload(error: typeof uploadFailure) {
      uploadFailure = error;
    },
    uploadStarted: () => uploadStartedPromise,
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
    invalidateAfterFieldRead() {
      invalidateAfterFieldRead = true;
    },
    failBodyRead() {
      failBodyRead = true;
    },
    invalidateAfterBodyRead() {
      invalidateAfterBodyRead = true;
    },
    nativeSaveCount: () => nativeSaveCount,
  };
  const databaseName = `workspace-fixture:${crypto.randomUUID()}`;
  const operations = createOperations(databaseName);
  const service = createWorkspace({ pages: pages as never, operations });
  return {
    workspace: service,
    service,
    operations,
    databaseName,
    calls,
    listOptions,
    openOptions,
    pages,
    editorBinding,
    setBody,
    editor,
  };
}

describe("article-scoped asset workspace", () => {
  test.each([
    "unknown",
    "cleanup",
    "confirmed-failure",
    "wrong-executor",
    "wrong-digest",
    "late-success",
    "lost-result",
  ] as const)("native-only SAVE %s retains original facts without extra work", async (mode) => {
    const f = fixture({ saved: true });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    const fields = await readValue(
        f.workspace.inspectArticle(article.article),
        articleFieldsResultCodec,
      ),
      cover = await readValue(
        f.workspace.readArticleCover(article.article),
        articleCoverResultCodec,
      );
    const operations = (await f.operations).unwrap();
    const input = {
      operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
      article: article.article,
      expectedBodyHash: article.bodyHash,
      expectedFieldsHash: fields.fieldsHash,
      expectedCoverHash: cover.coverHash,
    };
    const save = f.pages.saveArticle.bind(f.pages);
    let nativeReceipt: any;
    f.pages.saveArticle = async (...args) => {
      nativeReceipt = (await save(...args)).unwrap();
      if (mode === "wrong-executor") nativeReceipt.executorId = crypto.randomUUID();
      if (mode === "wrong-digest") nativeReceipt.requestDigest = "f".repeat(64);
      if (mode === "unknown")
        nativeReceipt.effect = { outcome: "unknown", persistence: "unverified" };
      if (mode === "lost-result") nativeReceipt.result = undefined;
      if (
        mode === "cleanup" ||
        mode === "confirmed-failure" ||
        mode === "unknown" ||
        mode === "late-success"
      ) {
        nativeReceipt.ended = mode === "confirmed-failure";
        nativeReceipt.result = {
          status: "error",
          error: {
            code: mode === "cleanup" ? "cleanup_failed" : "save_unknown",
            cause: {
              at: "content.save_confirm",
              kind: "runtime",
              code: mode === "cleanup" ? "cleanup_failed" : "native_timeout",
            },
          },
        };
      }
      return Result.ok(nativeReceipt);
    };
    f.calls.length = 0;
    const first = await receipt(f.service.saveArticle(input));
    expect(first.snapshot).toMatchObject({
      state: mode === "confirmed-failure" || mode === "lost-result" ? "settled" : "unresolved",
      effect: {
        outcome:
          mode === "cleanup" ||
          mode === "confirmed-failure" ||
          mode === "late-success" ||
          mode === "lost-result"
            ? "confirmed"
            : "unknown",
        persistence: "unverified",
      },
      result: {
        status: "error",
        error: {
          code: mode.startsWith("wrong")
            ? "evidence_conflict"
            : mode === "lost-result"
              ? "operation_unresolved"
              : mode === "cleanup"
                ? "cleanup_failed"
                : "save_unknown",
        },
      },
    });
    expect(f.calls.slice(f.calls.indexOf("native-save") + 1)).toEqual([]);
    const before = [...f.calls];
    if (mode === "late-success") {
      nativeReceipt.ended = true;
      nativeReceipt.result = { status: "ok", value: {} };
      f.pages.getExecutionReceipt = async () => Result.ok(nativeReceipt);
      expect((await receipt(f.service.getOperation(input.operationId))).snapshot).toMatchObject({
        state: "settled",
        effect: { outcome: "confirmed", persistence: "unverified" },
        result: { status: "error", error: { code: "save_unknown" } },
      });
    }
    await f.service.saveArticle(input);
    expect(f.calls).toEqual(before);
    expect(f.pages.nativeSaveCount()).toBe(1);
  });
  test("native-only SAVE confirms once with zero post-native reads or navigation and preserves the article", async () => {
    const f = fixture({ saved: true });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    const fields = await readValue(
      f.workspace.inspectArticle(article.article),
      articleFieldsResultCodec,
    );
    const cover = await readValue(
      f.workspace.readArticleCover(article.article),
      articleCoverResultCodec,
    );
    const operations = (await f.operations).unwrap();
    const input = {
      operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
      article: article.article,
      expectedBodyHash: article.bodyHash,
      expectedFieldsHash: fields.fieldsHash,
      expectedCoverHash: cover.coverHash,
    };
    f.calls.length = 0;
    const first = await receipt(f.service.saveArticle(input));
    expect(f.calls.slice(f.calls.indexOf("native-save") + 1)).toEqual([]);
    expect(first.snapshot).toMatchObject({
      state: "settled",
      effect: { outcome: "confirmed", persistence: "unverified" },
      result: { status: "ok", value: {} },
    });
    expect(f.pages.nativeSaveCount()).toBe(1);
    const before = [...f.calls];
    expect((await receipt(f.service.saveArticle(input))).snapshot).toEqual(first.snapshot);
    expect((await receipt(f.service.getOperation(input.operationId))).snapshot).toEqual(
      first.snapshot,
    );
    expect(
      await f.service.saveArticle({ ...input, expectedBodyHash: "f".repeat(64) }),
    ).toMatchObject({ status: "error", error: { failure: { code: "operation_conflict" } } });
    expect(f.calls).toEqual(before);
    expect((await decode(f.workspace.readBody(input.article), workspaceResultCodec)).isOk()).toBe(
      true,
    );
  });
  test("explicit saved open sends a positively expired shortcut through list/open without binding old document", async () => {
    const f = fixture({ saved: true });
    f.pages.findCurrentEditor = async () => Result.ok(f.editorBinding);
    const oldStatus = f.pages.pageStatus.bind(f.pages);
    const status = spyOn(f.pages, "pageStatus").mockImplementation(async (binding) =>
      binding.documentId === "saved-editor"
        ? Result.ok({ state: "not_logged_in" as const, route: "", documentReady: true })
        : oldStatus(binding),
    );
    const open = spyOn(f.pages, "openDraftGroup").mockImplementation(
      async (_list, _candidate, progress) => {
        const fresh = { ...f.editorBinding, documentId: "relogin-fresh" };
        await progress?.bound(fresh);
        return Result.ok(fresh);
      },
    );
    try {
      const operations = (await f.operations).unwrap();
      const id = `op:${operations.ledgerId}:${crypto.randomUUID()}`;
      const result = await receipt(f.service.openArticle({ operationId: id, candidate: "g1" }));
      expect(result.snapshot).toMatchObject({
        operation: "open",
        state: "settled",
        result: { status: "ok" },
      });
      expect(open).toHaveBeenCalledTimes(1);
      expect((await operations.record(id)).unwrap().navigationBinding?.target?.documentId).toBe(
        "relogin-fresh",
      );
      expect(f.calls).not.toContain("native-save");
    } finally {
      status.mockRestore();
      open.mockRestore();
    }
  });
  test("R3 asset cover fixes local intent before preflight without freezing caller input", async () => {
    const f = fixture({ saved: true });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.pages.setMaterials([
      { filename: "original.png", thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/original/300" },
    ]);
    const assets = await readValue(f.workspace.listAssets(article.article), assetListResultCodec);
    const operations = (await f.operations).unwrap();
    const initial = {
      operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
      article: article.article,
      asset: assets.cards[0]!.asset,
      expectedCoverHash: "c".repeat(64),
    };
    const alias = { ...initial };
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((done) => {
        entered = done;
      }),
      gate = new Promise<void>((done) => {
        release = done;
      });
    const read = f.pages.readArticleCover.bind(f.pages);
    const held = spyOn(f.pages, "readArticleCover").mockImplementation(async () => {
      entered();
      await gate;
      return read();
    });
    const set = spyOn(f.pages, "setArticleCover");
    try {
      const task = f.service.setArticleCover(alias);
      await reached;
      Object.assign(alias, {
        article: "ephemeral:other",
        asset: "changed",
        expectedCoverHash: "a".repeat(64),
      });
      release();
      const first = await receipt(task);
      expect(first.snapshot).toMatchObject({ state: "settled", effect: { outcome: "confirmed" } });
      expect(set.mock.calls).toHaveLength(1);
      expect(set.mock.calls[0]![2]).toBe(initial.expectedCoverHash);
      expect(set.mock.calls[0]![3].asset).toBe(initial.asset);
      const { coverRequestDigest } = await import("../src/background-contracts");
      expect((await operations.record(initial.operationId)).unwrap().localRequestDigest).toBe(
        await coverRequestDigest(initial.asset, initial.expectedCoverHash),
      );
      const before = [...f.calls];
      expect((await receipt(f.service.setArticleCover(initial))).snapshot).toEqual(first.snapshot);
      expect(await f.service.setArticleCover(alias)).toMatchObject({
        status: "error",
        error: { failure: { code: "operation_conflict" } },
      });
      expect(f.calls).toEqual(before);
      expect(Object.isFrozen(alias)).toBe(false);
    } finally {
      release();
      held.mockRestore();
      set.mockRestore();
    }
  });

  test.each(["cover", "save"] as const)(
    "R3/R5 %s historical receipt validates digest/provider/type and status does zero preflight",
    async (operation) => {
      const f = fixture({ saved: true });
      const operations = (await f.operations).unwrap();
      const id = `op:${operations.ledgerId}:${crypto.randomUUID()}`;
      const input =
        operation === "cover"
          ? {
              operationId: id,
              article: "expired",
              asset: "expired-asset",
              expectedCoverHash: "a".repeat(64),
            }
          : {
              operationId: id,
              article: "expired",
              expectedBodyHash: "a".repeat(64),
              expectedFieldsHash: "b".repeat(64),
              expectedCoverHash: "c".repeat(64),
            };
      const binding = {
        tabId: 2,
        documentId: "doc",
        route: "saved",
        executorId: fixtureExecutorId,
      };
      const effect =
        operation === "cover"
          ? { cover: true as const, outcome: "unknown" as const }
          : { outcome: "unknown" as const, persistence: "unverified" as const };
      await operations.run(input, (execution) =>
        execution.issue(binding, async () => ({
          effect,
          ended: false,
          result: { status: "error", error: { code: "receipt_unreachable" } },
        })),
      );
      const row = (await operations.record(id)).unwrap();
      let receipts = 0;
      let nativeReceipt: any = null;
      // The actual ledger and workspace are under test; only the existing page receipt boundary is substituted.
      f.pages.getExecutionReceipt = (async () => {
        receipts++;
        return Result.ok(nativeReceipt);
      }) as typeof f.pages.getExecutionReceipt;
      const before = [...f.calls];
      for (const mode of ["missing", "wrong-digest", "wrong-provider", "wrong-type"] as const) {
        nativeReceipt =
          mode === "missing"
            ? null
            : {
                operationId: id,
                executorId: mode === "wrong-provider" ? crypto.randomUUID() : fixtureExecutorId,
                requestDigest: mode === "wrong-digest" ? "f".repeat(64) : row.localRequestDigest,
                effect:
                  mode === "wrong-type"
                    ? { outcome: "confirmed", bodyHash: "a".repeat(64) }
                    : effect,
                ended: false,
                result: { status: "error", error: { code: "operation_unresolved" } },
              };
        const query = await receipt(f.service.getOperation(id));
        expect(query.snapshot).toEqual(row.snapshot);
        expect(query.issue?.failure.code).toBe(
          mode === "missing" ? "receipt_missing" : "evidence_conflict",
        );
      }
      expect(receipts).toBe(4);
      expect(f.calls).toEqual(before);
      expect(f.pages.nativeSaveCount()).toBe(0);
    },
  );

  test.each(["body", "fields", "cover"] as const)(
    "B-S1 %s CAS mismatch stays zero native SAVE and same-key performs zero rechecks",
    async (part) => {
      const f = fixture({ saved: true });
      const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
      const fields = await readValue(
        f.workspace.inspectArticle(article.article),
        articleFieldsResultCodec,
      );
      const cover = await readValue(
        f.workspace.readArticleCover(article.article),
        articleCoverResultCodec,
      );
      const operations = (await f.operations).unwrap();
      const input = {
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
        article: article.article,
        expectedBodyHash: part === "body" ? "f".repeat(64) : article.bodyHash,
        expectedFieldsHash: part === "fields" ? "f".repeat(64) : fields.fieldsHash,
        expectedCoverHash: part === "cover" ? "f".repeat(64) : cover.coverHash,
      };
      const first = await receipt(f.service.saveArticle(input));
      expect(first.snapshot).toMatchObject({
        state: "settled",
        effect: { outcome: "not_dispatched", persistence: "unverified" },
        result: { status: "error", error: { code: "content_conflict" } },
      });
      const before = [...f.calls];
      expect(await receipt(f.service.saveArticle(input))).toEqual(first);
      expect(f.calls).toEqual(before);
      expect(f.pages.nativeSaveCount()).toBe(0);
    },
  );

  test("B-S4/K3 native-only SAVE key bypasses invalid references and never revives a handle", async () => {
    const f = fixture({ saved: true });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    const fields = await readValue(
      f.workspace.inspectArticle(article.article),
      articleFieldsResultCodec,
    );
    const cover = await readValue(
      f.workspace.readArticleCover(article.article),
      articleCoverResultCodec,
    );
    const operations = (await f.operations).unwrap();
    const input = {
      operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
      article: article.article,
      expectedBodyHash: article.bodyHash,
      expectedFieldsHash: fields.fieldsHash,
      expectedCoverHash: cover.coverHash,
    };
    const first = await receipt(f.service.saveArticle(input));
    expect(first.snapshot).toMatchObject({
      state: "settled",
      effect: { outcome: "confirmed", persistence: "unverified" },
      result: { status: "ok", value: {} },
    });
    const before = [...f.calls];
    f.pages.isCurrent = async () => Result.ok(false);
    const repeat = await receipt(f.service.saveArticle(input));
    const status = await receipt(f.service.getOperation(input.operationId));
    expect(repeat).toEqual(first);
    expect(status).toEqual(first);
    expect(f.calls).toEqual(before);
    expect(f.pages.nativeSaveCount()).toBe(1);
    expect(f.calls.filter((call) => call === "reload-saved")).toHaveLength(0);
  });
  test("B-C3/K3 cover duplicate returns original hash without resolving invalid article/asset", async () => {
    const f = fixture({ saved: true });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.pages.setMaterials([
      { filename: "cover.png", thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/cover/300" },
    ]);
    const assets = await readValue(f.workspace.listAssets(article.article), assetListResultCodec);
    const cover = await readValue(
      f.workspace.readArticleCover(article.article),
      articleCoverResultCodec,
    );
    const operations = (await f.operations).unwrap();
    const input = {
      operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
      article: article.article,
      asset: assets.cards[0]!.asset,
      expectedCoverHash: cover.coverHash,
    };
    const first = await receipt(f.service.setArticleCover(input));
    expect(first.snapshot).toMatchObject({
      operation: "cover",
      state: "settled",
      effect: { cover: true, outcome: "confirmed", coverHash: "d".repeat(64) },
    });
    const before = [...f.calls];
    f.pages.isCurrent = async () => Result.ok(false);
    expect(await receipt(f.service.setArticleCover(input))).toEqual(first);
    expect(await receipt(f.service.getOperation(input.operationId))).toEqual(first);
    expect(f.calls).toEqual(before);
    expect(f.calls.filter((call) => call === "cover-set")).toHaveLength(1);
  });
  test.each(["legacy", "enriched"] as const)(
    "W2 correction cover read/preflight %s retains primary facts with zero set",
    async (mode) => {
      const f = fixture();
      const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
      f.pages.setMaterials([{ filename: "x.png", thumbnailUrl: "https://mmbiz.qpic.cn/test/300" }]);
      const listed = await readValue(f.workspace.listAssets(article.article), assetListResultCodec);
      const asset = listed.cards[0]!.asset;
      const readFailure = {
        stage: "native_read",
        kind: "runtime",
        causeCode: "cover_read_failed",
        component: "cover",
      } as const;
      const error = {
        code: "cover_unavailable" as const,
        ...(mode === "enriched" ? { readFailure } : {}),
      };
      f.pages.readArticleCover = async () => Result.err(error);
      let sets = 0;
      f.pages.setArticleCover = async () => {
        sets++;
        throw new Error("must not dispatch");
      };
      expect(
        await decode(f.workspace.readArticleCover(article.article), articleCoverResultCodec),
      ).toEqual(Result.err(error));
      await expectSnapshot(
        f.workspace.setArticleCover({
          operationId: await operationId(f.operations),
          article: article.article,
          asset: asset,
          expectedCoverHash: "0".repeat(64),
        }),
        {
          effect: { cover: true, outcome: "not_dispatched" },
          result: {
            status: "error",
            error: {
              code: "cover_unavailable",
              cause: {
                at: "bg.preflight",
                kind: mode === "enriched" ? "runtime" : "domain",
                code: mode === "enriched" ? "cover_read_failed" : "cover_unavailable",
              },
            },
          },
        },
      );
      expect(sets).toBe(0);
    },
  );
  test("W2 received fields conflict detail survives workspace and read detail never gains effect", async () => {
    const f = fixture();
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    const initial = await readValue(
      f.workspace.inspectArticle(article.article),
      articleFieldsResultCodec,
    );
    f.pages.updateArticleFields = async () =>
      Result.err({
        code: "content_conflict",
        cause: { at: "content.preflight", kind: "domain", code: "content_conflict" },
      });
    await expectSnapshot(
      f.workspace.updateArticleFields({
        operationId: await operationId(f.operations),
        article: article.article,
        fields: { title: "next" },
        expectedHash: initial.fieldsHash,
      }),
      {
        result: {
          status: "error",
          error: {
            code: "content_conflict",
            cause: { at: "content.preflight", kind: "domain", code: "content_conflict" },
          },
        },
      },
    );
    f.pages.readArticleFields = async () =>
      Result.err({
        code: "page_failed",
        readFailure: {
          stage: "native_read",
          kind: "runtime",
          causeCode: "dom_read_failed",
          component: "fields",
        },
      });
    expect(
      await decode(f.workspace.inspectArticle(article.article), articleFieldsResultCodec),
    ).toMatchObject({
      status: "error",
      error: {
        code: "page_failed",
        readFailure: {
          stage: "native_read",
          kind: "runtime",
          causeCode: "dom_read_failed",
          component: "fields",
        },
      },
    });
    // Field preflight now belongs to its DOM executor. A read-only inspect error
    // is not reconstructed as a mutation outcome by workspace.
    const saved = fixture({ saved: true });
    const savedArticle = await readValue(saved.workspace.currentArticle(), articleResultCodec);
    saved.pages.readArticleFields = f.pages.readArticleFields;
    await expectSnapshot(
      saved.workspace.saveArticle({
        operationId: await operationId(saved.operations),
        article: savedArticle.article,
        expectedBodyHash: savedArticle.bodyHash,
        expectedFieldsHash: "0".repeat(64),
        expectedCoverHash: "0".repeat(64),
      }),
      {
        result: {
          status: "error",
          error: {
            cause: {
              at: "bg.preflight",
              kind: "runtime",
              code: "dom_read_failed",
            },
          },
        },
      },
    );
    expect(saved.pages.nativeSaveCount()).toBe(0);
  });
  test("W2 ordinary workspace DOM inspect stays usable after MAIN loss; cached BODY cannot write", async () => {
    const binding = {
      tabId: 44,
      documentId: "dom-without-main",
      url: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
    };
    const document = {
      location: { href: binding.url },
      readyState: "complete",
      body: { classList: [] },
      querySelector: () => null,
      querySelectorAll(selector: string) {
        const ownerDocument = {
          defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
        };
        const common = {
          isConnected: true,
          hidden: false,
          getClientRects: () => [1],
          ownerDocument,
        };
        if (selector === 'div[contenteditable="true"]')
          return [
            {
              ...common,
              tagName: "DIV",
              innerText: "Title",
              getAttribute: (name: string) =>
                name === "data-placeholder"
                  ? "请在这里输入标题"
                  : name === "contenteditable"
                    ? "true"
                    : null,
            },
          ];
        if (selector === 'input#author[name="author"]')
          return [
            {
              ...common,
              tagName: "INPUT",
              type: "text",
              value: "Author",
              getAttribute: (name: string) =>
                ({ id: "author", name: "author", type: "text" })[name] ?? null,
            },
          ];
        if (selector === 'textarea#js_description[name="digest"]')
          return [
            {
              ...common,
              tagName: "TEXTAREA",
              value: "Summary",
              getAttribute: (name: string) =>
                ({ id: "js_description", name: "digest" })[name] ?? null,
            },
          ];
        return [];
      },
    } as unknown as Document;
    const endpoint = (target: EventTarget, channelId: string, side: "main" | "isolated") =>
      createPageEndpoint({
        target,
        channelId,
        side,
        eventNames: { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` },
      });
    const pageBus = new EventTarget();
    const chromeBus = new EventTarget();
    const endpoints = [
      endpoint(pageBus, "dom-main", "main"),
      endpoint(pageBus, "dom-main", "isolated"),
      endpoint(chromeBus, "dom-chrome", "main"),
      endpoint(chromeBus, "dom-chrome", "isolated"),
    ];
    let mutations = 0;
    const main = new Nexus()
      .configure({ endpoint: { implementation: endpoints[0], meta: { app: { protocolVersion } } } })
      .provide(pageEditorToken, {
        ready: async () =>
          (
            await pageEditorReadyResultCodec.serialize(
              Result.ok({ isReady: true as const, isNew: true, executorId: fixtureExecutorId }),
            )
          ).unwrap(),
        getContent: async () =>
          (await pageEditorContentResultCodec.serialize(Result.ok("body"))).unwrap(),
        setContent: async (html, expectedHash, execution) => {
          mutations++;
          return (
            await pageEditorWriteResultCodec.serialize(
              Result.ok({
                ...execution,
                requestDigest: await bodyRequestDigest(html, expectedHash),
                effect: { outcome: "confirmed", bodyHash: "0".repeat(64) },
                ended: true,
                result: { status: "ok", value: {} },
              }),
            )
          ).unwrap();
        },
        getReceipt: async () => ({ status: "ok" as const, value: null }),
        setCoverFromBody: async () => ({
          status: "error" as const,
          error: { code: "unsupported" as const },
        }),
        getCoverReceipt: async () => ({ status: "ok" as const, value: null }),
      });
    const page = new Nexus().configure({
      endpoint: { implementation: endpoints[1], meta: { app: { protocolVersion } } },
    });
    const content = new Nexus<ChromeAdapterModel<ContentAppMeta>>().configure({
      endpoint: {
        implementation: endpoints[2],
        meta: {
          context: "content-script",
          url: binding.url,
          origin: "https://mp.weixin.qq.com",
          app: { protocolVersion, editorReady: false },
        },
      },
      policy: contentAuthorizationPolicy(() => true),
    });
    content.provide(
      contentStatusToken,
      createContentStatusService(document, () => true),
    );
    content.provide(
      articleFieldsToken,
      createArticleFieldsService(document, () => true),
    );
    const background = new Nexus().configure({
      endpoint: { implementation: endpoints[3], meta: { app: { protocolVersion } } },
    });
    try {
      await Promise.all([main.ready(), page.ready(), content.ready(), background.ready()]);
      expect(
        (
          await initializeContentServices({
            document,
            pageRuntime: page,
            chromeRuntime: content,
            validateTarget: () => true,
            pageState: async () => ({
              state: "ready",
              route: appmsgRouteIdentity(binding.url)!,
              documentReady: true,
            }),
          })
        ).isOk(),
      ).toBe(true);
      const connection = await background.connect({ target: {} });
      const pages = createPageManager(
        {
          async getGroup() {},
          async createTab() {
            throw new Error("must not create");
          },
          async groupTabs() {
            return 7;
          },
          async updateGroup() {},
          async queryGroup() {
            return [{ id: 44, url: binding.url }];
          },
          async getTab() {
            return { id: 44, url: binding.url };
          },
          async getSession() {
            return { managedGroupId: 7 };
          },
          async setSession() {},
        },
        async () => connection.get(pageEditorToken),
        undefined,
        undefined,
        async () => connection,
      );
      pages.observe(binding);
      const workspace = createWorkspace({ pages });
      const acquiredArticle = await articleResultCodec.deserialize(
        await workspace.currentArticle(),
      );
      expect(acquiredArticle).toMatchObject({ status: "ok" });
      const article = acquiredArticle.unwrap();
      const cached = connection.get(pageEditorToken);
      endpoints[0]!.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        (
          await Nexus.safeCall(
            cached.setContent("forbidden", "0".repeat(64), {
              operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
              executorId: fixtureExecutorId,
            }),
          )
        ).isErr(),
      ).toBe(true);
      expect(await pages.pageStatus(binding)).toMatchObject({
        status: "ok",
        value: { state: "ready" },
      });
      expect(await pages.readArticleFields(binding)).toMatchObject({
        status: "ok",
        value: { title: "Title" },
      });
      const inspected = await articleFieldsResultCodec.deserialize(
        await workspace.inspectArticle(article.article),
      );
      expect(inspected).toMatchObject({
        status: "ok",
        value: { title: "Title", author: "Author", summary: "Summary" },
      });
      expect((await pages.pageStatus(binding)).unwrap()).toMatchObject({
        state: "ready",
        documentReady: true,
      });
      expect(mutations).toBe(0);
    } finally {
      for (const endpoint of endpoints) endpoint!.close();
    }
  });
  test("W2 received BODY domain detail survives workspace folding without transport relabeling", async () => {
    const f = fixture();
    const created = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.pages.open = async () =>
      Result.ok(
        await remoteEditor({
          ...f.editor,
          setContent: async (html, expectedHash, execution) =>
            (
              await pageEditorWriteResultCodec.serialize(
                Result.ok({
                  ...execution,
                  requestDigest: await bodyRequestDigest(html, expectedHash),
                  effect: { outcome: "not_dispatched" },
                  ended: true,
                  result: {
                    status: "error",
                    error: {
                      code: "content_conflict",
                      cause: { at: "main.preflight", kind: "domain", code: "content_conflict" },
                    },
                  },
                }),
              )
            ).unwrap(),
        }),
      );
    await expectSnapshot(
      f.workspace.writeBody({
        operationId: await operationId(f.operations),
        article: created.article,
        html: "next",
        expectedHash: created.bodyHash,
      }),
      {
        result: {
          status: "error",
          error: {
            code: "content_conflict",
            cause: { at: "main.preflight", kind: "domain", code: "content_conflict" },
          },
        },
      },
    );
  });
  test("R1 enriched BODY read retains its runtime first cause through SAVE and original-key replay", async () => {
    const f = fixture({ saved: true });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    const fields = await readValue(
      f.workspace.inspectArticle(article.article),
      articleFieldsResultCodec,
    );
    const cover = await readValue(
      f.workspace.readArticleCover(article.article),
      articleCoverResultCodec,
    );
    const readFailure = {
      stage: "native_read" as const,
      kind: "runtime" as const,
      causeCode: "body_read_failed" as const,
      component: "body" as const,
    };
    const wire = (
      await pageEditorContentResultCodec.serialize(Result.err({ code: "page_failed", readFailure }))
    ).unwrap();
    let reads = 0;
    const editor = await remoteEditor({
      ...f.editor,
      getContent: async () => {
        reads++;
        return wire;
      },
    });
    f.pages.open = async () => Result.ok(editor);
    expect(await decode(f.workspace.readBody(article.article), workspaceResultCodec)).toMatchObject(
      { status: "error", error: { code: "page_failed", readFailure } },
    );
    const input = {
      operationId: await operationId(f.operations),
      article: article.article,
      expectedBodyHash: article.bodyHash,
      expectedFieldsHash: fields.fieldsHash,
      expectedCoverHash: cover.coverHash,
    };
    const first = await receipt(f.workspace.saveArticle(input));
    expect(first.snapshot).toMatchObject({
      state: "settled",
      effect: { outcome: "not_dispatched", persistence: "unverified" },
      result: {
        status: "error",
        error: {
          code: "page_failed",
          cause: { at: "bg.preflight", kind: "runtime", code: "body_read_failed" },
        },
      },
    });
    expect(reads).toBe(2);
    expect(f.pages.nativeSaveCount()).toBe(0);
    const before = [...f.calls];
    expect((await receipt(f.workspace.getOperation(input.operationId))).snapshot).toEqual(
      first.snapshot,
    );
    expect(await receipt(f.workspace.saveArticle(input))).toEqual(first);
    expect(
      (await (await f.operations).unwrap().record(input.operationId)).unwrap().snapshot,
    ).toEqual(first.snapshot);
    expect(reads).toBe(2);
    expect(f.calls).toEqual(before);
    expect(f.calls).not.toContain("mutation");
    expect(f.pages.nativeSaveCount()).toBe(0);
  });
  test("W2 real BODY remote exception is page_call unknown, not a read failure", async () => {
    const f = fixture();
    const created = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.pages.open = async () =>
      Result.ok(
        await remoteEditor({
          ...f.editor,
          setContent: async () => {
            throw new Error("private exception");
          },
        }),
      );
    await expectSnapshot(
      f.workspace.writeBody({
        operationId: await operationId(f.operations),
        article: created.article,
        html: "next",
        expectedHash: created.bodyHash,
      }),
      {
        result: {
          status: "error",
          error: {
            code: "receipt_unreachable",
            cause: { at: "bg.page_call", kind: "nexus", code: "E_REMOTE_EXCEPTION" },
          },
        },
      },
    );
  });
  test.each(["missing", "closed", "unexpected"] as const)(
    "R1 confirmed upload retains receipt after %s saved-provider revalidation failure",
    async (mode) => {
      const f = fixture({ saved: true });
      const remote = await validationRuntime(f.editorBinding);
      const operations = f.operations;
      const workspace = createWorkspace({
        operations,
        pages: {
          ...remote.manager,
          findCurrentEditor: f.pages.findCurrentEditor,
          open: async () => Result.ok(await remoteEditor(f.editor)),
          isCurrent: remote.manager.isCurrent.bind(remote.manager),
          pageStatus: remote.manager.pageStatus.bind(remote.manager),
          validateSavedArticle: remote.manager.validateSavedArticle.bind(remote.manager),
          materialIdentity: f.pages.materialIdentity,
          async uploadMaterial(binding, payload, execution) {
            const uploaded = await f.pages.uploadMaterial(binding, payload, execution);
            if (mode === "missing") remote.useMissingDraft();
            if (mode === "closed") remote.close();
            if (mode === "unexpected")
              this.validateSavedArticle = async () => {
                throw new Error("private unexpected rejection");
              };
            return Result.isError(uploaded) ? uploaded : uploaded;
          },
        },
      });
      try {
        const article = await readValue(workspace.currentArticle(), articleResultCodec);
        await expectSnapshot(
          workspace.uploadAsset({
            operationId: await operationId(operations),
            article: article.article,
            ...uploadInput,
          }),
          {
            effect: { outcome: "confirmed" },
            result: {
              status: "error",
              error: {
                cause: {
                  at: "bg.preflight",
                  kind: mode === "unexpected" ? "runtime" : "nexus",
                  code:
                    mode === "unexpected"
                      ? "unexpected_exception"
                      : mode === "closed"
                        ? "E_CONN_CLOSED"
                        : "E_SERVICE_UNAVAILABLE",
                },
              },
            },
          },
        );
        expect(f.calls.filter((call) => call === "materials-upload")).toHaveLength(1);
      } finally {
        remote.dispose();
      }
    },
  );

  test.each([
    "status-timeout",
    "draft-timeout",
    "missing-status",
    "missing-draft",
    "malformed",
    "chrome",
    "closed",
    "draft-malformed",
    "unexpected",
    "login",
    "target",
  ] as const)("R2 upload preflight preserves %s boundary and never uploads", async (mode) => {
    const f = fixture({ saved: true });
    const remote = await validationRuntime(f.editorBinding);
    const operations = f.operations;
    const workspace = createWorkspace({
      operations,
      pages: {
        ...remote.manager,
        findCurrentEditor: f.pages.findCurrentEditor,
        open: async () => Result.ok(await remoteEditor(f.editor)),
        materialIdentity: f.pages.materialIdentity,
        async uploadMaterial(binding, payload, execution) {
          const uploaded = await f.pages.uploadMaterial(binding, payload, execution);
          return Result.isError(uploaded) ? uploaded : uploaded;
        },
        isCurrent: remote.manager.isCurrent.bind(remote.manager),
        pageStatus: remote.manager.pageStatus.bind(remote.manager),
        validateSavedArticle: remote.manager.validateSavedArticle.bind(remote.manager),
      },
    });
    try {
      const article = await readValue(workspace.currentArticle(), articleResultCodec);
      remote.fail(mode);
      const kind =
        mode === "malformed" || mode === "draft-malformed"
          ? "protocol"
          : mode === "chrome" || mode === "unexpected"
            ? "runtime"
            : ["login", "target"].includes(mode)
              ? "domain"
              : "nexus";
      const causeCode = mode.includes("timeout")
        ? "E_CALL_TIMEOUT"
        : mode.includes("missing")
          ? "E_SERVICE_UNAVAILABLE"
          : mode === "closed"
            ? "E_CONN_CLOSED"
            : mode === "malformed" || mode === "draft-malformed"
              ? "invalid_result_envelope"
              : mode === "chrome" || mode === "unexpected"
                ? "unexpected_exception"
                : mode === "login"
                  ? "not_logged_in"
                  : "target_unavailable";
      await expectSnapshot(
        workspace.uploadAsset({
          operationId: await operationId(operations),
          article: article.article,
          ...uploadInput,
        }),
        {
          effect: { outcome: "not_dispatched" },
          result: {
            status: "error",
            error: {
              cause: { at: "bg.preflight", kind, code: causeCode },
            },
          },
        },
      );
      expect(f.calls).not.toContain("materials-upload");
      const read = await decode(workspace.readBody(article.article), workspaceResultCodec);
      expect(read).toMatchObject({
        status: "error",
        error: {
          code:
            mode === "login"
              ? "not_logged_in"
              : mode === "target"
                ? "target_unavailable"
                : "page_failed",
        },
      });
      expect(JSON.stringify(read)).not.toMatch(/observedFailure|uploadFailure|private/);
    } finally {
      remote.dispose();
    }
  });

  test("R2 internal validation facts are stripped at every existing strict workspace wire boundary", async () => {
    const f = fixture({ saved: true });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.pages.setMaterials([
      { filename: "existing.png", thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/existing/300" },
    ]);
    const assets = await decode(f.workspace.listAssets(article.article), assetListResultCodec);
    if (!assets.isOk() || !assets.value.cards[0]) throw new Error("asset fixture unavailable");
    const asset = assets.value.cards[0].asset;
    f.pages.isCurrent = async () =>
      Result.err({
        code: "page_failed",
        observedFailure: { kind: "nexus", causeCode: "E_CONN_CLOSED" },
      } as never);
    const operations = [
      () => decode(f.workspace.currentArticle(), articleResultCodec),
      () => decode(f.workspace.readBody(article.article), workspaceResultCodec),
      () => decode(f.workspace.inspectArticle(article.article), articleFieldsResultCodec),
      () => decode(f.workspace.checkArticle(article.article), articleCheckResultCodec),
      () => decode(f.workspace.readArticleCover(article.article), articleCoverResultCodec),
      async () =>
        decode(
          f.workspace.setArticleCover({
            operationId: await operationId(f.operations),
            article: article.article,
            asset: asset,
            expectedCoverHash: "a".repeat(64),
          }),
          operationResultCodec,
        ),
      () => decode(f.workspace.listAssets(article.article), assetListResultCodec),
      async () =>
        decode(
          f.workspace.saveArticle({
            operationId: await operationId(f.operations),
            article: article.article,
            expectedBodyHash: "a".repeat(64),
            expectedFieldsHash: "b".repeat(64),
            expectedCoverHash: "c".repeat(64),
          }),
          operationResultCodec,
        ),
    ];
    for (const [index, run] of operations.entries()) {
      const result = await run();
      if (index === 5 || index === 7) {
        const value = result.unwrap();
        if (!("snapshot" in value)) throw new Error("mutation omitted its snapshot");
        expect(value.snapshot).toMatchObject({
          result: {
            status: "error",
            error: {
              code: "page_failed",
              cause: { at: "bg.preflight", kind: "nexus", code: "E_CONN_CLOSED" },
            },
          },
        });
      } else if (index === 6)
        expect(result).toMatchObject({
          status: "error",
          error: {
            code: "page_failed",
            snapshot: {
              state: "settled",
              result: { error: { cause: { kind: "nexus", code: "E_CONN_CLOSED" } } },
            },
          },
        });
      else expect(result).toEqual(Result.err({ code: "page_failed" }));
    }
    await expectSnapshot(
      f.workspace.updateArticleFields({
        operationId: await operationId(f.operations),
        article: article.article,
        fields: { title: "x" },
        expectedHash: "a".repeat(64),
      }),
      {
        result: {
          status: "error",
          error: {
            code: "page_failed",
            cause: { at: "bg.preflight", kind: "nexus", code: "E_CONN_CLOSED" },
          },
        },
      },
    );
    await expectSnapshot(
      f.workspace.writeBody({
        operationId: await operationId(f.operations),
        article: article.article,
        html: "<p>x</p>",
        expectedHash: "a".repeat(64),
      }),
      {
        result: {
          status: "error",
          error: {
            code: "page_failed",
            cause: { at: "bg.preflight", kind: "nexus", code: "E_CONN_CLOSED" },
          },
        },
      },
    );
  });
  test("lists only visible-page cards as opaque article-bound handles", async () => {
    const f = fixture({ saved: true });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.pages.setMaterials([
      { filename: "existing.png", thumbnailUrl: "https://mmbiz.qpic.cn/a/300" },
    ]);
    const listed = await decode(f.workspace.listAssets(article.article), assetListResultCodec);
    const firstHandle = listed.isOk() ? listed.value.cards[0]?.asset : undefined;
    expect(listed.isOk() && listed.value).toMatchObject({
      scope: "visible-page",
      cards: [
        {
          filename: "existing.png",
          thumbnailUrl: "https://mmbiz.qpic.cn/a/300",
          asset: expect.stringMatching(/^ephemeral:/),
        },
      ],
    });
    expect(listed.isOk() && "originalUrl" in listed.value.cards[0]!).toBe(false);
    const again = await decode(f.workspace.listAssets(article.article), assetListResultCodec);
    expect(again.isOk() ? again.value.cards[0]?.asset : undefined).toBe(firstHandle);
    f.pages.setMaterials([]);
    await decode(f.workspace.listAssets(article.article), assetListResultCodec);
    f.pages.setMaterials([
      { filename: "existing.png", thumbnailUrl: "https://mmbiz.qpic.cn/a/300" },
    ]);
    const reappeared = await readValue(
      f.workspace.listAssets(article.article),
      assetListResultCodec,
    );
    expect(reappeared.cards[0]?.asset).not.toBe(firstHandle);
    await expectSnapshot(
      f.workspace.setArticleCover({
        operationId: await operationId(f.operations),
        article: article.article,
        asset: firstHandle!,
        expectedCoverHash: "c".repeat(64),
      }),
      { result: { status: "error", error: { code: "target_unavailable" } } },
    );
    expect(f.calls).not.toContain("cover-set");
  });

  test.each(["thumbnail", "duplicate", "article", "document", "missing-thumbnail"] as const)(
    "material handles preserve %s matching without native cover dispatch",
    async (mode) => {
      const f = fixture({ saved: true });
      const current = await readValue(f.workspace.currentArticle(), articleResultCodec);
      const article = current.article;
      const a = { filename: "same.png", thumbnailUrl: "https://mmbiz.qpic.cn/a/300" };
      const b = { filename: "same.png", thumbnailUrl: "https://mmbiz.qpic.cn/b/300" };
      f.pages.setMaterials(mode === "missing-thumbnail" ? [{ filename: "same.png" }] : [a, b]);
      const first = await readValue(f.workspace.listAssets(article), assetListResultCodec);
      const handles = first.cards.map((card) => card.asset);
      let rejectedArticle = article;
      const rejectedHandle = handles[0]!;
      if (mode === "thumbnail") {
        expect(new Set(handles).size).toBe(2);
        f.pages.setMaterials([b, a]);
        const reversed = await readValue(f.workspace.listAssets(article), assetListResultCodec);
        expect(reversed.cards.map((card) => card.asset)).toEqual([...handles].reverse());
        f.pages.setMaterials([b]);
        await decode(f.workspace.listAssets(article), assetListResultCodec);
      } else if (mode === "duplicate") {
        for (const cards of [
          [{ filename: "new.png" }, { filename: "new.png" }],
          [{ filename: "new.png" }, { filename: "new.png", thumbnailUrl: null }],
        ]) {
          f.pages.setMaterials(cards as never);
          expect(await decode(f.workspace.listAssets(article), assetListResultCodec)).toMatchObject(
            { status: "error", error: { code: "asset_list_failed" } },
          );
          f.pages.setMaterials([a, b]);
          const restored = await readValue(f.workspace.listAssets(article), assetListResultCodec);
          expect(restored.cards.map((card) => card.asset)).toEqual(handles);
        }
        // Neither rejected snapshot pruned the original handles.
        return;
      } else if (mode === "article" || mode === "document") {
        if (mode === "document")
          f.pages.findCurrentEditor = async () =>
            Result.ok({ ...f.editorBinding, documentId: "replacement-document" });
        const next = await readValue(f.workspace.currentArticle(), articleResultCodec);
        rejectedArticle = next.article;
        const second = await readValue(
          f.workspace.listAssets(rejectedArticle),
          assetListResultCodec,
        );
        expect(second.cards.map((card) => card.asset)).not.toEqual(handles);
        if (mode === "article") {
          f.pages.setMaterials([]);
          await decode(f.workspace.listAssets(rejectedArticle), assetListResultCodec);
          f.pages.setMaterials([a, b]);
          const retained = await readValue(f.workspace.listAssets(article), assetListResultCodec);
          expect(retained.cards.map((card) => card.asset)).toEqual(handles);
        }
      } else {
        expect(first.cards[0]).toMatchObject({ filename: "same.png" });
        expect(first.cards[0]?.thumbnailUrl).toBeUndefined();
        expect("originalUrl" in first.cards[0]!).toBe(false);
        const repeat = await readValue(f.workspace.listAssets(article), assetListResultCodec);
        expect(repeat.cards[0]?.asset).toBe(rejectedHandle);
      }
      await expectSnapshot(
        f.workspace.setArticleCover({
          operationId: await operationId(f.operations),
          article: rejectedArticle,
          asset: rejectedHandle,
          expectedCoverHash: "c".repeat(64),
        }),
        { result: { status: "error", error: { code: "target_unavailable" } } },
      );
      expect(f.calls).not.toContain("cover-set");
    },
  );

  test("uploads through the bound material capability without changing the article body", async () => {
    const f = fixture({ saved: true, html: "<p>unchanged</p>" });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    const before = await readValue(f.workspace.readBody(article.article), workspaceResultCodec);
    const uploaded = await receipt(
      f.workspace.uploadAsset({
        operationId: await operationId(f.operations),
        article: article.article,
        blob: new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])], {
          type: "image/png",
        }),
        filename: "new.png",
        mimeType: "image/png",
      }),
    );
    const after = await readValue(f.workspace.readBody(article.article), workspaceResultCodec);
    expect(uploaded.snapshot).toMatchObject({
      operation: "upload",
      state: "settled",
      effect: { outcome: "confirmed", filename: "new.png" },
      result: { status: "ok" },
    });
    expect(after.html).toBe(before.html);
    expect(f.calls).toContain("materials-upload");
  });

  test("save rejects a new draft as unsupported without calling native save", async () => {
    const f = fixture();
    await expectSnapshot(
      f.workspace.newArticle({ operationId: await operationId(f.operations) }),
      confirmedNavigation,
    );

    const opened = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.calls.length = 0;
    const result = await receipt(
      f.workspace.saveArticle({
        operationId: await operationId(f.operations),
        article: opened.article,
        expectedBodyHash: "a".repeat(64),
        expectedFieldsHash: "b".repeat(64),
        expectedCoverHash: "c".repeat(64),
      }),
    );
    expect(result.snapshot).toMatchObject({
      effect: { outcome: "not_dispatched", persistence: "unverified" },
      result: {
        status: "error",
        error: {
          code: "unsupported",
        },
      },
    });
    expect(f.calls).toEqual([]);
  });

  test("legacy confirmed SAVE with pending BG navigation remains unchanged and blocks cover/open", async () => {
    const html = "<p>original</p>";
    const f = fixture({ saved: true, html });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    const fields = await readValue(
      f.workspace.inspectArticle(article.article),
      articleFieldsResultCodec,
    );
    const cover = await readValue(
      f.workspace.readArticleCover(article.article),
      articleCoverResultCodec,
    );
    const operations = (await f.operations).unwrap();
    const input = {
      operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
      article: article.article,
      expectedBodyHash: await hash(html),
      expectedFieldsHash: fields.fieldsHash,
      expectedCoverHash: cover.coverHash,
    };
    const legacy = (
      await operations.run(input, (execution) =>
        execution.issue(
          {
            tabId: f.editorBinding.tabId,
            documentId: f.editorBinding.documentId,
            route: appmsgRouteIdentity(f.editorBinding.url)!,
            groupId: "g1",
            executorId: fixtureExecutorId,
          },
          async () => {
            const observation = {
              effect: { outcome: "confirmed" as const, persistence: "unverified" as const },
              ended: false,
              result: {
                status: "error" as const,
                error: {
                  code: "page_failed" as const,
                  cause: {
                    at: "bg.reload" as const,
                    kind: "domain" as const,
                    code: "navigation_failed",
                  },
                },
              },
            };
            return observation;
          },
        ),
      )
    ).unwrap();
    const row = (await operations.record(input.operationId)).unwrap();
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open(f.databaseName, 1);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("operations", "readwrite");
      tx.objectStore("operations").put({ ...row, bgEffects: "pending" });
      tx.oncomplete = () => resolve();
    });
    db.close();
    f.pages.getExecutionReceipt = async () =>
      Result.ok({
        operationId: input.operationId,
        executorId: fixtureExecutorId,
        requestDigest: row.localRequestDigest,
        effect: { outcome: "confirmed", persistence: "unverified" },
        ended: true,
        result: { status: "ok", value: {} },
      });
    const before = [...f.calls];
    expect((await receipt(f.service.getOperation(input.operationId))).snapshot).toEqual(
      legacy.snapshot,
    );
    expect((await receipt(f.service.saveArticle(input))).snapshot).toEqual(legacy.snapshot);
    expect((await operations.record(input.operationId)).unwrap().bgEffects).toBe("pending");
    expect(f.pages.nativeSaveCount()).toBe(0);
    const bodyCover = await receipt(
      f.service.setArticleCover({
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
        article: article.article,
        bodyImage: 1,
        expectedBodyHash: await hash(html),
        expectedCoverHash: cover.coverHash,
      }),
    );
    expect(bodyCover.snapshot).toMatchObject({
      operation: "cover",
      state: "settled",
      effect: { cover: true, outcome: "not_dispatched" },
      result: { status: "error", error: { code: "operation_blocked" } },
    });
    expect(f.calls).toEqual(before);
    f.pages.findCurrentEditor = async () => Result.ok(f.editorBinding);
    const opened = await receipt(
      f.service.openArticle({
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
        candidate: "g1",
      }),
    );
    expect(opened.snapshot).toMatchObject({
      operation: "open",
      state: "settled",
      result: { status: "error", error: { code: "operation_blocked" } },
    });
    expect(f.calls).toEqual(before);
  });

  test("stale pre-save CAS never dispatches native save or canonical read", async () => {
    const f = fixture({
      saved: true,
      html: "<p>current</p>",
    });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    const fields = await readValue(
      f.workspace.inspectArticle(article.article),
      articleFieldsResultCodec,
    );
    const cover = await readValue(
      f.workspace.readArticleCover(article.article),
      articleCoverResultCodec,
    );

    await expectSnapshot(
      f.workspace.saveArticle({
        operationId: await operationId(f.operations),
        article: article.article,
        expectedBodyHash: "0".repeat(64),
        expectedFieldsHash: fields.fieldsHash,
        expectedCoverHash: cover.coverHash,
      }),
      {
        effect: { outcome: "not_dispatched", persistence: "unverified" },
        result: {
          status: "error",
          error: {
            code: "content_conflict",
          },
        },
      },
    );
    expect(f.pages.nativeSaveCount()).toBe(0);
    expect(f.calls).not.toContain("get-original");
  });

  test("unconfirmed native save never reads a canonical body or attempts fresh navigation", async () => {
    const initial = "<p>original</p>";
    const f = fixture({
      saved: true,
      html: initial,
      nativeSaveFailure: true,
    });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    const fields = await readValue(
      f.workspace.inspectArticle(article.article),
      articleFieldsResultCodec,
    );
    const cover = await readValue(
      f.workspace.readArticleCover(article.article),
      articleCoverResultCodec,
    );

    await expectSnapshot(
      f.workspace.saveArticle({
        operationId: await operationId(f.operations),
        article: article.article,
        expectedBodyHash: await hash(initial),
        expectedFieldsHash: fields.fieldsHash,
        expectedCoverHash: cover.coverHash,
      }),
      {
        effect: { outcome: "unknown", persistence: "unverified" },
        result: { status: "error", error: { code: "save_unknown" } },
      },
    );
    expect(f.calls).not.toContain("get-original");
    expect(f.calls.filter((call) => call.startsWith("edit:"))).toEqual([]);
  });

  test("serializes a material-library list behind an in-flight upload on the same document", async () => {
    const f = fixture({ saved: true });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    f.pages.setUploadGate(uploadGate);
    const upload = receipt(
      f.workspace.uploadAsset({
        operationId: await operationId(f.operations),
        article: article.article,
        blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
          type: "image/png",
        }),
        filename: "queued.png",
        mimeType: "image/png",
      }),
    );
    await f.pages.uploadStarted();
    const list = decode(f.workspace.listAssets(article.article), assetListResultCodec);
    await Promise.resolve();
    expect(f.calls.filter((call) => call.startsWith("materials-"))).toEqual(["materials-upload"]);
    releaseUpload();
    const [uploaded, listed] = await Promise.all([upload, list]);
    expect(uploaded.snapshot).toMatchObject({
      state: "settled",
      effect: { outcome: "confirmed" },
      result: { status: "ok" },
    });
    expect(listed.isOk() && listed.value.cards.map(({ filename }) => filename)).toEqual([
      "queued.png",
    ]);
  });

  test("retains unknown-upload and cleanup facts without retrying the page handler", async () => {
    const f = fixture({ saved: true });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.pages.failUpload({
      code: "asset_upload_unknown",
      cause: { at: "content.library_cleanup", kind: "domain", code: "cancel_timeout" },
    });
    const result = await receipt(
      f.workspace.uploadAsset({
        operationId: await operationId(f.operations),
        article: article.article,
        blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
          type: "image/png",
        }),
        filename: "uncertain.png",
        mimeType: "image/png",
      }),
    );
    expect(result.snapshot).toMatchObject({
      effect: { outcome: "confirmed" },
      result: {
        status: "error",
        error: {
          code: "asset_upload_unknown",

          cause: { at: "content.library_cleanup", kind: "domain", code: "cancel_timeout" },
        },
      },
    });
    expect(f.calls.filter((call) => call === "materials-upload")).toHaveLength(1);
  });

  test("an upload confirmed by the page but losing its article binding is not reported as an unconfirmed upload", async () => {
    const f = fixture({ saved: true });
    const article = await readValue(f.workspace.currentArticle(), articleResultCodec);
    let release!: () => void;
    f.pages.setUploadGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const pending = receipt(
      f.workspace.uploadAsset({
        operationId: await operationId(f.operations),
        article: article.article,
        blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
          type: "image/png",
        }),
        filename: "confirmed.png",
        mimeType: "image/png",
      }),
    );
    await f.pages.uploadStarted();
    f.pages.loseCurrent();
    release();
    expect((await pending).snapshot).toMatchObject({
      effect: { outcome: "confirmed" },
      result: {
        status: "error",
        error: {
          cause: { at: "bg.preflight", kind: "domain", code: "target_unavailable" },
        },
      },
    });
  });
});

const uploadInput = {
  blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }),
  filename: "confirmed.png",
  mimeType: "image/png" as const,
};

async function validationRuntime(binding: { tabId: number; documentId: string; url: string }) {
  let mode = "ready";
  const endpoints: ReturnType<typeof createPageEndpoint>[] = [];
  const connections: import("@nexus-js/core").Connection[] = [];
  async function connect(omit?: "draft" | "status") {
    const target = new EventTarget();
    const channelId = crypto.randomUUID();
    const eventNames = { fromIsolated: `${channelId}:isolated`, fromMain: `${channelId}:main` };
    const providerEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
    const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
    endpoints.push(providerEndpoint, clientEndpoint);
    const provider = new Nexus();
    if (omit !== "status")
      provider.provide(contentStatusToken, {
        async status() {
          if (mode === "status-timeout") await new Promise(() => {});
          if (mode === "malformed") return { status: "ok", value: { state: "invalid" } } as never;
          return encoded(
            contentStatusResultCodec,
            Result.ok({
              state: mode === "login" ? "not_logged_in" : "ready",
              route: appmsgRouteIdentity(binding.url)!,
              documentReady: true,
            }),
          );
        },
      });
    if (omit !== "draft")
      provider.provide(draftPageToken, {
        async validateDraft() {
          if (mode === "draft-timeout") await new Promise(() => {});
          if (mode === "draft-malformed") return { status: "ok", value: { valid: "bad" } } as never;
          return encoded(
            validateDraftResultCodec,
            Result.ok({ valid: mode !== "target", title: "Draft" }),
          );
        },
        async currentItemCount() {
          return encoded(currentItemCountResultCodec, Result.ok(1));
        },
        async listDrafts() {
          return { status: "ok" as const, value: [] };
        },
      });
    provider.configure({
      endpoint: { implementation: providerEndpoint, meta: { app: { protocolVersion } } },
    });
    const client = new Nexus().configure({
      endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
    });
    await Promise.all([provider.ready(), client.ready()]);
    const acquired = await client.safeConnect({ target: {} });
    if (Result.isError(acquired)) throw acquired.error;
    connections.push(acquired.value);
    return acquired.value;
  }
  const ready = await connect();
  const missingDraft = await connect("draft");
  const missingStatus = await connect("status");
  let connection = ready;
  const manager = createPageManager(
    {
      async getTab(id: number) {
        if (mode === "chrome") throw new Error("private chrome failure");
        return { id, url: binding.url };
      },
    } as never,
    undefined,
    undefined,
    undefined,
    async () => {
      if (mode === "unexpected") throw new Error("private connect exception");
      return new Proxy(connection, {
        get(target, property) {
          if (property === "safeGet")
            return (token: Parameters<typeof target.safeGet>[0]) =>
              target.safeGet(token, { callTimeout: 20 });
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  );
  manager.observe(binding);
  return {
    manager,
    fail(value: string) {
      mode = value;
      if (value === "closed") connection.disconnect();
      if (value === "missing-draft") connection = missingDraft;
      if (value === "missing-status") connection = missingStatus;
    },
    useMissingDraft() {
      connection = missingDraft;
    },
    close() {
      connection.disconnect();
    },
    dispose() {
      for (const connection of connections) connection.disconnect();
      for (const endpoint of endpoints) endpoint.close();
    },
  };
}

async function encoded<T, E, W>(
  codec: {
    serialize(
      value: import("better-result").Result<T, E>,
    ): Promise<import("better-result").Result<W, unknown>>;
  },
  result: import("better-result").Result<T, E>,
): Promise<W> {
  const wire = await codec.serialize(result);
  if (Result.isError(wire)) throw wire.error;
  return wire.value;
}

async function decode<T, E>(
  wire: Promise<unknown>,
  codec: {
    deserialize(
      value: unknown,
    ): Promise<import("better-result").Result<T, E | { code: "invalid_result_envelope" }>>;
  },
) {
  return codec.deserialize(await wire);
}
async function readValue<T, E>(
  wire: Promise<unknown>,
  codec: { deserialize(value: unknown): Promise<import("better-result").Result<T, E>> },
) {
  return (await codec.deserialize(await wire)).unwrap();
}

describe("workspace hash and article lifecycle", () => {
  test("inspects only actual fields with an ordered raw-string fieldsHash", async () => {
    const f = fixture();
    await expectSnapshot(
      f.workspace.newArticle({ operationId: await operationId(f.operations) }),
      confirmedNavigation,
    );

    const opened = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.calls.length = 0;
    const inspected = await decode(
      f.workspace.inspectArticle(opened.article),
      articleFieldsResultCodec,
    );
    expect(inspected).toEqual(
      Result.ok({
        title: " Title ",
        author: "作者",
        summary: "",
        fieldsHash: [
          ...new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(JSON.stringify([" Title ", "作者", ""])),
            ),
          ),
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      }),
    );
    expect(f.calls.filter((call) => call === "fields")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "get" || call === "mutation")).toHaveLength(0);
  });
  test("checks a guarded read-only fields/body snapshot and reports finite warnings", async () => {
    const f = fixture();
    await expectSnapshot(
      f.workspace.newArticle({ operationId: await operationId(f.operations) }),
      confirmedNavigation,
    );

    const opened = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.calls.length = 0;
    const checked = await decode(f.workspace.checkArticle(opened.article), articleCheckResultCodec);
    expect(checked).toEqual(
      Result.ok({
        errors: [],
        warnings: [
          "body_semantics_unchecked",
          "summary_platform_default_unchecked",
          "cover_unchecked",
          "platform_settings_unchecked",
        ],
      }),
    );
    expect(f.calls.filter((call) => call === "fields")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "get")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "mutation")).toHaveLength(0);
  });
  test("revalidates target after field read before reading the body", async () => {
    const f = fixture();
    await expectSnapshot(
      f.workspace.newArticle({ operationId: await operationId(f.operations) }),
      confirmedNavigation,
    );

    const opened = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.calls.length = 0;
    f.pages.invalidateAfterFieldRead();
    expect(await decode(f.workspace.checkArticle(opened.article), articleCheckResultCodec)).toEqual(
      Result.err({ code: "target_unavailable" }),
    );
    expect(f.calls).toEqual(["fields"]);
    expect(f.calls).not.toContain("get");
  });
  test("requests a fresh public list and keeps candidate opening on the normal cache path", async () => {
    const f = fixture({ saved: true });
    expect((await decode(f.workspace.listArticles(), listArticlesResultCodec)).isOk()).toBe(true);
    expect(f.listOptions).toEqual([{ refresh: true }]);
    await expectSnapshot(
      f.workspace.openArticle({ operationId: await operationId(f.operations), candidate: "g1" }),
      confirmedNavigation,
    );
    expect(f.listOptions).toEqual([{ refresh: true }, {}]);
  });
  test("preserves body read failure and revalidates target after body read", async () => {
    const failed = fixture();
    await expectSnapshot(
      failed.workspace.newArticle({ operationId: await operationId(failed.operations) }),
      confirmedNavigation,
    );

    const opened = await readValue(failed.workspace.currentArticle(), articleResultCodec);
    failed.pages.failBodyRead();
    expect(
      await decode(failed.workspace.checkArticle(opened.article), articleCheckResultCodec),
    ).toEqual(Result.err({ code: "page_failed" }));

    const changed = fixture();
    await expectSnapshot(
      changed.workspace.newArticle({ operationId: await operationId(changed.operations) }),
      confirmedNavigation,
    );

    const changedArticle = await readValue(changed.workspace.currentArticle(), articleResultCodec);
    changed.pages.invalidateAfterBodyRead();
    expect(
      await decode(changed.workspace.checkArticle(changedArticle.article), articleCheckResultCodec),
    ).toEqual(Result.err({ code: "target_unavailable" }));
  });
  test("rejects a stale fieldsHash without dispatching field writes", async () => {
    const f = fixture();
    await expectSnapshot(
      f.workspace.newArticle({ operationId: await operationId(f.operations) }),
      confirmedNavigation,
    );

    const opened = await readValue(f.workspace.currentArticle(), articleResultCodec);
    const result = await receipt(
      f.workspace.updateArticleFields({
        operationId: await operationId(f.operations),
        article: opened.article,
        fields: { author: "new" },
        expectedHash: "0".repeat(64),
      }),
    );
    expect(result.snapshot).toMatchObject({
      result: { status: "error", error: { code: "content_conflict" } },
    });
    expect(f.calls.filter((call) => call === "field-write")).toHaveLength(0);
  });
  test("keeps executor confirmation when the target is invalidated after receipt", async () => {
    const f = fixture();
    await expectSnapshot(
      f.workspace.newArticle({ operationId: await operationId(f.operations) }),
      confirmedNavigation,
    );

    const opened = await readValue(f.workspace.currentArticle(), articleResultCodec);
    const inspected = await readValue(
      f.workspace.inspectArticle(opened.article),
      articleFieldsResultCodec,
    );
    f.calls.length = 0;
    const result = await receipt(
      f.workspace.updateArticleFields({
        operationId: await operationId(f.operations),
        article: opened.article,
        fields: { author: inspected.author, summary: "changed" },
        expectedHash: inspected.fieldsHash,
      }),
    );
    expect(result.snapshot).toMatchObject({
      operation: "fields",
      state: "settled",
      effect: { outcome: "confirmed", fieldsHash: "a".repeat(64) },
      result: { status: "ok" },
    });
    expect(f.calls.filter((call) => call === "field-write")).toHaveLength(1);
  });
  test("returns actual editor hashes on list-open, new, and pull paths", async () => {
    const saved = fixture({ saved: true, html: "<p>saved</p>" });
    const listed = await decode(saved.workspace.listArticles(), listArticlesResultCodec);
    expect(listed).toEqual(Result.ok([{ candidate: "g1", title: "Draft" }]));
    if (!listed.isOk()) return;
    await expectSnapshot(
      saved.workspace.openArticle({
        operationId: await operationId(saved.operations),
        candidate: listed.value[0]!.candidate,
      }),
      confirmedNavigation,
    );

    const opened = await decode(saved.workspace.currentArticle(), articleResultCodec);
    expect(opened).toEqual(
      Result.ok({ article: expect.any(String), title: "", bodyHash: await hash("<p>saved</p>") }),
    );
    if (!opened.isOk()) return;
    expect(
      await decode(saved.workspace.readBody(opened.value.article), workspaceResultCodec),
    ).toEqual(Result.ok({ html: "<p>saved</p>", bodyHash: await hash("<p>saved</p>") }));

    const blank = fixture({ html: "" });
    await expectSnapshot(
      blank.workspace.newArticle({ operationId: await operationId(blank.operations) }),
      confirmedNavigation,
    );

    const created = await decode(blank.workspace.currentArticle(), articleResultCodec);
    expect(created).toMatchObject({ status: "ok", value: { title: "", bodyHash: await hash("") } });
  });

  test("hash failure before navigation claim creates no page; pure current/read retain page_failed", async () => {
    const originalDigest = crypto.subtle.digest;
    crypto.subtle.digest = (() =>
      Promise.reject(new Error("offline crypto"))) as typeof originalDigest;
    try {
      const saved = fixture({ saved: true });
      const opened = await decode(
        saved.workspace.openArticle({
          operationId: await operationId(saved.operations),
          candidate: "g1",
        }),
        operationResultCodec,
      );
      expect(opened).toMatchObject({
        status: "error",
        error: { failure: { code: "hash_failed" } },
      });

      const fresh = fixture();
      const created = await decode(
        fresh.workspace.newArticle({ operationId: await operationId(fresh.operations) }),
        operationResultCodec,
      );
      expect(created).toMatchObject({
        status: "error",
        error: { failure: { code: "hash_failed" } },
      });

      const current = await decode(fixture().workspace.currentArticle(), articleResultCodec);
      expect(current).toEqual(Result.err({ code: "page_failed" }));
    } finally {
      crypto.subtle.digest = originalDigest;
    }

    const readable = fixture();
    await expectSnapshot(
      readable.workspace.newArticle({ operationId: await operationId(readable.operations) }),
      confirmedNavigation,
    );

    const article = await readValue(readable.workspace.currentArticle(), articleResultCodec);
    crypto.subtle.digest = (() =>
      Promise.reject(new Error("offline crypto"))) as typeof originalDigest;
    try {
      expect(
        await decode(readable.workspace.readBody(article.article), workspaceResultCodec),
      ).toEqual(Result.err({ code: "page_failed" }));
    } finally {
      crypto.subtle.digest = originalDigest;
    }
  });

  test("preserves write certainty when hashing fails before versus after dispatch", async () => {
    const before = fixture({ html: "baseline" });
    await expectSnapshot(
      before.workspace.newArticle({ operationId: await operationId(before.operations) }),
      confirmedNavigation,
    );

    const beforeArticle = await readValue(before.workspace.currentArticle(), articleResultCodec);

    const originalDigest = crypto.subtle.digest;
    crypto.subtle.digest = (() =>
      Promise.reject(new Error("offline crypto"))) as typeof originalDigest;
    try {
      expect(
        await decode(
          before.workspace.writeBody({
            operationId: await operationId(before.operations),
            article: beforeArticle.article,
            html: "replacement",
            expectedHash: beforeArticle.bodyHash,
          }),
          operationResultCodec,
        ),
      ).toMatchObject({ status: "error", error: { failure: { code: "hash_failed" } } });
      expect(before.calls).not.toContain("mutation");
    } finally {
      crypto.subtle.digest = originalDigest;
    }

    const after = fixture({ html: "baseline" });
    await expectSnapshot(
      after.workspace.newArticle({ operationId: await operationId(after.operations) }),
      confirmedNavigation,
    );

    const afterArticle = await readValue(after.workspace.currentArticle(), articleResultCodec);
    crypto.subtle.digest = ((...args: Parameters<typeof originalDigest>) => {
      return after.calls.filter((call) => call === "mutation").length === 1
        ? Promise.reject(new Error("offline crypto"))
        : originalDigest.apply(crypto.subtle, args);
    }) as typeof originalDigest;
    try {
      await expectSnapshot(
        after.workspace.writeBody({
          operationId: await operationId(after.operations),
          article: afterArticle.article,
          html: "replacement",
          expectedHash: afterArticle.bodyHash,
        }),
        {
          result: {
            status: "error",
            error: {
              code: "hash_failed",
              cause: { at: "main.readback", kind: "runtime", code: "hash_failed" },
            },
          },
        },
      );
      expect(after.calls.filter((call) => call === "mutation")).toHaveLength(1);
    } finally {
      crypto.subtle.digest = originalDigest;
    }
  });

  test("a repeated or failed list does not invalidate an already listed group", async () => {
    const { workspace, operations } = fixture();
    const first = await readValue(workspace.listArticles(), listArticlesResultCodec);
    const again = await decode(workspace.listArticles(), listArticlesResultCodec);
    expect(again.isOk()).toBe(true);
    await expectSnapshot(
      workspace.openArticle({
        operationId: await operationId(operations),
        candidate: first[0]!.candidate,
      }),
      confirmedNavigation,
    );
  });

  test("revalidates the current group and document before opening saved content", async () => {
    const { workspace, calls, operations } = fixture({
      saved: true,
      groups: [{ groupId: "g1", title: "Draft" }],
    });
    const listed = await readValue(workspace.listArticles(), listArticlesResultCodec);
    const opened = await receipt(
      workspace.openArticle({
        operationId: await operationId(operations),
        candidate: "missing-group",
      }),
    );
    expect(opened.snapshot).toMatchObject({
      result: { status: "error", error: { code: "target_unavailable" } },
    });
    expect(calls).not.toContain("edit:missing-group");
    await expectSnapshot(
      workspace.openArticle({
        operationId: await operationId(operations),
        candidate: listed[0]!.candidate,
      }),
      confirmedNavigation,
    );
  });

  test("caller-owned hash rejects stale writes, while a refreshed hash permits normalized writes", async () => {
    const { workspace, calls, setBody, operations } = fixture({ html: "<p>H0</p>" });
    await expectSnapshot(
      workspace.newArticle({ operationId: await operationId(operations) }),
      confirmedNavigation,
    );

    const created = await readValue(workspace.currentArticle(), articleResultCodec);
    const stale = created.bodyHash;
    const externalBody = "<p>external H1</p>";
    setBody(externalBody);
    const pulled = await readValue(workspace.readBody(created.article), workspaceResultCodec);
    expect(pulled.bodyHash).toBe(await hash(externalBody));

    const input = {
      operationId: await operationId(operations),
      article: created.article,
      html: "stale A",
      expectedHash: stale,
    };
    const conflict = await receipt(workspace.writeBody(input));
    expect(conflict.snapshot).toMatchObject({
      state: "settled",
      effect: { outcome: "not_dispatched" },
      result: {
        status: "error",
        error: {
          code: "content_conflict",
          cause: { at: "main.preflight", kind: "domain", code: "content_conflict" },
        },
      },
    });
    expect(calls.filter((call) => call === "mutation")).toHaveLength(0);
    const beforeReplay = [...calls];
    expect(await receipt(workspace.getOperation(input.operationId))).toEqual(conflict);
    expect(await receipt(workspace.writeBody(input))).toEqual(conflict);
    expect(calls).toEqual(beforeReplay);

    const refreshed = await readValue(workspace.readBody(created.article), workspaceResultCodec);
    expect(refreshed.bodyHash).toBe(await hash(externalBody));
    const winner = await receipt(
      workspace.writeBody({
        operationId: await operationId(operations),
        article: created.article,
        html: "<p> winner </p>",
        expectedHash: refreshed.bodyHash,
      }),
    );
    expect(winner.snapshot).toMatchObject({
      operation: "body",
      state: "settled",
      effect: { outcome: "confirmed", bodyHash: await hash("<p> winner </p>") },
      result: { status: "ok" },
    });
    const winnerSnapshot = winner.snapshot;
    if (winnerSnapshot.operation !== "body" || winnerSnapshot.effect.outcome !== "confirmed")
      throw new Error("body was not confirmed");
    expect(
      await decode(
        workspace.writeBody({
          operationId: await operationId(operations),
          article: created.article,
          html: "<p>next</p>",
          expectedHash: winnerSnapshot.effect.bodyHash,
        }),
        operationResultCodec,
      ),
    ).toMatchObject({
      status: "ok",
      value: { snapshot: { state: "settled", result: { status: "ok" } } },
    });
  });

  test("preserves conflict and unknown-write outcomes from the editor bridge", async () => {
    for (const code of ["content_conflict", "write_unknown"] as const) {
      const { workspace, operations } = fixture({ setResult: { ok: false, code } });
      await expectSnapshot(
        workspace.newArticle({ operationId: await operationId(operations) }),
        confirmedNavigation,
      );

      const created = await readValue(workspace.currentArticle(), articleResultCodec);
      await expectSnapshot(
        workspace.writeBody({
          operationId: await operationId(operations),
          article: created.article,
          html: "replacement",
          expectedHash: created.bodyHash,
        }),
        { result: { status: "error", error: { code } } },
      );
    }
  });

  test("retains login and current-document guards before body access", async () => {
    const { workspace, pages, calls, operations } = fixture();
    await expectSnapshot(
      workspace.newArticle({ operationId: await operationId(operations) }),
      confirmedNavigation,
    );

    const created = await readValue(workspace.currentArticle(), articleResultCodec);
    pages.loseCurrent();
    expect(await decode(workspace.readBody(created.article), workspaceResultCodec)).toEqual(
      Result.err({ code: "target_unavailable" }),
    );
    await expectSnapshot(
      workspace.writeBody({
        operationId: await operationId(operations),
        article: created.article,
        html: "replacement",
        expectedHash: created.bodyHash,
      }),
      {
        result: {
          status: "error",
          error: {
            code: "target_unavailable",
            cause: { at: "bg.preflight", kind: "domain", code: "target_unavailable" },
          },
        },
      },
    );
    expect(calls.filter((call) => call === "get" || call === "mutation")).toEqual(["get", "get"]);
  });

  test("independent refs share MAIN serialization and cannot overwrite another caller's new version", async () => {
    const f = fixture();
    await expectSnapshot(
      f.workspace.newArticle({ operationId: await operationId(f.operations) }),
      confirmedNavigation,
    );

    const a = await readValue(f.workspace.currentArticle(), articleResultCodec);
    await expectSnapshot(
      f.workspace.newArticle({ operationId: await operationId(f.operations) }),
      confirmedNavigation,
    );

    const b = await readValue(f.workspace.currentArticle(), articleResultCodec);
    expect(a.article).not.toBe(b.article);
    const results = await Promise.all([
      decode(
        f.workspace.writeBody({
          operationId: await operationId(f.operations),
          article: a.article,
          html: "first",
          expectedHash: a.bodyHash,
        }),
        operationResultCodec,
      ),
      decode(
        f.workspace.writeBody({
          operationId: await operationId(f.operations),
          article: b.article,
          html: "second",
          expectedHash: b.bodyHash,
        }),
        operationResultCodec,
      ),
    ]);
    const snapshots = results.map((result) => result.unwrap().snapshot);
    expect(
      snapshots.filter((snapshot) => "result" in snapshot && snapshot.result.status === "ok"),
    ).toHaveLength(1);
    expect(
      snapshots.filter((snapshot) => "result" in snapshot && snapshot.result.status === "error"),
    ).toMatchObject([
      {
        effect: { outcome: "not_dispatched" },
        result: { status: "error", error: { code: "operation_blocked" } },
      },
    ]);
    expect(f.calls.filter((call) => call === "mutation")).toHaveLength(1);
  });

  test("pre-dispatch page lookup failure is not reported as an uncertain mutation", async () => {
    const f = fixture();
    await expectSnapshot(
      f.workspace.newArticle({ operationId: await operationId(f.operations) }),
      confirmedNavigation,
    );

    const created = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.pages.pageStatus = async () => Result.err({ code: "page_failed" as const }) as never;
    await expectSnapshot(
      f.workspace.writeBody({
        operationId: await operationId(f.operations),
        article: created.article,
        html: "replacement",
        expectedHash: created.bodyHash,
      }),
      {
        result: {
          status: "error",
          error: {
            code: "page_failed",
            cause: { at: "bg.preflight", kind: "domain", code: "page_failed" },
          },
        },
      },
    );
    expect(f.calls).not.toContain("mutation");
  });

  test("complete login timeout blocks new and saved refs before body access", async () => {
    for (const saved of [false, true]) {
      const f = fixture({ saved });
      const navigation = saved
        ? await decode(
            f.workspace.openArticle({
              operationId: await operationId(f.operations),
              candidate: "g1",
            }),
            operationResultCodec,
          )
        : await decode(
            f.workspace.newArticle({ operationId: await operationId(f.operations) }),
            operationResultCodec,
          );
      expect(navigation.unwrap().snapshot).toMatchObject({
        state: "settled",
        result: { status: "ok" },
      });
      const opened = await readValue(f.workspace.currentArticle(), articleResultCodec);
      f.pages.setStatus("not_logged_in");
      expect(await decode(f.workspace.readBody(opened.article), workspaceResultCodec)).toEqual(
        Result.err({ code: "not_logged_in" }),
      );
      await expectSnapshot(
        f.workspace.writeBody({
          operationId: await operationId(f.operations),
          article: opened.article,
          html: "replacement",
          expectedHash: opened.bodyHash,
        }),
        {
          result: {
            status: "error",
            error: {
              code: "not_logged_in",
              cause: { at: "bg.preflight", kind: "domain", code: "not_logged_in" },
            },
          },
        },
      );
      expect(f.calls).not.toContain("mutation");
    }
  });

  test("new and saved target login failures retain pageCreated without navigation-stage substitution", async () => {
    const fresh = fixture();
    fresh.pages.setLoginAfterDraftOpen();
    await expectSnapshot(
      fresh.workspace.newArticle({ operationId: await operationId(fresh.operations) }),
      {
        effect: { pageCreated: true },
        result: { status: "error", error: { code: "not_logged_in" } },
      },
    );

    const saved = fixture({ saved: true });
    saved.pages.setLoginAfterDraftOpen();
    await expectSnapshot(
      saved.workspace.openArticle({
        operationId: await operationId(saved.operations),
        candidate: "g1",
      }),
      {
        effect: { pageCreated: true },
        result: { status: "error", error: { code: "not_logged_in" } },
      },
    );
  });

  test("T0 L0 late BODY login crosses the workspace codec with pageCreated and zero native calls", async () => {
    const f = fixture();
    const binding = (await f.pages.ensureEditorTab()).unwrap();
    const target = new EventTarget();
    const channelId = crypto.randomUUID();
    const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
    const providerEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
    const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
    let state: "ready" | "not_logged_in" = "ready";
    let statusCalls = 0;
    let nativeCalls = 0;
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
          return encoded(
            contentStatusResultCodec,
            Result.ok({ state, route: appmsgRouteIdentity(binding.url)!, documentReady: true }),
          );
        },
      })
      .provide(pageEditorToken, {
        async ready() {
          nativeCalls++;
          return encoded(
            pageEditorReadyResultCodec,
            Result.ok({ isReady: true, isNew: true, executorId: fixtureExecutorId }),
          );
        },
        async getContent() {
          nativeCalls++;
          return encoded(pageEditorContentResultCodec, Result.ok("forbidden"));
        },
        async setContent() {
          nativeCalls++;
          throw new Error("must not write");
        },
        getReceipt: async () => ({ status: "ok" as const, value: null }),
        setCoverFromBody: async () => ({
          status: "error" as const,
          error: { code: "unsupported" as const },
        }),
        getCoverReceipt: async () => ({ status: "ok" as const, value: null }),
      });
    const client = new Nexus().configure({
      endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
    });
    await Promise.all([provider.ready(), client.ready()]);
    const connection = await client.connect({ target: {} });
    let waitStarted!: () => void;
    const waiting = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    const subscribe = connection.subscribeIdentity.bind(connection);
    const identity = spyOn(connection, "subscribeIdentity").mockImplementation((listener) => {
      const stop = subscribe(listener);
      waitStarted();
      return stop;
    });
    let connects = 0;
    const manager = createPageManager(
      {
        async getTab() {
          return { id: binding.tabId, url: binding.url };
        },
      } as never,
      undefined,
      undefined,
      undefined,
      async () => {
        connects++;
        return connection;
      },
    );
    manager.observe(binding);
    const operations = f.operations;
    const workspace = createWorkspace({
      operations,
      pages: {
        ...manager,
        ensureEditorTab: f.pages.ensureEditorTab,
      },
    });
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const timers = spyOn(globalThis, "setTimeout");
    try {
      const creating = receipt(
        workspace.newArticle({ operationId: await operationId(operations) }),
      );
      await waiting;
      expect(statusCalls).toBe(1);
      expect(nativeCalls).toBe(0);
      state = "not_logged_in";
      const terminal = timers.mock.calls
        .filter(([, delay]) => typeof delay === "number" && delay >= 8000 && delay <= 10_000)
        .sort((a, b) => Number(a[1]) - Number(b[1]))[0];
      expect(terminal).toBeDefined();
      clock.mockReturnValue(now + Number(terminal![1]));
      terminal![0]();
      expect((await creating).snapshot).toMatchObject({
        effect: { pageCreated: true },
        result: { status: "error", error: { code: "not_logged_in" } },
      });
      expect(statusCalls).toBe(2);
      expect(connects).toBe(2); // Initial DOM validation and BODY session only; no terminal reconnect.
      expect(nativeCalls).toBe(0);
      expect(f.calls).not.toContain("get");
      expect(f.calls).not.toContain("mutation");
    } finally {
      manager.dispose();
      for (const result of timers.mock.results)
        if (result.type === "return") clearTimeout(result.value);
      timers.mockRestore();
      clock.mockRestore();
      identity.mockRestore();
      connection.disconnect();
      providerEndpoint.close();
      clientEndpoint.close();
    }
  });

  test("new and saved target lookup failures retain pageCreated and original error code", async () => {
    const fresh = fixture();
    fresh.pages.setEditorLookupFailure();
    await expectSnapshot(
      fresh.workspace.newArticle({ operationId: await operationId(fresh.operations) }),
      {
        effect: { pageCreated: true },
        result: { status: "error", error: { code: "page_failed" } },
      },
    );

    const saved = fixture({ saved: true });
    saved.pages.setEditorLookupFailure();
    await expectSnapshot(
      saved.workspace.openArticle({
        operationId: await operationId(saved.operations),
        candidate: "g1",
      }),
      {
        effect: { pageCreated: true },
        result: { status: "error", error: { code: "page_failed" } },
      },
    );
  });

  test("stored article refs and current-editor failures do not retain a historical pageCreated fact", async () => {
    const stored = fixture();
    await expectSnapshot(
      stored.workspace.newArticle({ operationId: await operationId(stored.operations) }),
      confirmedNavigation,
    );

    const created = await readValue(stored.workspace.currentArticle(), articleResultCodec);
    stored.pages.setStatus("not_logged_in");
    expect(await decode(stored.workspace.readBody(created.article), workspaceResultCodec)).toEqual(
      Result.err({ code: "not_logged_in" }),
    );

    const current = fixture();
    current.pages.setStatus("not_logged_in");
    expect(await decode(current.workspace.currentArticle(), articleResultCodec)).toEqual(
      Result.err({ code: "not_logged_in" }),
    );
  });

  test("page change during initial HTML read prevents new and saved ref issuance", async () => {
    for (const saved of [false, true]) {
      const f = fixture({ saved });
      f.pages.open = async () =>
        Result.ok(
          await remoteEditor({
            ...f.editor,
            getContent: async () => {
              f.pages.loseCurrent();
              const encoded = await pageEditorContentResultCodec.serialize(Result.ok("old body"));
              return Result.isOk(encoded)
                ? encoded.value
                : { status: "error", error: encoded.error };
            },
          }),
        );
      const result = saved
        ? await decode(
            f.workspace.openArticle({
              operationId: await operationId(f.operations),
              candidate: "g1",
            }),
            operationResultCodec,
          )
        : await decode(
            f.workspace.newArticle({ operationId: await operationId(f.operations) }),
            operationResultCodec,
          );
      expect(result.unwrap().snapshot).toMatchObject({
        effect: { pageCreated: true },
        result: { status: "error", error: { code: "target_unavailable" } },
      });
    }
  });
  test("a fresh background can reacquire a unique existing editor without creating a new page", async () => {
    const f = fixture();
    await expectSnapshot(f.workspace.newArticle({ operationId: await operationId(f.operations) }), {
      state: "settled",
      result: { status: "ok" },
    });
    const old = await readValue(f.workspace.currentArticle(), articleResultCodec);
    f.setBody("unsaved user content");
    const restarted = createWorkspace({ pages: f.pages as never, operations: f.operations });
    expect(await decode(restarted.readBody(old.article), workspaceResultCodec)).toEqual(
      Result.err({ code: "target_unavailable" }),
    );
    const current = await readValue(restarted.currentArticle(), articleResultCodec);
    expect(current.bodyHash).toBe(await hash("unsaved user content"));
    expect(await decode(restarted.readBody(current.article), workspaceResultCodec)).toEqual(
      Result.ok({ html: "unsaved user content", bodyHash: current.bodyHash }),
    );
    expect(f.calls).not.toContain("mutation");
    expect(f.calls.some((call) => call.startsWith("edit:"))).toBe(false);
  });
});
import { fieldsExecutorId, fieldsReceipt } from "./fields-fixture";
import { fieldsRequestDigest } from "../src/background-contracts";
import { hashArticleFields } from "../src/mp/article-fields";
