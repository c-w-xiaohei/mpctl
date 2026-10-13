import { Nexus } from "@nexus-js/core";
import { Result } from "better-result";
import { protocolVersion, articleResultCodec } from "@mpctl/contracts";
import { createWorkspace } from "../../../src/workspace";
import { createPageManager } from "../../../src/pages";
import { createOperations } from "../../../src/operations";
import { createEditorService } from "../../../src/mp/jsapi";
import { createPageEndpoint } from "../../../src/transport/page-bridge";
import { pageEditorToken, pageEditorReceiptResultCodec } from "../../../src/page-contracts";
import { saveRequestDigest } from "../../../src/background-contracts";

export async function fixture(nativeSave = false) {
  const operations = (await createOperations()).unwrap();
  const counters = {
    set: 0,
    get: 0,
    field: 0,
    cover: 0,
    upload: 0,
    save: 0,
    reload: 0,
    navigation: 0,
  };
  const bindings = ["a", "b"].map((groupId, index) => ({
    tabId: index + 1,
    documentId: `doc:${groupId}`,
    url: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${groupId}&token=account-one`,
  }));
  let current = bindings[0]!;
  let release!: () => void;
  let reached!: () => void;
  const entered = new Promise<void>((done) => {
    reached = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const remotes = await Promise.all(
    bindings.map(async (binding, index) => {
      let html = "initial";
      const editor = createEditorService({
        timeoutMs: 30_000,
        invoke(request) {
          if (request.apiName === "mp_editor_get_isready")
            request.sucCb({ isReady: true, isNew: true });
          else if (request.apiName === "mp_editor_get_content") {
            counters.get++;
            request.sucCb({ content: html });
          } else {
            counters.set++;
            if (index === 0) {
              reached();
              void gate.then(() => {
                html = "content" in request.apiParam ? request.apiParam.content : "";
                request.sucCb({});
              });
            } else {
              html = "content" in request.apiParam ? request.apiParam.content : "";
              request.sucCb({});
            }
          }
        },
      });
      const target = new EventTarget();
      const channelId = crypto.randomUUID();
      const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
      const main = createPageEndpoint({ target, channelId, side: "main", eventNames });
      const isolated = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
      const provider = new Nexus()
        .configure({ endpoint: { implementation: main, meta: { app: { protocolVersion } } } })
        .provide(pageEditorToken, editor);
      const client = new Nexus().configure({
        endpoint: { implementation: isolated, meta: { app: { protocolVersion } } },
      });
      await Promise.all([provider.ready(), client.ready()]);
      return { binding, remote: (await client.connect({ target: {} })).get(pageEditorToken) };
    }),
  );
  const manager = createPageManager(
    {
      getTab: async (id: number) => ({ id, url: bindings.find((b) => b.tabId === id)!.url }),
    } as never,
    async (binding) => remotes.find((entry) => entry.binding.tabId === binding.tabId)!.remote,
  );
  for (const binding of bindings) manager.observe(binding);
  const pages = {
    getBodyReceipt: async (binding: { tabId: number }, id: string) => {
      const editor = remotes.find((entry) => entry.binding.tabId === binding.tabId)!.remote;
      return pageEditorReceiptResultCodec.deserialize(await editor.getReceipt(id));
    },
    findCurrentEditor: async () => Result.ok(current),
    isCurrent: async () => Result.ok(true),
    pageStatus: async () => Result.ok({ state: "ready", route: "editor", documentReady: true }),
    validateSavedArticle: async () => Result.ok({ valid: true, title: "saved" }),
    open: manager.open.bind(manager),
    readArticleFields: async () => Result.ok({ title: "", author: "", summary: "" }),
    readArticleCover: async () => Result.ok("c".repeat(64)),
    updateArticleFields: async (
      _binding: unknown,
      _fields: { title?: string; author?: string; summary?: string },
      _expectedHash: string,
      _execution: import("../../../src/background-contracts").FieldsExecution,
    ): Promise<
      Result<
        import("../../../src/background-contracts").FieldsReceipt,
        import("@mpctl/contracts").Failure
      >
    > => {
      counters.field++;
      throw new Error("must not mutate");
    },
    setArticleCover: async () => {
      counters.cover++;
      throw new Error("must not mutate");
    },
    uploadMaterial: async () => {
      counters.upload++;
      throw new Error("must not mutate");
    },
    saveArticle: async () => {
      counters.save++;
      throw new Error("must not mutate");
    },
    cleanupWorkspace: async () => {
      counters.navigation++;
      throw new Error("must not navigate");
    },
    ensureEditorTab: async () => {
      counters.navigation++;
      throw new Error("must not navigate");
    },
  };
  const workspace = createWorkspace({
    pages: pages as never,
    operations: Promise.resolve(Result.ok(operations)),
  });
  if (nativeSave) {
    Object.assign(pages, {
      getExecutionReceipt: async () => Result.ok(null),
      coverIdentity: async () => Result.ok({ executorId: crypto.randomUUID() }),
      ensureDraftList: async () =>
        Result.ok({
          tabId: 3,
          documentId: "list",
          url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77",
        }),
      listDraftGroups: async () => Result.ok([{ groupId: "a", title: "saved" }]),
      saveArticle: async (
        _binding: unknown,
        execution: import("../../../src/background-contracts").SaveExecution,
      ) => {
        counters.save++;
        return Result.ok({
          operationId: execution.operationId,
          executorId: execution.executorId,
          requestDigest: await saveRequestDigest(execution),
          effect: { outcome: "confirmed" as const, persistence: "unverified" as const },
          ended: true,
          result: { status: "ok" as const, value: {} },
        });
      },
      listMaterials: async () => {
        counters.navigation++;
        return Result.ok({ scope: "visible-page", cards: [] });
      },
    });
  }
  const first = (await articleResultCodec.deserialize(await workspace.currentArticle())).unwrap();
  current = bindings[1]!;
  const second = (await articleResultCodec.deserialize(await workspace.currentArticle())).unwrap();
  return {
    workspace,
    pages,
    operations,
    first,
    second,
    counters,
    entered,
    release: () => release(),
    unknownContext() {
      bindings[1]!.url = bindings[1]!.url.replace("account-one", "account-unknown");
    },
  };
}
