import { defineContentScript } from "wxt/utils/define-content-script";
import { Nexus, type NexusInstance } from "@nexus-js/core";
import { createContentScriptConfig, chromeTarget, type ChromeAdapterModel } from "@nexus-js/chrome";
import { injectMainWorldBridge, type PageBridgeAdapterModel } from "../src/transport/page-bridge";
import { Result } from "better-result";
import type { SerializedResult } from "better-result";
import { pageEditorReadyResultCodec, pageEditorToken } from "../src/page-contracts";
import {
  contentStatusToken,
  contentStatusResultCodec,
  homePageToken,
  homeIsReadyResultCodec,
  openDraftListResultCodec,
  openNewEditorResultCodec,
  listDraftsResultCodec,
  openDraftResultCodec,
  validateDraftResultCodec,
  currentItemCountResultCodec,
  hasUniqueCurrentItemResultCodec,
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
import {
  countVisibleAppmsgItems,
  hasUniqueObservedCurrentItem,
  listDraftGroups,
  openDraftGroup,
} from "../src/mp/drafts";

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
    chromeRuntime: NexusInstance<ChromeAdapterModel<{ editorReady: boolean }>>;
    pageState(): Promise<{
      state: "ready" | "not_logged_in" | "loading";
      route: string;
      documentReady: boolean;
    }>;
    validateTarget(): boolean;
    onDispose?(cleanup: () => void | Promise<void>): void;
  },
  editorToken: typeof pageEditorToken = pageEditorToken,
): Promise<import("better-result").Result<boolean, { code: string }>> {
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
  const editorResult = Result.try({
    try: () => pageConnection.get(editorToken),
    catch: () => ({ code: "page_failed" as const }),
  });
  if (Result.isError(editorResult)) {
    const disconnected = disconnectPageConnection(pageConnection);
    return Result.isError(disconnected) ? disconnected : editorResult;
  }
  const editor = editorResult.value;
  const assertUnchanged = () =>
    Result.try({
      try: () => {
        if (detectLoginTimeout(dependencies.document).state === "not_logged_in") return false;
        return dependencies.validateTarget();
      },
      catch: () => ({ code: "page_failed" }),
    }).andThen((valid) => (valid ? Result.ok() : Result.err({ code: "target_unavailable" })));
  const beforeReady = assertUnchanged();
  if (Result.isError(beforeReady)) {
    const disconnected = disconnectPageConnection(pageConnection);
    return Result.isError(disconnected) ? disconnected : beforeReady;
  }
  const readyWire = await Result.tryPromise({
    try: async () => await editor.ready(),
    catch: () => ({ code: "page_failed" }),
  });
  if (Result.isError(readyWire)) {
    const disconnected = disconnectPageConnection(pageConnection);
    return Result.isError(disconnected) ? disconnected : readyWire;
  }
  const ready = await pageEditorReadyResultCodec.deserialize(readyWire.value);
  if (Result.isError(ready)) {
    const disconnected = disconnectPageConnection(pageConnection);
    return Result.isError(disconnected) ? disconnected : ready;
  }
  const afterReady = assertUnchanged();
  if (Result.isError(afterReady)) {
    const disconnected = disconnectPageConnection(pageConnection);
    return Result.isError(disconnected) ? disconnected : afterReady;
  }
  if (!ready.value.isReady || !ready.value.isNew) {
    const disconnected = disconnectPageConnection(pageConnection);
    return Result.isError(disconnected) ? disconnected : Result.err({ code: "unsupported_editor" });
  }
  const finalStatus = await Result.tryPromise({
    try: () => dependencies.pageState(),
    catch: () => ({ code: "page_failed" }),
  });
  if (Result.isError(finalStatus)) {
    const disconnected = disconnectPageConnection(pageConnection);
    return Result.isError(disconnected) ? disconnected : finalStatus;
  }
  if (finalStatus.value.state === "not_logged_in") {
    const disconnected = disconnectPageConnection(pageConnection);
    return Result.isError(disconnected) ? disconnected : Result.err({ code: "not_logged_in" });
  }
  if (finalStatus.value.state !== "ready") {
    const disconnected = disconnectPageConnection(pageConnection);
    return Result.isError(disconnected) ? disconnected : Result.err({ code: "editor_not_ready" });
  }
  const relayCreated = Result.try({
    try: () =>
      Nexus.relay({
        from: dependencies.chromeRuntime,
        to: { nexus: dependencies.pageRuntime, target: {} },
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
  const registration = Result.try({
    try: () =>
      dependencies.onDispose?.(async () => {
        const result = await disposeRelay(relay);
        if (Result.isError(result)) reportStartupFailure(result.error);
      }),
    catch: () => ({ code: "page_failed" as const }),
  });
  if (Result.isError(registration)) {
    const relayDisposed = disposeRelay(relay);
    const disconnected = disconnectPageConnection(pageConnection);
    if (Result.isError(relayDisposed)) reportStartupFailure(relayDisposed.error);
    if (Result.isError(disconnected)) reportStartupFailure(disconnected.error);
    return registration;
  }
  const identity = await Result.tryPromise({
    try: () => dependencies.chromeRuntime.updateIdentity({ app: { editorReady: true } }),
    catch: () => ({ code: "page_failed" }),
  });
  if (Result.isError(identity)) {
    const relayDisposed = disposeRelay(relay);
    const disconnected = disconnectPageConnection(pageConnection);
    if (Result.isError(relayDisposed)) reportStartupFailure(relayDisposed.error);
    if (Result.isError(disconnected)) reportStartupFailure(disconnected.error);
    return identity;
  }
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

  if (options.route.kind === "home") {
    const registered = registerInvalidation(options.ctx, async () =>
      stopWatching(options.stopWatchingLogin),
    );
    if (Result.isError(registered)) {
      const cleaned = stopWatching(options.stopWatchingLogin);
      return Result.isError(cleaned) ? cleaned : Result.err({ code: "setup_failed" });
    }
    return Result.ok();
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
    if (decision.value === "not_logged_in") {
      const registered = registerInvalidation(options.ctx, async () =>
        stopWatching(options.stopWatchingLogin),
      );
      if (Result.isError(registered)) {
        const cleaned = stopWatching(options.stopWatchingLogin);
        return Result.isError(cleaned) ? cleaned : Result.err({ code: "setup_failed" });
      }
      return Result.ok();
    }
    if (decision.value !== "ready") {
      const cleanup = stopWatching(options.stopWatchingLogin);
      return Result.isError(cleanup) ? cleanup : Result.err({ code: "setup_failed" });
    }
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

  const result = await options.prepareEditor();
  if (Result.isError(result)) {
    const cleanup = await cleanupStartupResources(options);
    if (Result.isError(cleanup)) return Result.err(cleanup.error);
    return Result.err({ code: "setup_failed" });
  }
  const registered = registerInvalidation(options.ctx, () => cleanupStartupResources(options));
  if (Result.isError(registered)) {
    const cleanup = await cleanupStartupResources(options);
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

async function disposeBridge(
  bridge: import("../src/transport/page-bridge").IsolatedPageBridge,
): Promise<import("../src/transport/page-bridge").BridgeCleanupResult> {
  return bridge.dispose();
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
    async openDraft(candidate: string) {
      const result = !isCurrentDraftList()
        ? Result.err({ code: "route_changed" as const })
        : openDraftGroup(document, candidate, () => {
            const current = listDraftGroups(document);
            if (!isCurrentDraftList()) return false;
            if (current.filter((item) => item.groupId === candidate).length !== 1) return false;
            if (detectLoginTimeout(document).state === "not_logged_in") return false;
            return true;
          });
      return encodeServiceResult(openDraftResultCodec, result);
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
    async hasUniqueCurrentItem() {
      return encodeServiceResult(
        hasUniqueCurrentItemResultCodec,
        Result.try({
          try: () => hasUniqueObservedCurrentItem(document),
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
    async openNewEditor() {
      const found = Result.try({
        try: () => uniqueControl("div.new-creation__menu-item", isArticleItem),
        catch: () => ({ code: "page_failed" as const }),
      });
      const result = Result.isError(found)
        ? found
        : found.value
          ? Result.try({
              try: () => {
                found.value?.click();
                return true;
              },
              catch: () => ({ code: "page_failed" as const }),
            })
          : Result.err({ code: "control_unavailable" as const });
      return encodeServiceResult(openNewEditorResultCodec, result);
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
    const route = classifyAppmsgUrl(location.href);
    const routeIdentity = appmsgRouteIdentity(location.href) ?? "unsupported";
    let loginTimeout = detectLoginTimeout(document).state === "not_logged_in";
    const isOriginalEditor = createEditorTargetValidator(document);
    const validateTarget = () => !loginTimeout && isOriginalEditor();
    const chromeRuntime = new Nexus<ChromeAdapterModel<{ editorReady: boolean }>>();
    chromeRuntime.configure({
      ...createContentScriptConfig<{ editorReady: boolean }>({ app: { editorReady: false } }),
      policy: {
        canCall({ serviceName }) {
          return serviceName !== pageEditorToken.id || validateTarget();
        },
      },
    });
    const runtimeReady = await Result.tryPromise({
      try: async () => chromeRuntime.ready(),
      catch: () => ({ code: "setup_failed" as const }),
    });
    if (Result.isError(runtimeReady)) {
      reportStartupFailure(runtimeReady.error);
      return;
    }
    chromeRuntime.provide(draftPageToken, createDraftPageService(document));
    chromeRuntime.provide(homePageToken, createHomePageService(document));
    let editorServiceReady = false;
    const stopWatchingLogin = observeLoginTimeout(document, (state) => {
      loginTimeout = state === "not_logged_in";
    });
    chromeRuntime.provide(contentStatusToken, {
      async status() {
        const outcome = Result.try({
          try: () => {
            const domReady = document.readyState !== "loading";
            const currentLoginTimeout = detectLoginTimeout(document).state === "not_logged_in";
            if (currentLoginTimeout) loginTimeout = true;
            const hasObservedDraftCard =
              route.kind === "draft-list" &&
              [...document.querySelectorAll<HTMLElement>(".weui-desktop-card[data-appid]")].some(
                (card) => card.isConnected,
              );
            let state: "ready" | "not_logged_in" | "loading";
            if (currentLoginTimeout || loginTimeout) state = "not_logged_in";
            else if (route.kind === "home" && domReady) state = "ready";
            else if (route.kind === "draft-list" && domReady && hasObservedDraftCard)
              state = "ready";
            else if (editorServiceReady) state = "ready";
            else state = "loading";
            return { state, route: routeIdentity, documentReady: domReady };
          },
          catch: () => ({ code: "page_failed" as const }),
        });
        return encodeServiceResult(contentStatusResultCodec, outcome);
      },
    });
    let pageRuntime: Nexus<PageBridgeAdapterModel> | undefined;
    let bridge: import("../src/transport/page-bridge").IsolatedPageBridge | undefined;
    const cleanupEditorBootstrap = async (): Promise<
      import("../src/transport/page-bridge").BridgeCleanupResult
    > => {
      const disposed = bridge ? await disposeBridge(bridge) : Result.ok();
      return disposed;
    };
    const backgroundConnected = await Result.tryPromise({
      try: async () => chromeRuntime.connect({ target: chromeTarget.background(), timeout: 2_000 }),
      catch: () => ({ code: "setup_failed" as const }),
    });
    if (Result.isError(backgroundConnected)) {
      const cleanup = await cleanupStartupResources({
        stopWatchingLogin,
        cleanupEditor: cleanupEditorBootstrap,
      });
      if (Result.isError(cleanup)) reportStartupFailure(cleanup.error);
      reportStartupFailure(backgroundConnected.error);
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
          pageRuntime.configure({ endpoint: { implementation: endpoint, meta: {} } });
          await pageRuntime.ready();
        });
        if (Result.isError(bridgeResult)) return Result.err({ code: "setup_failed" as const });
        bridge = bridgeResult.value;
        if (!pageRuntime) return Result.err({ code: "setup_failed" as const });
        const initialized = await initializeContentServices({
          document,
          pageRuntime,
          chromeRuntime,
          onDispose: (cleanup) => ctx.onInvalidated(cleanup),
          async pageState() {
            return {
              state: loginTimeout ? "not_logged_in" : "ready",
              route: routeIdentity,
              documentReady: document.readyState !== "loading",
            };
          },
          validateTarget,
        });
        if (Result.isError(initialized)) return initialized;
        return initialized.value ? Result.ok() : Result.err({ code: "setup_failed" as const });
      },
    });
    if (Result.isError(startup)) {
      reportStartupFailure(startup.error);
      return;
    }
    editorServiceReady = route.kind === "new" || route.kind === "saved-editor";
  },
});

function reportStartupFailure(error: unknown): void {
  console.error("mpctl content startup failed", error);
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    style?.display !== "none" &&
    style?.visibility !== "hidden" &&
    element.getClientRects().length > 0
  );
}
