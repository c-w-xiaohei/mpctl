import { afterEach, beforeEach, expect, test } from "bun:test";
import { Result } from "better-result";
import {
  articleResultCodec,
  operationResultCodec,
  workspaceResultCodec,
  articleStateResultCodec,
  createOperationId,
} from "@mpctl/contracts";
import { createOperations } from "../src/operations";
import { createWorkspace } from "../src/workspace";
import { createEditorService } from "../src/mp/jsapi";
import { createPageManager } from "../src/pages";
import { hashBody } from "../src/mp/body-hash";
import { saveRequestDigest } from "../src/background-contracts";
import { installIdbFixture } from "./idb-fixture";
import { Nexus } from "@nexus-js/core";
import { protocolVersion } from "@mpctl/contracts";
import { createPageEndpoint } from "../src/transport/page-bridge";
import { pageEditorToken } from "../src/page-contracts";

let restore: () => void;
beforeEach(() => {
  restore = installIdbFixture();
});
afterEach(() => restore());

async function fixture() {
  const records = (await createOperations()).unwrap();
  let html = "<p>before</p>";
  let current = true;
  let saveCalls = 0;
  let writeCalls = 0;
  const binding = {
    tabId: 1,
    documentId: "saved-a",
    url: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=a&token=fixture",
  };
  const editor = createEditorService({
    invoke(request) {
      if (request.apiName === "mp_editor_get_isready")
        request.sucCb({ isReady: true, isNew: true });
      else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: html });
      else {
        writeCalls++;
        if ("content" in request.apiParam) html = request.apiParam.content.trim();
        request.sucCb({});
      }
    },
  });
  const eventTarget = new EventTarget();
  const channelId = crypto.randomUUID();
  const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
  const main = createPageEndpoint({ target: eventTarget, channelId, side: "main", eventNames });
  const isolated = createPageEndpoint({
    target: eventTarget,
    channelId,
    side: "isolated",
    eventNames,
  });
  const provider = new Nexus()
    .configure({ endpoint: { implementation: main, meta: { app: { protocolVersion } } } })
    .provide(pageEditorToken, editor);
  const client = new Nexus().configure({
    endpoint: { implementation: isolated, meta: { app: { protocolVersion } } },
  });
  await Promise.all([provider.ready(), client.ready()]);
  const remote = (await client.connect({ target: {} })).get(pageEditorToken);
  const manager = createPageManager(
    {
      getTab: async () => ({ id: 1, url: binding.url }),
    } as never,
    async () => remote,
  );
  manager.observe(binding);
  const executorId = crypto.randomUUID();
  const pages = {
    isCurrent: async () => Result.ok(current),
    validateSavedArticle: async () => Result.ok({ valid: true, title: "Title" }),
    pageStatus: async () => Result.ok({ state: "ready", route: "saved", documentReady: true }),
    findCurrentEditor: async () => Result.ok(binding),
    open: manager.open.bind(manager),
    readArticleFields: async () =>
      Result.ok({ title: "Title", author: "Author", summary: "Summary" }),
    readArticleCover: async () => Result.ok("c".repeat(64)),
    coverIdentity: async () => Result.ok({ executorId }),
    saveArticle: async (
      _binding: unknown,
      execution: Parameters<typeof saveRequestDigest>[0] & {
        operationId: string;
        executorId: string;
      },
    ) => {
      saveCalls++;
      return Result.ok({
        ...execution,
        requestDigest: await saveRequestDigest(execution),
        effect: { outcome: "confirmed" as const, persistence: "unverified" as const },
        ended: true,
        result: { status: "ok" as const, value: {} },
      });
    },
  };
  const service = createWorkspace({
    pages: pages as never,
    operations: Promise.resolve(Result.ok(records)),
  });
  const article = (await articleResultCodec.deserialize(await service.currentArticle())).unwrap();
  return {
    records,
    service,
    article,
    pages,
    binding,
    id: () => createOperationId(records.ledgerId),
    loseTarget() {
      current = false;
    },
    replaceBody(value: string) {
      html = value;
    },
    writes: () => writeCalls,
    saves: () => saveCalls,
  };
}
async function reply(wire: ReturnType<ReturnType<typeof createWorkspace>["writeBody"]>) {
  return (await operationResultCodec.deserialize(await wire)).unwrap();
}

test("BODY uses actual versions, normalizes readback and never saves implicitly", async () => {
  const f = await fixture();
  const input = {
    operationId: f.id(),
    article: f.article.article,
    html: "  <p>after</p>  ",
    expectedHash: f.article.bodyHash,
  };
  const written = await reply(f.service.writeBody(input));
  expect(written.snapshot).toMatchObject({
    result: { status: "ok" },
    effect: { outcome: "confirmed" },
  });
  const read = (
    await workspaceResultCodec.deserialize(await f.service.readBody(input.article))
  ).unwrap();
  expect(read.html).toBe("<p>after</p>");
  expect(read.bodyHash).toBe((await hashBody(read.html)).unwrap());
  expect(
    (await reply(f.service.writeBody({ ...input, operationId: f.id() }))).snapshot,
  ).toMatchObject({ result: { status: "error", error: { code: "content_conflict" } } });
  expect(f.writes()).toBe(1);
  expect(f.saves()).toBe(0);
});

