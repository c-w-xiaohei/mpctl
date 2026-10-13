import { Nexus, type Remote } from "@nexus-js/core";
import { Result } from "better-result";
import { articleResultCodec, operationResultCodec, protocolVersion } from "@mpctl/contracts";
import { createArticleCoverPageService } from "../../../entrypoints/mp.content";
import { createOperations } from "../../../src/operations";
import { createWorkspace } from "../../../src/workspace";
import { createPageManager, appmsgRouteIdentity } from "../../../src/pages";
import { createPageEndpoint } from "../../../src/transport/page-bridge";
import { createEditorService } from "../../../src/mp/jsapi";
import { pageEditorToken } from "../../../src/page-contracts";
import {
  articleCoverPageToken,
  draftPageToken,
  coverWriteResultCodec,
  saveWriteResultCodec,
  coverSaveReceiptResultCodec,
  fieldsIdentityResultCodec,
  type CoverExecution,
  type SaveExecution,
  type BodyCoverExecution,
} from "../../../src/background-contracts";

export { Result, createOperations, createWorkspace, operationResultCodec };
export { Nexus, createPageEndpoint, createEditorService, pageEditorToken, protocolVersion };
export { createArticleCoverPageService };
export { coverReceiptResultCodec, bodyCoverRequestDigest } from "../../../src/background-contracts";

// Actual provider, ledger and Nexus transport with a counted Chrome host.
export async function fixture() {
  const databaseName = `t4-correction:${crypto.randomUUID()}`;
  const operations = (await createOperations(databaseName)).unwrap();
  const binding = { tabId: 44, documentId: "original", url: document.location.href };
  let reads = 0;
  let preflight = 0;
  const counts = { attach: 0, move: 0, detach: 0, set: 0, save: 0, receipts: 0, identity: 0 };
  let mainEditor: Remote<import("../../../src/page-contracts").PageEditorService> | undefined;
  const provider = createArticleCoverPageService(
    document,
    () => true,
    () => mainEditor as never,
  );
  const endpoints = ["main", "isolated"].map((side) =>
    createPageEndpoint({
      target: document,
      channelId: "t4-correction",
      side: side as "main" | "isolated",
      eventNames: { fromMain: "t4-main", fromIsolated: "t4-isolated" },
    }),
  );
  const server = new Nexus().configure({
    endpoint: {
      implementation: endpoints[0]!,
      meta: { app: { protocolVersion, editorReady: true } },
    },
  });
  server.provide(articleCoverPageToken, {
    ...provider,
    identity() {
      counts.identity++;
      return provider.identity();
    },
    set(candidate, expected, execution) {
      counts.set++;
      return provider.set(candidate, expected, execution);
    },
    save(execution) {
      counts.save++;
      return provider.save(execution);
    },
    getReceipt(id) {
      counts.receipts++;
      return provider.getReceipt(id);
    },
  });
  server.provide(draftPageToken, {
    listDrafts: async () => ({ status: "ok" as const, value: [] }),
    validateDraft: async () => ({ status: "ok" as const, value: { valid: true, title: "Title" } }),
    currentItemCount: async () => ({ status: "ok" as const, value: 1 }),
  });
  server.provide(
    pageEditorToken,
    createEditorService({
      document,
      timeoutMs: 40,
      invoke(request) {
        if (request.apiName === "mp_editor_get_content") reads++;
        if (request.apiName === "mp_editor_get_isready") counts.identity++;
        (window as any).__MP_Editor_JSAPI__.invoke(request);
      },
    }),
  );
  const client = new Nexus().configure({
    endpoint: { implementation: endpoints[1]!, meta: { app: { protocolVersion } } },
  });
  await Promise.all([client.ready(), server.ready()]);
  const connection = await client.connect({ target: {} });
  mainEditor = connection.get(pageEditorToken);
  const cover = connection.get(articleCoverPageToken, { callTimeout: 25_000 });
  const manager = createPageManager(
    {
      getGroup: async () => ({}),
      createTab: async () => ({ id: 1 }),
      groupTabs: async () => 7,
      updateGroup: async () => {},
      queryGroup: async () => [{ id: binding.tabId, url: binding.url }],
      queryMpTabs: async () => [{ id: binding.tabId, url: binding.url }],
      getTab: async (id: number) => ({ id, url: binding.url }),
      getFrame: async () => ({ documentId: binding.documentId, url: binding.url }),
      getSession: async (key?: string) => (key ? {} : { managedGroupId: 7 }),
      setSession: async () => {},
    } as never,
    undefined,
    async () => ({ state: "ready", route: appmsgRouteIdentity(binding.url)!, documentReady: true }),
    undefined,
    async () => connection,
  );
  manager.observe(binding);
  const pages = {
    findCurrentEditor: async () => {
      preflight++;
      return Result.ok(binding);
    },
    isCurrent: async () => {
      preflight++;
      return Result.ok(true);
    },
    pageStatus: async () => {
      preflight++;
      return Result.ok({ state: "ready", route: "editor", documentReady: true });
    },
    validateSavedArticle: async () => {
      preflight++;
      return Result.ok({ valid: true, title: "Title" });
    },
    open: async () => {
      preflight++;
      return manager.open(binding);
    },
    readArticleFields: async () => {
      preflight++;
      return Result.ok({ title: "", author: "", summary: "" });
    },
    readArticleCover: async () => {
      preflight++;
      const result = await cover.read();
      return result.status === "ok" ? Result.ok(result.value) : Result.err(result.error);
    },
    coverIdentity: async () => fieldsIdentityResultCodec.deserialize(await cover.identity()),
    listMaterials: async () =>
      Result.ok({
        scope: "visible-page",
        cards: [
          {
            filename: "saved-cover-candidate.png",
            thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/synthetic-library-card/300?wx_fmt=png",
          },
        ],
      }),
    setArticleCover: async (
      _binding: unknown,
      candidate: { filename: string; thumbnailUrl: string },
      expected: string,
      execution: CoverExecution,
    ) => coverWriteResultCodec.deserialize(await cover.set(candidate, expected, execution)),
    setCoverFromBody: (_binding: unknown, input: BodyCoverExecution) =>
      manager.setCoverFromBody(binding, input),
    saveArticle: async (_binding: unknown, execution: SaveExecution) =>
      saveWriteResultCodec.deserialize(await cover.save(execution)),
    getExecutionReceipt: async (_binding: unknown, id: string) =>
      coverSaveReceiptResultCodec.deserialize(await cover.getReceipt(id)),
  };
  const workspace = createWorkspace({
    pages: pages as never,
    operations: Promise.resolve(Result.ok(operations)),
  });
  const article = (await articleResultCodec.deserialize(await workspace.currentArticle())).unwrap();
  return {
    workspace,
    operations,
    databaseName,
    provider,
    counts,
    pages,
    binding,
    article,
    stats: () => ({ ...counts, reads, preflight }),
    close() {
      connection.disconnect();
      endpoints.forEach((endpoint) => endpoint.close());
    },
  };
}
