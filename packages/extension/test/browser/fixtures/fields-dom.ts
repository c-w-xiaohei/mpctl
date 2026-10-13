export { createArticleFieldsService } from "../../../entrypoints/mp.content";
export { hashArticleFields } from "../../../src/mp/article-fields";
export { createOperationId } from "@mpctl/contracts";
import { Nexus } from "@nexus-js/core";
import { protocolVersion } from "@mpctl/contracts";
import { createArticleFieldsService } from "../../../entrypoints/mp.content";
import { articleFieldsToken, contentStatusToken } from "../../../src/background-contracts";
import { pageEditorToken } from "../../../src/page-contracts";
import { createPageEndpoint } from "../../../src/transport/page-bridge";
import { createEditorService } from "../../../src/mp/jsapi";
import { fixedDocumentStatus, fixedDocumentWorkspace } from "./fixed-document";

export async function lostFieldsReplyFixture(document: Document) {
  const counts = { ready: 0, get: 0, set: 0, fieldInput: 0, fieldChange: 0, dropped: 0 };
  const author = document.querySelector<HTMLInputElement>("#author")!;
  const target = new EventTarget();
  const channelId = crypto.randomUUID();
  const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
  let drop = false;
  let mainAvailable = true;
  const dispatch = target.dispatchEvent.bind(target);
  target.dispatchEvent = (event) => {
    if (drop && event.type === eventNames.fromMain && (event as CustomEvent).detail?.message) {
      drop = false;
      counts.dropped++;
      return true;
    }
    return dispatch(event);
  };
  author.addEventListener("input", () => {
    counts.fieldInput++;
  });
  author.addEventListener("change", () => {
    counts.fieldChange++;
    drop = true;
  });
  const main = createPageEndpoint({ target, channelId, side: "main", eventNames });
  const isolated = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
  const fields = createArticleFieldsService(document, () => true);
  const editor = createEditorService({
    invoke(request) {
      if (!mainAvailable) throw new Error("MAIN unavailable");
      if (request.apiName === "mp_editor_get_isready") {
        counts.ready++;
        request.sucCb({ isReady: true, isNew: true });
      } else if (request.apiName === "mp_editor_get_content") {
        counts.get++;
        request.sucCb({ content: "body" });
      } else {
        counts.set++;
        request.sucCb({});
      }
    },
  });
  const provider = new Nexus()
    .configure({
      endpoint: { implementation: main, meta: { app: { protocolVersion, editorReady: true } } },
    })
    .provide(articleFieldsToken, fields)
    .provide(pageEditorToken, editor)
    .provide(contentStatusToken, fixedDocumentStatus(document));
  const client = new Nexus().configure({
    endpoint: { implementation: isolated, meta: { app: { protocolVersion } } },
  });
  await Promise.all([provider.ready(), client.ready()]);
  const connection = await client.connect({ target: {} });
  const originalGet = connection.safeGet.bind(connection);
  connection.safeGet = ((token, options) =>
    originalGet(
      token,
      token === articleFieldsToken ? { ...options, callTimeout: 100 } : options,
    )) as typeof connection.safeGet;
  const { pages, operations, workspace, article } = await fixedDocumentWorkspace(
    document,
    "fields-document",
    connection,
  );
  return {
    workspace,
    operations,
    article,
    counts,
    async stopMain() {
      mainAvailable = false;
      await provider.updateIdentity({ app: { protocolVersion, editorReady: false } });
    },
    close() {
      pages.dispose();
      main.close?.();
      isolated.close?.();
    },
  };
}