test("same-key concurrent BODY executes once and replays history without a live target", async () => {
  const f = await fixture();
  const input = {
    operationId: f.id(),
    article: f.article.article,
    html: "after",
    expectedHash: f.article.bodyHash,
  };
  const [first, second] = await Promise.all([
    reply(f.service.writeBody(input)),
    reply(f.service.writeBody(input)),
  ]);
  expect(first.snapshot).toEqual(second.snapshot);
  expect(f.writes()).toBe(1);
  f.loseTarget();
  expect((await reply(f.service.writeBody(input))).snapshot).toEqual(first.snapshot);
  expect((await reply(f.service.getOperation(input.operationId))).snapshot).toEqual(first.snapshot);
  expect(f.writes()).toBe(1);
});

test("a changed payload cannot take over an existing request", async () => {
  const f = await fixture();
  const input = {
    operationId: f.id(),
    article: f.article.article,
    html: "after",
    expectedHash: f.article.bodyHash,
  };
  await reply(f.service.writeBody(input));
  expect(await f.service.writeBody({ ...input, html: "other" })).toMatchObject({
    status: "error",
    error: { failure: { code: "operation_conflict" } },
  });
  expect(f.writes()).toBe(1);
});

test("explicit SAVE uses inspected versions and keeps the draft available for editing", async () => {
  const f = await fixture();
  const state = (
    await articleStateResultCodec.deserialize(
      await f.service.inspectArticle(f.article.article, { all: true }),
    )
  ).unwrap();
  const input = {
    operationId: f.id(),
    article: state.article,
    expectedBodyHash: state.bodyHash,
    expectedFieldsHash: state.fieldsHash,
    expectedCoverHash: state.coverHash,
  };
  const saved = await reply(f.service.saveArticle(input));
  expect(saved.snapshot).toMatchObject({
    effect: { outcome: "confirmed", persistence: "unverified" },
    result: { status: "ok" },
  });
  expect((await reply(f.service.saveArticle(input))).snapshot).toEqual(saved.snapshot);
  expect(f.saves()).toBe(1);
  f.replaceBody("external edit");
  expect(
    (await reply(f.service.saveArticle({ ...input, operationId: f.id() }))).snapshot,
  ).toMatchObject({ result: { status: "error", error: { code: "content_conflict" } } });
  expect(f.saves()).toBe(1);
});

test("complete inspection rejects drift and never silently adopts later content", async () => {
  const f = await fixture();
  let reads = 0;
  f.pages.readArticleCover = async () => {
    if (++reads === 1) f.replaceBody("changed between observations");
    return Result.ok("c".repeat(64));
  };
  expect(await f.service.inspectArticle(f.article.article, { all: true })).toMatchObject({
    status: "error",
    error: { code: "content_conflict" },
  });
  expect(f.writes()).toBe(0);
});

test("old confirmed SAVE with missing BG cleanup is immutable history, not a BODY lock", async () => {
  const f = await fixture();
  const id = f.id();
  await f.records.claim({
    operationId: id,
    operation: "save",
    requestDigest: "a".repeat(64),
    localRequestDigest: "b".repeat(64),
    effect: { outcome: "not_dispatched", persistence: "unverified" },
  });
  const original = (
    await f.records.finish(
      id,
      { outcome: "confirmed", persistence: "unverified" },
      {
        status: "error",
        error: {
          code: "page_failed",
          cause: { at: "bg.reload", kind: "domain", code: "navigation_failed" },
        },
      },
    )
  ).unwrap();
  const written = await reply(
    f.service.writeBody({
      operationId: f.id(),
      article: f.article.article,
      html: "new content",
      expectedHash: f.article.bodyHash,
    }),
  );
  expect(written.snapshot).toMatchObject({ result: { status: "ok" } });
  expect((await reply(f.service.getOperation(id))).snapshot).toEqual(original.snapshot);
  expect(f.saves()).toBe(0);
});

test("lost target refuses a fresh write before native dispatch", async () => {
  const f = await fixture();
  f.loseTarget();
  expect(
    (
      await reply(
        f.service.writeBody({
          operationId: f.id(),
          article: f.article.article,
          html: "x",
          expectedHash: f.article.bodyHash,
        }),
      )
    ).snapshot,
  ).toMatchObject({
    effect: { outcome: "not_dispatched" },
    result: { status: "error", error: { code: "target_unavailable" } },
  });
  expect(f.writes()).toBe(0);
});
