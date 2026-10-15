import { defineContentScript } from "wxt/utils/define-content-script";
import { Nexus, type NexusInstance, type Remote } from "@nexus-js/core";
import { createContentScriptConfig, chromeTarget, type ChromeAdapterModel } from "@nexus-js/chrome";
import { injectMainWorldBridge, type PageBridgeAdapterModel } from "../src/transport/page-bridge";
import { Result } from "better-result";
import { protocolVersion } from "@mpctl/contracts";
import { configureNexusDebug } from "@mpctl/contracts/nexus-debug";
import {
  operationIdSchema,
  assetPayloadSchema,
  assetRequestDigest,
  type Failure,
} from "@mpctl/contracts";
import * as v from "valibot";
import { hasPreparationVersion, type ContentAppMeta } from "../src/background-runtime";
import type { AuthorizationPolicy } from "@nexus-js/core";
import type { SerializedResult } from "better-result";
import { pageEditorReadyResultCodec, pageEditorToken } from "../src/page-contracts";
import { documentWriteResultCodec, documentWriteReleaseResultCodec } from "../src/page-contracts";
import { documentWritesFor } from "../src/mp/document-writes";
import { hashBody } from "../src/mp/body-hash";
import {
  contentStatusToken,
  contentStatusResultCodec,
  homePageToken,
  homeIsReadyResultCodec,
  openDraftListResultCodec,
  listDraftsResultCodec,
  validateDraftResultCodec,
  currentItemCountResultCodec,
  articleFieldsToken,
  articleFieldsResultCodec,
  articleFieldUpdateResultCodec,
  fieldsExecutionSchema,
  fieldsIdentityResultCodec,
  fieldsReceiptResultCodec,
  fieldsRequestDigest,
  fieldsRequestSignature,
  type FieldsReceipt,
  materialPageToken,
  materialListResultCodec,
  materialUploadResultCodec,
  materialIdentityResultCodec,
  uploadReceiptResultCodec,
  uploadExecutionSchema,
  articleCoverPageToken,
  coverExecutionSchema,
  saveExecutionSchema,
  coverWriteResultCodec,
  saveWriteResultCodec,
  coverSaveReceiptResultCodec,
  coverRequestDigest,
  saveRequestDigest,
  type CoverExecution,
  type SaveExecution,
  type CoverReceipt,
  type SaveReceipt,
  articleCoverHashResultCodec,
} from "../src/background-contracts";
import {
  detectLoginTimeout,
  createEditorTargetValidator,
  observeLoginTimeout,
  waitForDocumentReady,
  waitForEditorPageDecision,
} from "../src/mp/editor";
import { draftPageToken } from "../src/background-contracts";
import { appmsgRouteIdentity, classifyAppmsgUrl } from "../src/mp/routes";
import { createEditorRouteValidator } from "../src/mp/editor-route";
import {
  countVisibleAppmsgItems,
  hasUniqueObservedCurrentItem,
  listDraftGroups,
} from "../src/mp/drafts";
import {
  hashArticleFields,
  readArticleFields,
  validateArticleFieldUpdate,
  writeArticleFields,
  initialFieldsEffect,
} from "../src/mp/article-fields";
import { listMaterials } from "../src/mp/material-library";
import { uploadMaterial } from "../src/mp/asset-upload";
import { readArticleCover, hashArticleCover } from "../src/mp/article-cover";
import { setArticleCover, coverPreviewVisible as isVisible } from "../src/mp/cover-input";
import { saveArticle as saveNativeArticle } from "../src/mp/article-save";

type ProtocolError = { code: "invalid_result_envelope" };

async function encodeServiceResult<T, E extends { code: string }>(
  codec: {
    serialize(
      result: import("better-result").Result<T, E>,
    ): Promise<
      import("better-result").Result<SerializedResult<T, E | ProtocolError>, ProtocolError>
    >;
  },
  result: import("better-result").Result<T, E>,
): Promise<SerializedResult<T, E | ProtocolError>> {
  const encoded = await codec.serialize(result);
  return Result.isOk(encoded) ? encoded.value : { status: "error", error: encoded.error };
}

