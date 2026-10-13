export { createMaterialPageService } from "../../../entrypoints/mp.content";
export { createOperationId, assetRequestDigest } from "@mpctl/contracts";
export { NexusError, Token } from "@nexus-js/core";
import { Nexus } from "@nexus-js/core";
import { protocolVersion } from "@mpctl/contracts";
import { createMaterialPageService } from "../../../entrypoints/mp.content";
import { materialPageToken, contentStatusToken } from "../../../src/background-contracts";
import { pageEditorToken } from "../../../src/page-contracts";
import { createPageEndpoint } from "../../../src/transport/page-bridge";
import { createEditorService } from "../../../src/mp/jsapi";
import { fixedDocumentStatus, fixedDocumentWorkspace } from "./fixed-document";

export async function lostUploadReplyFixture(
  document: Document,
  dropReply = true,
  validateTarget = () => true,
) {
  const target = new EventTarget();
  const channelId = crypto.randomUUID();
  const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
  let drop = false;
  let dropped = 0;
  const dispatch = target.dispatchEvent.bind(target);
  target.dispatchEvent = (event) => {
    if (drop && event.type === eventNames.fromMain && (event as CustomEvent).detail?.message) {
      drop = false;
      dropped++;
      return true;
    }
    return dispatch(event);
  };
  document.querySelector<HTMLInputElement>("input[type=file]")!.addEventListener("change", () => {
    drop = dropReply;
  });
  const main = createPageEndpoint({ target, channelId, side: "main", eventNames });
  const isolated = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
  const material = createMaterialPageService(document, validateTarget);
  const provider = new Nexus()
    .configure({
      endpoint: { implementation: main, meta: { app: { protocolVersion, editorReady: true } } },
    })
    .provide(materialPageToken, material)
    .provide(
      pageEditorToken,
      createEditorService({
        invoke(request) {
          if (request.apiName === "mp_editor_get_isready")
            request.sucCb({ isReady: true, isNew: true });
          else request.sucCb({ content: "unchanged" });
        },
      }),
    )
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
      token === materialPageToken ? { ...options, callTimeout: 100 } : options,
    )) as typeof connection.safeGet;
  const { pages, operations, workspace, article } = await fixedDocumentWorkspace(
    document,
    "upload-document",
    connection,
  );
  return {
    workspace,
    operations,
    article,
    material,
    pages,
    connection,
    dropped: () => dropped,
    close() {
      pages.dispose();
      main.close?.();
      isolated.close?.();
    },
  };
}