export async function initializeContentServices(
  dependencies: {
    document: Document;
    pageRuntime: NexusInstance<PageBridgeAdapterModel>;
    chromeRuntime: NexusInstance<ChromeAdapterModel<ContentAppMeta>>;
    app?: ContentAppMeta;
    pageState(): Promise<{
      state: "ready" | "not_logged_in" | "loading";
      route: string;
      documentReady: boolean;
    }>;
    validateTarget(): boolean;
    onDispose?(cleanup: () => void | Promise<void>): void;
    onEditor?(
      editor: () =>
        | Remote<import("../src/page-contracts").PageEditorService, PageBridgeAdapterModel>
        | undefined,
    ): void;
  },
  editorToken: typeof pageEditorToken = pageEditorToken,
): Promise<import("better-result").Result<boolean, { code: string }>> {
  const app = dependencies.app ?? { protocolVersion, editorReady: false };
  const initialStatus = await Result.tryPromise({
    try: () => dependencies.pageState(),
    catch: () => ({ code: "page_failed" }),
  });
  if (Result.isError(initialStatus)) return initialStatus;
  if (initialStatus.value.state === "not_logged_in") return Result.err({ code: "not_logged_in" });
  const connected = await Result.tryPromise({
    try: () => dependencies.pageRuntime.connect({ target: {}, timeout: 10_000 }),
    catch: () => ({ code: "page_failed" }),
  });
  if (Result.isError(connected)) return connected;
  const pageConnection = connected.value;
  const disconnectWithError = (error: { code: string }) => {
    const disconnected = disconnectPageConnection(pageConnection);
    if (Result.isError(disconnected)) reportStartupFailure(disconnected.error);
    return Result.err(error);
  };
  if (!hasPreparationVersion(pageConnection.contextMeta))
    return disconnectWithError({ code: "version_mismatch" });
  const editorResult = pageConnection.safeGet(editorToken);
  if (Result.isError(editorResult)) return disconnectWithError(editorResult.error);
  const editor = editorResult.value;
  const assertUnchanged = () =>
    Result.try({
      try: () => {
        if (
          pageConnection.status !== "connected" ||
          !hasPreparationVersion(pageConnection.contextMeta)
        )
          return false;
        if (detectLoginTimeout(dependencies.document).state === "not_logged_in") return false;
        return dependencies.validateTarget();
      },
      catch: () => ({ code: "page_failed" }),
    }).andThen((valid) => (valid ? Result.ok() : Result.err({ code: "target_unavailable" })));
  const beforeReady = assertUnchanged();
  if (Result.isError(beforeReady)) return disconnectWithError(beforeReady.error);
  const readyWire = await Nexus.safeCall(editor.ready());
  if (Result.isError(readyWire)) return disconnectWithError(readyWire.error);
  const ready = await pageEditorReadyResultCodec.deserialize(readyWire.value);
  if (Result.isError(ready)) return disconnectWithError(ready.error);
  const afterReady = assertUnchanged();
  if (Result.isError(afterReady)) return disconnectWithError(afterReady.error);
  if (!ready.value.isReady || !ready.value.isNew)
    return disconnectWithError({ code: "unsupported_editor" });
  const finalStatus = await Result.tryPromise({
    try: () => dependencies.pageState(),
    catch: () => ({ code: "page_failed" }),
  });
  if (Result.isError(finalStatus)) return disconnectWithError(finalStatus.error);
  if (finalStatus.value.state === "not_logged_in")
    return disconnectWithError({ code: "not_logged_in" });
  if (finalStatus.value.state !== "ready") return disconnectWithError({ code: "editor_not_ready" });
  const beforeRelay = assertUnchanged();
  if (Result.isError(beforeRelay)) return disconnectWithError(beforeRelay.error);
  const relayCreated = Result.try({
    try: () =>
      Nexus.relay<ChromeAdapterModel<ContentAppMeta>, PageBridgeAdapterModel>({
        from: dependencies.chromeRuntime,
        to: {
          nexus: dependencies.pageRuntime,
          where: (
            identity: PageBridgeAdapterModel["contextMeta"],
            observed: PageBridgeAdapterModel["connectionMeta"],
          ) =>
            observed === pageConnection.connectionMeta &&
            identity === pageConnection.contextMeta &&
            pageConnection.status === "connected" &&
            hasPreparationVersion(identity) &&
            Result.isOk(assertUnchanged()),
        },
        services: [editorToken],
      }),
    catch: () => ({ code: "page_failed" as const }),
  });
  if (Result.isError(relayCreated)) {
    const disconnected = disconnectPageConnection(pageConnection);
    if (Result.isError(disconnected)) reportStartupFailure(disconnected.error);
    return relayCreated;
  }
  const relay = relayCreated.value;
  let active = true;
  const revoke = () => {
    if (!active) return;
    active = false;
    app.editorReady = false;
    const disposed = disposeRelay(relay);
    if (Result.isError(disposed)) reportStartupFailure(disposed.error);
    return dependencies.chromeRuntime
      .updateIdentity({ app: { ...app } })
      .catch(() => reportStartupFailure({ code: "page_failed" }));
  };
  pageConnection.onDisconnected(revoke);
  pageConnection.subscribeIdentity((identity) => {
    if (!hasPreparationVersion(identity)) revoke();
  });
  const registration = Result.try({
    try: () => dependencies.onDispose?.(revoke),
    catch: () => ({ code: "page_failed" as const }),
  });
  if (Result.isError(registration)) {
    const relayDisposed = disposeRelay(relay);
    const disconnected = disconnectPageConnection(pageConnection);
    if (Result.isError(relayDisposed)) reportStartupFailure(relayDisposed.error);
    if (Result.isError(disconnected)) reportStartupFailure(disconnected.error);
    return registration;
  }
  const beforePublication = assertUnchanged();
  if (Result.isError(beforePublication)) {
    await revoke();
    return disconnectWithError(beforePublication.error);
  }
  const identity = await Result.tryPromise({
    try: () => {
      app.editorReady = active;
      return dependencies.chromeRuntime.updateIdentity({ app: { ...app } });
    },
    catch: () => ({ code: "page_failed" }),
  });
  if (Result.isError(identity)) {
    await revoke();
    const disconnected = disconnectPageConnection(pageConnection);
    if (Result.isError(disconnected)) reportStartupFailure(disconnected.error);
    return identity;
  }
  const afterPublication = assertUnchanged();
  if (!active || Result.isError(afterPublication)) {
    await revoke();
    // An in-flight ready snapshot can arrive after invalidation's revoke.
    // Fence that snapshot before returning the terminal result.
    app.editorReady = false;
    await dependencies.chromeRuntime
      .updateIdentity({ app: { ...app } })
      .catch(() => reportStartupFailure({ code: "page_failed" }));
    return disconnectWithError(
      Result.isError(afterPublication) ? afterPublication.error : { code: "target_unavailable" },
    );
  }
  dependencies.onEditor?.(() =>
    active &&
    pageConnection.status === "connected" &&
    hasPreparationVersion(pageConnection.contextMeta)
      ? editor
      : undefined,
  );
  return Result.ok(true);
}

function disposeRelay(relay: {
  dispose(): void;
}): import("better-result").Result<void, { code: "page_failed" }> {
  const disposed = Result.try({
    try: () => relay.dispose(),
    catch: () => ({ code: "page_failed" as const }),
  });
  return Result.isError(disposed) ? disposed : Result.ok();
}

function disconnectPageConnection(connection: {
  disconnect(): void;
}): import("better-result").Result<void, { code: "page_failed" }> {
  const disconnected = Result.try({
    try: () => connection.disconnect(),
    catch: () => ({ code: "page_failed" as const }),
  });
  return Result.isError(disconnected) ? disconnected : Result.ok();
}

type ContentStartupError =
  | { code: "document_not_ready" | "route_unsupported" | "setup_failed" }
  | import("../src/transport/page-bridge").BridgeCleanupError;

/** Owns expected WXT startup failures and disposes any acquired page resources before returning. */
export async function runContentStartup(options: {
  document: Document;
  ctx: { onInvalidated(callback: () => void): unknown };
  route: ReturnType<typeof classifyAppmsgUrl>;
  stopWatchingLogin(): void;
  prepareEditor(): Promise<import("better-result").Result<void, { code: string }>>;
  waitForDocument(): Promise<boolean>;
  waitForDraftDecision(): Promise<"ready" | "not_logged_in" | "loading">;
  cleanupEditor?(): Promise<import("../src/transport/page-bridge").BridgeCleanupResult>;
}): Promise<import("better-result").Result<void, ContentStartupError>> {
  const documentReady = await Result.tryPromise({
    try: async () => options.waitForDocument(),
    catch: () => ({ code: "document_not_ready" as const }),
  });
  if (Result.isError(documentReady) || !documentReady.value) {
    const cleanup = await cleanupStartupResources(options);
    return Result.isError(cleanup)
      ? Result.err({ code: "setup_failed" })
      : Result.err({ code: "document_not_ready" });
  }

  if (options.route.kind === "draft-list") {
    const decision = await Result.tryPromise({
      try: async () => options.waitForDraftDecision(),
      catch: () => ({ code: "setup_failed" as const }),
    });
    if (Result.isError(decision)) {
      const cleanup = stopWatching(options.stopWatchingLogin);
      return Result.isError(cleanup) ? cleanup : decision;
    }
    if (decision.value === "loading") {
      const cleanup = stopWatching(options.stopWatchingLogin);
      return Result.isError(cleanup) ? cleanup : Result.err({ code: "setup_failed" });
    }
  }
  if (options.route.kind === "home" || options.route.kind === "draft-list") {
    const registered = registerInvalidation(options.ctx, async () =>
      stopWatching(options.stopWatchingLogin),
    );
    if (Result.isError(registered)) {
      const cleaned = stopWatching(options.stopWatchingLogin);
      return Result.isError(cleaned) ? cleaned : Result.err({ code: "setup_failed" });
    }
    return Result.ok();
  }
  if (options.route.kind !== "new" && options.route.kind !== "saved-editor") {
    const cleanup = stopWatching(options.stopWatchingLogin);
    return Result.isError(cleanup) ? cleanup : Result.err({ code: "route_unsupported" });
  }

  const registered = registerInvalidation(options.ctx, () => cleanupStartupResources(options));
  if (Result.isError(registered)) {
    const cleanup = await cleanupStartupResources(options);
    if (Result.isError(cleanup)) return Result.err(cleanup.error);
    return Result.err({ code: "setup_failed" });
  }
  const result = await options.prepareEditor();
  if (Result.isError(result)) {
    // MAIN belongs to bootstrap; login observation belongs to the live document,
    // just like the independently published Chrome status service.
    const cleanup = options.cleanupEditor ? await options.cleanupEditor() : Result.ok();
    if (Result.isError(cleanup)) return Result.err(cleanup.error);
    return Result.err({ code: "setup_failed" });
  }
  return Result.ok();
}

function registerInvalidation(
  ctx: { onInvalidated(callback: () => void | Promise<void>): unknown },
  cleanup: () => Promise<import("better-result").Result<void, { code: string }>>,
): import("better-result").Result<void, { code: "setup_failed" }> {
  return Result.try({
    try: () => {
      ctx.onInvalidated(() => {
        void Result.tryPromise({
          try: async () => cleanup(),
          catch: () => ({ code: "setup_failed" as const }),
        }).then(
          (result) => {
            if (Result.isError(result)) {
              reportStartupFailure(result.error);
              return;
            }
            if (Result.isError(result.value)) reportStartupFailure(result.value.error);
          },
          (error) => reportStartupFailure(error),
        );
      });
    },
    catch: () => ({ code: "setup_failed" as const }),
  });
}

async function cleanupStartupResources(options: {
  stopWatchingLogin(): void;
  cleanupEditor?(): Promise<import("../src/transport/page-bridge").BridgeCleanupResult>;
}): Promise<
  import("better-result").Result<
    void,
    { code: "setup_failed" } | import("../src/transport/page-bridge").BridgeCleanupError
  >
> {
  const watcher = stopWatching(options.stopWatchingLogin);
  const editor = options.cleanupEditor ? await options.cleanupEditor() : Result.ok();
  return Result.isError(editor) ? editor : watcher;
}

function stopWatching(
  stop: () => void,
): import("better-result").Result<void, { code: "setup_failed" }> {
  return Result.try({ try: () => stop(), catch: () => ({ code: "setup_failed" as const }) });
}

export function createDraftPageService(document: Document) {
  const routeIdentity = appmsgRouteIdentity(document.location.href);
  const isOriginalDraftList = classifyAppmsgUrl(document.location.href).kind === "draft-list";
  const isCurrentDraftList = () =>
    isOriginalDraftList &&
    routeIdentity !== undefined &&
    appmsgRouteIdentity(document.location.href) === routeIdentity;
  return {
    async listDrafts() {
      const result = !isCurrentDraftList()
        ? Result.err({ code: "route_changed" as const })
        : Result.try({
            try: () =>
              listDraftGroups(document).map((draft) => ({
                candidate: draft.groupId,
                title: draft.title,
              })),
            catch: () => ({ code: "page_failed" as const }),
          });
      return encodeServiceResult(listDraftsResultCodec, result);
    },
    async validateDraft(candidate: string) {
      const result = Result.try({
        try: () => {
          const current = classifyAppmsgUrl(document.location.href);
          return current.kind === "saved-editor" && current.groupId === candidate
            ? { valid: hasUniqueObservedCurrentItem(document), title: "" }
            : undefined;
        },
        catch: () => ({ code: "page_failed" as const }),
      });
      return encodeServiceResult(
        validateDraftResultCodec,
        Result.isError(result)
          ? result
          : result.value === undefined
            ? Result.err({ code: "route_changed" })
            : result,
      );
    },
    async currentItemCount() {
      return encodeServiceResult(
        currentItemCountResultCodec,
        Result.try({
          try: () => countVisibleAppmsgItems(document),
          catch: () => ({ code: "page_failed" as const }),
        }),
      );
    },
  };
}

export function createHomePageService(document: Document) {
  const controls = (selector: string, matches: (element: HTMLElement) => boolean) => {
    return [...document.querySelectorAll<HTMLElement>(selector)].filter(
      (element) => isVisible(element) && matches(element),
    );
  };
  const uniqueControl = (selector: string, matches: (element: HTMLElement) => boolean) => {
    const matching = controls(selector, matches);
    return matching.length === 1 ? matching[0] : undefined;
  };
  const isDraftLink = (element: HTMLElement) => {
    if (element.textContent?.trim() !== "草稿箱") return false;
    try {
      const url = new URL((element as HTMLAnchorElement).href);
      return (
        url.origin === "https://mp.weixin.qq.com" &&
        url.pathname === "/cgi-bin/appmsg" &&
        hasExactQueryKeys(url.searchParams, ["begin", "count", "type", "action", "token", "lang"])
      );
    } catch {
      return false;
    }
  };
  const isArticleItem = (element: HTMLElement) => element.textContent?.trim() === "文章";
  return {
    async isReady() {
      const result = Result.try({
        try: () =>
          controls("a.weui-desktop-menu__link.menu_report", isDraftLink).length === 1 &&
          controls("div.new-creation__menu-item", isArticleItem).length === 1,
        catch: () => ({ code: "page_failed" as const }),
      });
      return encodeServiceResult(homeIsReadyResultCodec, result);
    },
    async openDraftList() {
      const result = Result.try({
        try: () => uniqueControl("a.weui-desktop-menu__link.menu_report", isDraftLink),
        catch: () => ({ code: "page_failed" as const }),
      }).andThen((link) =>
        link
          ? Result.ok((link as HTMLAnchorElement).href)
          : Result.err({ code: "control_unavailable" as const }),
      );
      return encodeServiceResult(openDraftListResultCodec, result);
    },
  };
}

function hasExactQueryKeys(params: URLSearchParams, expected: string[]): boolean {
  const keys = [...params.keys()];
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.filter((item) => item === key).length === 1)
  );
}

export default defineContentScript({
  matches: ["https://mp.weixin.qq.com/*"],
  runAt: "document_start",
  async main(ctx) {
    configureNexusDebug(
      "content",
      Boolean(import.meta.env.DEV) && import.meta.env.VITE_MPCTL_NEXUS_DEBUG !== "0",
    );
    const route = classifyAppmsgUrl(location.href);
    const routeIdentity = appmsgRouteIdentity(location.href) ?? "unsupported";
    const app: ContentAppMeta = {
      protocolVersion,
      editorReady: false,
      loginExpired: detectLoginTimeout(document).state === "not_logged_in",
    };
    let fieldsActive = true;
    let existingEditor:
      | (() =>
          | Remote<import("../src/page-contracts").PageEditorService, PageBridgeAdapterModel>
          | undefined)
      | undefined;
    ctx.onInvalidated(() => {
      fieldsActive = false;
    });
    const isOriginalEditor = createEditorTargetValidator(document);
    const validateTarget = () => fieldsActive && !app.loginExpired && isOriginalEditor();
    const chromeRuntime = new Nexus<ChromeAdapterModel<ContentAppMeta>>();
    chromeRuntime.configure({
      ...createContentScriptConfig<ContentAppMeta>({
        app: { ...app },
      }),
      policy: contentAuthorizationPolicy(validateTarget),
    });
    const runtimeReady = await Result.tryPromise({
      try: async () => chromeRuntime.ready(),
      catch: () => ({ code: "setup_failed" as const }),
    });
    if (Result.isError(runtimeReady)) {
      reportStartupFailure(runtimeReady.error);
      return;
    }
    if (!fieldsActive) return;
    chromeRuntime.provide(draftPageToken, createDraftPageService(document));
    chromeRuntime.provide(
      articleFieldsToken,
      createArticleFieldsService(
        document,
        () => fieldsActive && validateTarget(),
        () => existingEditor?.(),
      ),
    );
    chromeRuntime.provide(
      materialPageToken,
      createMaterialPageService(
        document,
        () => fieldsActive && validateTarget(),
        () => existingEditor?.(),
      ),
    );
    chromeRuntime.provide(
      articleCoverPageToken,
      createArticleCoverPageService(
        document,
        () => fieldsActive && validateTarget(),
        () => (fieldsActive ? existingEditor?.() : undefined),
      ),
    );
    chromeRuntime.provide(homePageToken, createHomePageService(document));
    const stopWatchingLogin = observeLoginTimeout(document, (state) => {
      if (!fieldsActive || appmsgRouteIdentity(document.location.href) !== routeIdentity) return;
      const expired = state === "not_logged_in";
      if (expired === app.loginExpired) return;
      app.loginExpired = expired;
      void chromeRuntime
        .updateIdentity({ app: { ...app } })
        .catch(() => reportStartupFailure({ code: "page_failed" }));
    });
    chromeRuntime.provide(
      contentStatusToken,
      createContentStatusService(document, validateTarget, () => app.loginExpired === true),
    );
    let pageRuntime: Nexus<PageBridgeAdapterModel> | undefined;
    let bridge: import("../src/transport/page-bridge").IsolatedPageBridge | undefined;
    const cleanupEditorBootstrap = async (): Promise<
      import("../src/transport/page-bridge").BridgeCleanupResult
    > => (bridge ? bridge.dispose() : Result.ok());
    const backgroundConnected = await Result.tryPromise({
      try: async () => chromeRuntime.connect({ target: chromeTarget.background(), timeout: 2_000 }),
      catch: () => ({ code: "setup_failed" as const }),
    });
    if (Result.isError(backgroundConnected) || !fieldsActive) {
      const cleanup = await cleanupStartupResources({
        stopWatchingLogin,
        cleanupEditor: cleanupEditorBootstrap,
      });
      if (Result.isError(cleanup)) reportStartupFailure(cleanup.error);
      if (Result.isError(backgroundConnected)) reportStartupFailure(backgroundConnected.error);
      return;
    }
    const startup = await runContentStartup({
      document,
      ctx,
      route,
      stopWatchingLogin,
      cleanupEditor: cleanupEditorBootstrap,
      waitForDocument: () => waitForDocumentReady(document),
      async waitForDraftDecision() {
        const pageDecision = waitForEditorPageDecision(document, () => false, 10_000);
        const decision = await pageDecision.result;
        pageDecision.dispose();
        return decision;
      },
      async prepareEditor() {
        const bridgeResult = await injectMainWorldBridge(document, undefined, async (endpoint) => {
          pageRuntime = new Nexus<PageBridgeAdapterModel>();
          pageRuntime.configure({
            endpoint: { implementation: endpoint, meta: { app: { protocolVersion } } },
            policy: {
              canConnect: ({ remoteIdentity }) => hasPreparationVersion(remoteIdentity),
              canCall: ({ remoteIdentity }) => hasPreparationVersion(remoteIdentity),
            },
          });
          await pageRuntime.ready();
        });
        if (Result.isError(bridgeResult)) return Result.err({ code: "setup_failed" as const });
        bridge = bridgeResult.value;
        if (!fieldsActive) {
          const cleanup = await cleanupEditorBootstrap();
          return Result.isError(cleanup) ? cleanup : Result.err({ code: "target_unavailable" });
        }
        if (!pageRuntime) return Result.err({ code: "setup_failed" as const });
        const initialized = await initializeContentServices({
          document,
          pageRuntime,
          chromeRuntime,
          app,
          onDispose: (cleanup) => ctx.onInvalidated(cleanup),
          async pageState() {
            return {
              state: app.loginExpired ? "not_logged_in" : "ready",
              route: routeIdentity,
              documentReady: document.readyState !== "loading",
            };
          },
          validateTarget,
          onEditor(accessor) {
            existingEditor = accessor;
          },
        });
        if (Result.isError(initialized)) return initialized;
        return initialized.value ? Result.ok() : Result.err({ code: "setup_failed" as const });
      },
    });
    if (Result.isError(startup)) {
      reportStartupFailure(startup.error);
      return;
    }
  },
});

export function contentAuthorizationPolicy(
  validateTarget: () => boolean,
): AuthorizationPolicy<ChromeAdapterModel<ContentAppMeta>> {
  return {
    canConnect: ({ remoteIdentity }) => hasPreparationVersion(remoteIdentity),
    canCall: ({ serviceName, remoteIdentity, localIdentity }) =>
      hasPreparationVersion(remoteIdentity) &&
      (serviceName !== pageEditorToken.id ||
        (localIdentity.app.editorReady &&
          localIdentity.app.loginExpired !== true &&
          validateTarget())),
  };
}

export function createContentStatusService(
  document: Document,
  validateTarget: () => boolean,
  loginExpired: () => boolean = () => false,
) {
  const route = classifyAppmsgUrl(document.location.href);
  return {
    async status() {
      const outcome = Result.try({
        try: () => {
          const domReady = document.readyState !== "loading";
          const hasDraftCard =
            route.kind === "draft-list" &&
            [...document.querySelectorAll<HTMLElement>(".weui-desktop-card[data-appid]")].some(
              (card) => card.isConnected,
            );
          const state =
            detectLoginTimeout(document).state === "not_logged_in" || loginExpired()
              ? ("not_logged_in" as const)
              : domReady &&
                  (route.kind === "home" ||
                    hasDraftCard ||
                    ((route.kind === "new" || route.kind === "saved-editor") && validateTarget()))
                ? ("ready" as const)
                : ("loading" as const);
          return {
            state,
            route: appmsgRouteIdentity(document.location.href) ?? "unsupported",
            documentReady: domReady,
          };
        },
        catch: () => ({ code: "page_failed" as const }),
      });
      return encodeServiceResult(contentStatusResultCodec, outcome);
    },
  };
}

type EditorAccess = () =>
  | Remote<import("../src/page-contracts").PageEditorService, PageBridgeAdapterModel>
  | undefined;
async function acquireDocument(document: Document, access: EditorAccess | undefined, id: string) {
  if (!access) {
    const writes = documentWritesFor(document);
    const acquired = writes.acquire(id);
    return acquired.isErr() ? acquired : Result.ok(async () => writes.release(acquired.value));
  }
  const editor = access?.();
  if (!editor) return Result.err({ code: "target_unavailable" as const });
  const response = await Nexus.safeCall(editor.acquireWrite(id));
  if (response.isErr()) return Result.err({ code: "page_failed" as const });
  const acquired = await documentWriteResultCodec.deserialize(response.value);
  if (acquired.isErr()) return acquired;
  const token = acquired.value;
  return Result.ok(async () => {
    const released = await Nexus.safeCall(editor.releaseWrite(token));
    if (released.isErr()) return Result.err({ code: "page_failed" as const });
    return documentWriteReleaseResultCodec.deserialize(released.value);
  });
}

export function createArticleFieldsService(
  document: Document,
  validateTarget: () => boolean,
  editorAccess?: EditorAccess,
) {
  const executorId = crypto.randomUUID();
  const entries = new Map<
    string,
    {
      signature: string;
      task: Promise<
        import("better-result").SerializedResult<
          FieldsReceipt,
          import("@mpctl/contracts").ServiceError<Failure>
        >
      >;
      receipt?: FieldsReceipt;
    }
  >();
  const sameRoute = createEditorRouteValidator(document);
  const guardedRead = (): import("better-result").Result<
    import("../src/mp/article-fields").ArticleFields,
    { code: string }
  > => {
    if (!sameRoute()) return Result.err({ code: "route_changed" as const });
    if (detectLoginTimeout(document).state === "not_logged_in")
      return Result.err({ code: "not_logged_in" as const });
    if (!validateTarget()) return Result.err({ code: "target_unavailable" as const });
    const fields = readArticleFields(document);
    if (Result.isError(fields)) return fields;
    if (detectLoginTimeout(document).state === "not_logged_in")
      return Result.err({ code: "not_logged_in" as const });
    if (!validateTarget() || !sameRoute())
      return Result.err({ code: "target_unavailable" as const });
    return fields;
  };
  return {
    identity() {
      return encodeServiceResult(fieldsIdentityResultCodec, Result.ok({ executorId }));
    },
    getReceipt(id: string) {
      return encodeServiceResult(
        fieldsReceiptResultCodec,
        v.safeParse(operationIdSchema, id).success
          ? Result.ok(entries.get(id)?.receipt ?? null)
          : Result.err({ code: "invalid_operation" as const }),
      );
    },
    async readArticleFields() {
      const result = Result.try({
        try: guardedRead,
        catch: () => ({ code: "page_failed" as const }),
      }).andThen((fields) => fields);
      const mapped = Result.isError(result)
        ? Result.err({
            code:
              result.error.code === "not_logged_in"
                ? ("not_logged_in" as const)
                : result.error.code === "route_changed" ||
                    result.error.code === "target_unavailable"
                  ? ("route_changed" as const)
                  : ("page_failed" as const),
          })
        : Result.ok(result.value);
      return encodeServiceResult(articleFieldsResultCodec, mapped);
    },
    updateArticleFields(
      input: unknown,
      expectedHash: string,
      execution: import("../src/background-contracts").FieldsExecution,
    ) {
      const validated = validateArticleFieldUpdate(input);
      const bound = v.safeParse(fieldsExecutionSchema, execution);
      const reject = (code: Failure["code"]) =>
        encodeServiceResult(articleFieldUpdateResultCodec, Result.err({ code }));
      if (validated.isErr() || !/^[0-9a-f]{64}$/.test(expectedHash) || !bound.success)
        return reject("invalid_operation");
      if (bound.output.executorId !== executorId) return reject("executor_mismatch");
      const id = bound.output.operationId;
      const signature = fieldsRequestSignature(validated.value, expectedHash);
      const existing = entries.get(id);
      if (existing)
        return existing.signature === signature ? existing.task : reject("operation_conflict");
      let resolve!: (value: Awaited<ReturnType<typeof reject>>) => void;
      const entry: { signature: string; task: ReturnType<typeof reject>; receipt?: FieldsReceipt } =
        {
          signature,
          task: new Promise((done) => {
            resolve = done;
          }),
        };
      entries.set(id, entry);
      void run().then(resolve);
      return entry.task;
      async function run() {
        let receipt: FieldsReceipt | undefined;
        let release: (() => Promise<unknown>) | undefined;
        try {
          const requestDigest = await fieldsRequestDigest(validated.unwrap(), expectedHash);
          receipt = {
            operationId: id,
            executorId,
            requestDigest,
            effect: initialFieldsEffect(validated.unwrap()),
            ended: false,
          };
          entry.receipt = receipt;
          const acquired = await acquireDocument(document, editorAccess, id);
          if (acquired.isErr()) {
            receipt.ended = true;
            receipt.result = { status: "error", error: acquired.error };
            return encodeServiceResult(articleFieldUpdateResultCodec, Result.ok(receipt));
          }
          release = acquired.value;
          const refuse = (code: Failure["code"]) => {
            receipt!.ended = true;
            receipt!.result = {
              status: "error",
              error: { code, cause: { at: "content.preflight", kind: "domain", code } },
            };
          };
          const before = Result.try({
            try: guardedRead,
            catch: () => ({ code: "page_failed" }),
          }).andThen((value) => value);
          if (before.isErr()) refuse(before.error.code as Failure["code"]);
          else {
            const hash = await hashArticleFields(before.value);
            if (hash.isErr()) refuse("hash_failed");
            else if (hash.value !== expectedHash) refuse("content_conflict");
            else {
              const current = guardedRead();
              if (current.isErr()) refuse(current.error.code as Failure["code"]);
              else if (JSON.stringify(current.value) !== JSON.stringify(before.value))
                refuse("content_conflict");
              else
                Object.assign(
                  receipt,
                  await writeArticleFields(
                    document,
                    validated.unwrap(),
                    () => {
                      if (!sameRoute()) return Result.err({ code: "route_changed" as const });
                      if (detectLoginTimeout(document).state === "not_logged_in")
                        return Result.err({ code: "not_logged_in" as const });
                      if (!validateTarget())
                        return Result.err({ code: "target_unavailable" as const });
                      return Result.ok();
                    },
                    (effect) => {
                      receipt!.effect = effect;
                    },
                  ),
                );
            }
          }
          return encodeServiceResult(articleFieldUpdateResultCodec, Result.ok(receipt));
        } catch {
          if (!receipt) return reject("hash_failed");
          receipt.ended = true;
          receipt.result = {
            status: "error",
            error: {
              code: "page_failed",
              cause: { at: "content.preflight", kind: "runtime", code: "unexpected_exception" },
            },
          };
          return encodeServiceResult(articleFieldUpdateResultCodec, Result.ok(receipt));
        } finally {
          if (receipt?.ended) await release?.();
        }
      }
    },
  };
}

export function createMaterialPageService(
  document: Document,
  validateTarget: () => boolean,
  editorAccess?: EditorAccess,
) {
  const executorId = crypto.randomUUID();
  const entries = new Map<
    string,
    {
      digest: Promise<string>;
      task: Promise<
        import("better-result").SerializedResult<
          import("../src/background-contracts").UploadReceipt,
          import("@mpctl/contracts").ServiceError<Failure>
        >
      >;
      receipt?: import("../src/background-contracts").UploadReceipt;
    }
  >();
  const sameRoute = createEditorRouteValidator(document);
  const guard = () => {
    if (!sameRoute()) return Result.err({ code: "route_changed" as const });
    if (detectLoginTimeout(document).state === "not_logged_in")
      return Result.err({ code: "not_logged_in" as const });
    if (!validateTarget()) return Result.err({ code: "target_unavailable" as const });
    return Result.ok(undefined);
  };
  return {
    async list() {
      const acquired = await acquireDocument(
        document,
        editorAccess,
        `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
      );
      if (acquired.isErr())
        return encodeServiceResult(
          materialListResultCodec,
          Result.err({ code: "library_open_unknown" }),
        );
      const result = await listMaterials(document, guard);
      if (result.isOk() || result.error.ended) await acquired.value();
      return encodeServiceResult(materialListResultCodec, result);
    },
    identity() {
      return encodeServiceResult(materialIdentityResultCodec, Result.ok({ executorId }));
    },
    getReceipt(id: string) {
      return encodeServiceResult(
        uploadReceiptResultCodec,
        v.safeParse(operationIdSchema, id).success
          ? Result.ok(entries.get(id)?.receipt ?? null)
          : Result.err({ code: "invalid_operation" as const }),
      );
    },
    upload(
      payload: import("@mpctl/contracts").AssetPayload,
      execution: import("../src/background-contracts").UploadExecution,
    ) {
      const reject = (code: Failure["code"]) =>
        encodeServiceResult(materialUploadResultCodec, Result.err({ code }));
      const parsed = v.safeParse(assetPayloadSchema, payload);
      const bound = v.safeParse(uploadExecutionSchema, execution);
      if (!parsed.success || !bound.success) return reject("invalid_operation");
      payload = parsed.output;
      if (bound.output.executorId !== executorId) return reject("executor_mismatch");
      const id = bound.output.operationId;
      const digest = Promise.resolve().then(() => assetRequestDigest(payload));
      void digest.catch(() => undefined);
      const old = entries.get(id);
      if (old)
        return Promise.all([old.digest, digest]).then(
          ([a, b]) => (a === b ? old.task : reject("operation_conflict")),
          () => reject("hash_failed"),
        );
      let resolve!: (value: Awaited<ReturnType<typeof reject>>) => void;
      const entry: {
        digest: Promise<string>;
        task: ReturnType<typeof reject>;
        receipt?: import("../src/background-contracts").UploadReceipt;
      } = {
        digest,
        task: new Promise((done) => {
          resolve = done;
        }),
      };
      // Reserve before the first asynchronous fingerprint/UI step, including direct Nexus duplicates.
      entries.set(id, entry);
      void run().then(resolve, async () => resolve(await reject("page_failed")));
      return entry.task;
      async function run() {
        let receipt: import("../src/background-contracts").UploadReceipt;
        try {
          receipt = {
            operationId: id,
            executorId,
            requestDigest: await digest,
            effect: { outcome: "not_dispatched", filename: payload.filename },
            ended: false,
          };
        } catch (error) {
          return reject(v.isValiError(error) ? "invalid_asset" : "hash_failed");
        }
        entry.receipt = receipt;
        const acquired = await acquireDocument(document, editorAccess, id);
        if (acquired.isErr()) {
          receipt.ended = true;
          receipt.result = { status: "error", error: acquired.error };
          return encodeServiceResult(materialUploadResultCodec, Result.ok(receipt));
        }
        await uploadMaterial(document, payload, guard, (observation) =>
          Object.assign(receipt, observation),
        );
        if (receipt.ended) await acquired.value();
        return encodeServiceResult(materialUploadResultCodec, Result.ok(receipt));
      }
    },
  };
}

export function createArticleCoverPageService(
  document: Document,
  validateTarget: () => boolean,
  existingEditor?: () =>
    | Remote<import("../src/page-contracts").PageEditorService, PageBridgeAdapterModel>
    | undefined,
) {
  const executorId = crypto.randomUUID();
  const entries = new Map<
    string,
    { signature: string; task: Promise<unknown>; receipt?: CoverReceipt | SaveReceipt }
  >();
  const sameRoute = createEditorRouteValidator(document);
  const guard = (): import("better-result").Result<
    void,
    { code: "route_changed" | "not_logged_in" | "target_unavailable" }
  > => {
    if (!sameRoute()) return Result.err({ code: "route_changed" });
    if (detectLoginTimeout(document).state === "not_logged_in")
      return Result.err({ code: "not_logged_in" });
    if (!validateTarget()) return Result.err({ code: "target_unavailable" });
    return Result.ok(undefined);
  };
  const read = async (): Promise<
    import("better-result").Result<
      string,
      {
        code:
          | "route_changed"
          | "not_logged_in"
          | "target_unavailable"
          | "cover_unavailable"
          | "unsupported"
          | "hash_failed"
          | "page_failed";
      }
    >
  > => {
    const before = guard();
    if (Result.isError(before)) return before;
    const snapshot = readArticleCover(document);
    if (Result.isError(snapshot)) return Result.err({ code: snapshot.error.code });
    const hash = await hashArticleCover(snapshot.value);
    const after = guard();
    if (Result.isError(after)) return after;
    return Result.isError(hash) ? Result.err({ code: hash.error.code }) : Result.ok(hash.value);
  };
  return {
    identity() {
      return encodeServiceResult(fieldsIdentityResultCodec, Result.ok({ executorId }));
    },
    async getReceipt(id: string) {
      if (!entries.has(id)) {
        const editor = existingEditor?.();
        if (editor) {
          const response = await Nexus.safeCall(editor.getCoverReceipt(id));
          return response.isErr()
            ? encodeServiceResult(
                coverSaveReceiptResultCodec,
                Result.err({ code: "receipt_unreachable" }),
              )
            : response.value;
        }
        if (existingEditor)
          return encodeServiceResult(
            coverSaveReceiptResultCodec,
            Result.err({ code: "receipt_unreachable" }),
          );
      }
      return encodeServiceResult(
        coverSaveReceiptResultCodec,
        Result.ok(entries.get(id)?.receipt ?? null),
      );
    },
    async read() {
      const outcome = await read();
      return encodeServiceResult(articleCoverHashResultCodec, outcome);
    },
    set(
      candidate: { filename: string; thumbnailUrl: string },
      expectedHash: string,
      execution: CoverExecution,
    ) {
      const reject = (code: import("@mpctl/contracts").Failure["code"]) =>
        encodeServiceResult(coverWriteResultCodec, Result.err({ code }));
      if (!v.safeParse(coverExecutionSchema, execution).success) return reject("invalid_operation");
      if (
        !v.safeParse(
          v.strictObject({
            filename: v.pipe(v.string(), v.minLength(1)),
            thumbnailUrl: v.pipe(v.string(), v.url()),
          }),
          candidate,
        ).success ||
        !/^[0-9a-f]{64}$/.test(expectedHash)
      )
        return reject("invalid_payload");
      if (execution.executorId !== executorId) return reject("executor_mismatch");
      const signature = JSON.stringify([
        "cover",
        candidate.filename,
        candidate.thumbnailUrl,
        expectedHash,
        execution.asset,
      ]);
      const old = entries.get(execution.operationId);
      if (old)
        return old.signature === signature
          ? (old.task as ReturnType<typeof reject>)
          : reject("operation_conflict");
      let resolve!: (value: Awaited<ReturnType<typeof reject>>) => void;
      const task = new Promise<Awaited<ReturnType<typeof reject>>>((done) => {
        resolve = done;
      });
      const entry: { signature: string; task: typeof task; receipt?: CoverReceipt } = {
        signature,
        task,
      };
      entries.set(execution.operationId, entry);
      void run().then(resolve, async () => resolve(await reject("page_failed")));
      return task;
      async function run() {
        const receipt: CoverReceipt = {
          operationId: execution.operationId,
          executorId,
          requestDigest: await coverRequestDigest(execution.asset, expectedHash),
          effect: { cover: true, outcome: "not_dispatched" },
          ended: false,
        };
        entry.receipt = receipt;
        const acquired = await acquireDocument(document, existingEditor, execution.operationId);
        if (acquired.isErr()) {
          receipt.ended = true;
          receipt.result = { status: "error", error: acquired.error };
          return encodeServiceResult(coverWriteResultCodec, Result.ok(receipt));
        }
        await setArticleCover(document, candidate, expectedHash, guard, (observation) =>
          Object.assign(receipt, observation),
        );
        if (receipt.ended) await acquired.value();
        return encodeServiceResult(coverWriteResultCodec, Result.ok(receipt));
      }
    },
    save(execution: SaveExecution) {
      const reject = (code: import("@mpctl/contracts").Failure["code"]) =>
        encodeServiceResult(saveWriteResultCodec, Result.err({ code }));
      if (!v.safeParse(saveExecutionSchema, execution).success) return reject("invalid_operation");
      if (execution.executorId !== executorId) return reject("executor_mismatch");
      const signature = JSON.stringify([
        "save",
        execution.expectedBodyHash,
        execution.expectedFieldsHash,
        execution.expectedCoverHash,
      ]);
      const old = entries.get(execution.operationId);
      if (old)
        return old.signature === signature
          ? (old.task as ReturnType<typeof reject>)
          : reject("operation_conflict");
      let resolve!: (value: Awaited<ReturnType<typeof reject>>) => void;
      const task = new Promise<Awaited<ReturnType<typeof reject>>>((done) => {
        resolve = done;
      });
      const entry: { signature: string; task: typeof task; receipt?: SaveReceipt } = {
        signature,
        task,
      };
      entries.set(execution.operationId, entry);
      void run().then(resolve, async () => resolve(await reject("page_failed")));
      return task;
      async function run() {
        const receipt: SaveReceipt = {
          operationId: execution.operationId,
          executorId,
          requestDigest: await saveRequestDigest(execution),
          effect: { outcome: "not_dispatched", persistence: "unverified" },
          ended: false,
        };
        entry.receipt = receipt;
        const acquired = await acquireDocument(document, existingEditor, execution.operationId);
        if (acquired.isErr()) {
          receipt.ended = true;
          receipt.result = { status: "error", error: acquired.error };
          return encodeServiceResult(saveWriteResultCodec, Result.ok(receipt));
        }
        // The BG snapshot precedes this reservation. Recheck at the actual
        // document owner so intervening BODY/fields/cover edits cannot be saved.
        const editor = existingEditor?.();
        if (editor) {
          const contentWire = await Nexus.safeCall(editor.getContent());
          const content = contentWire.isOk()
            ? await (
                await import("../src/page-contracts")
              ).pageEditorContentResultCodec.deserialize(contentWire.value)
            : Result.err({ code: "page_failed" as const });
          const fields = readArticleFields(document);
          const image = await read();
          const bodyHash = content.isOk() ? await hashBody(content.value) : content;
          const fieldsHash = fields.isOk() ? await hashArticleFields(fields.value) : fields;
          if (
            bodyHash.isErr() ||
            fieldsHash.isErr() ||
            image.isErr() ||
            bodyHash.value !== execution.expectedBodyHash ||
            fieldsHash.value !== execution.expectedFieldsHash ||
            image.value !== execution.expectedCoverHash
          ) {
            receipt.ended = true;
            receipt.result = {
              status: "error",
              error: {
                code:
                  bodyHash.isErr() || fieldsHash.isErr() || image.isErr()
                    ? "page_failed"
                    : "content_conflict",
              },
            };
            await acquired.value();
            return encodeServiceResult(saveWriteResultCodec, Result.ok(receipt));
          }
        }
        await saveNativeArticle(document, guard, {
          publish: (observation) => Object.assign(receipt, observation),
        });
        if (receipt.ended) await acquired.value();
        return encodeServiceResult(saveWriteResultCodec, Result.ok(receipt));
      }
    },
  };
}

function reportStartupFailure(error: unknown): void {
  console.error("mpctl content startup failed", error);
}
