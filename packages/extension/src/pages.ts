import { chromeTarget } from "@nexus-js/chrome";
import { Nexus, NexusError, type Connection, type RemoteValue } from "@nexus-js/core";
import { Result, type Result as BetterResult } from "better-result";
import { assetUploadTimeouts, type ArticleNavigationStage } from "@mpctl/contracts";
import { backgroundNexus, hasPreparationVersion } from "./background-runtime";

import {
  pageEditorToken,
  pageEditorReadyResultCodec,
  pageEditorContentResultCodec,
  pageEditorWriteResultCodec,
  assetImagePageResultCodec,
  type PageEditorService,
} from "./page-contracts";
import { pageEditorReceiptResultCodec, type BodyReceipt } from "./page-contracts";
import type { OperationTarget } from "./operations";
import type { Failure } from "@mpctl/contracts";
import {
  contentStatusToken,
  draftPageToken,
  homePageToken,
  articleFieldsToken,
  articleFieldUpdateResultCodec,
  fieldsIdentityResultCodec,
  fieldsReceiptResultCodec,
  type FieldsReceipt,
  type FieldsExecution,
  materialPageToken,
  materialListResultCodec,
  materialUploadResultCodec,
  materialIdentityResultCodec,
  uploadReceiptResultCodec,
  type UploadReceipt,
  articleCoverPageToken,
  coverWriteResultCodec,
  saveWriteResultCodec,
  coverReceiptResultCodec,
  saveReceiptResultCodec,
  type CoverExecution,
  type BodyCoverExecution,
  type SaveExecution,
  type CoverReceipt,
  type SaveReceipt,
  articleCoverHashResultCodec,
} from "./background-contracts";
import {
  contentStatusResultCodec,
  currentItemCountResultCodec,
  homeIsReadyResultCodec,
  listDraftsResultCodec,
  openDraftListResultCodec,
  validateDraftResultCodec,
  articleFieldsResultCodec,
} from "./background-contracts";

import {
  appmsgRouteIdentity,
  classifyAppmsgUrl,
  isEditorPageUrl,
  isHomePageUrl,
} from "./mp/routes";
export {
  appmsgRouteIdentity,
  classifyAppmsgUrl,
  draftListUrl,
  editorPageUrl,
  isDraftListUrl,
  isEditorPageUrl,
  isHomePageUrl,
  type AppmsgRoute,
} from "./mp/routes";

function isPublicRootUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === "https://mp.weixin.qq.com" && url.pathname === "/";
  } catch {
    return false;
  }
}

function isSavedEditorForGroup(url: string, groupId: string): boolean {
  const route = classifyAppmsgUrl(url);
  return route.kind === "saved-editor" && route.groupId === groupId;
}

function hasReadyEditor(identity: unknown): boolean {
  if (typeof identity !== "object" || identity === null || !("app" in identity)) return false;
  const app = identity.app;
  return (
    typeof app === "object" && app !== null && "editorReady" in app && app.editorReady === true
  );
}

function hasExpiredLogin(identity: unknown): boolean {
  if (typeof identity !== "object" || identity === null || !("app" in identity)) return false;
  const app = identity.app;
  return (
    typeof app === "object" && app !== null && "loginExpired" in app && app.loginExpired === true
  );
}

import { captureNativeNewEditorUrl, captureNativeDraftEditorUrl } from "./native-editor-target";
export { captureNativeNewEditorUrl, captureNativeDraftEditorUrl } from "./native-editor-target";
export type { NativeTargetCapture } from "./native-editor-target";

type PageReplyError = { code: string } & Partial<
  Pick<import("@mpctl/contracts").WorkspaceError, "readFailure">
> & { cleanupFailed?: boolean; ended?: boolean; failure?: Failure };

function callPage<T>(lazy: RemoteValue<T>, onInvoke?: () => void) {
  if (!hasPreparationVersion(lazy.connection.contextMeta)) throw new PageAdmissionError();
  onInvoke?.();
  return Nexus.safeCall(lazy);
}

async function decodeRemote<T>(
  codec: { deserialize(value: unknown): Promise<BetterResult<T, PageReplyError>> },
  operation: () => RemoteValue<unknown>,
  component?: import("@mpctl/contracts").ReadFailure["component"],
  onInvoke?: () => void,
): Promise<PageManagerResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stage: import("@mpctl/contracts").ReadFailure["stage"] = "page_acquire";
  const invoked = Result.tryPromise({
    try: async () => {
      const lazy = operation();
      if (!hasPreparationVersion(lazy.connection.contextMeta))
        return pageErr({
          code: "page_failed",
          observedFailure: { kind: "protocol", causeCode: "version_mismatch" },
          ...(component
            ? {
                readFailure: {
                  stage: "page_connect" as const,
                  kind: "protocol" as const,
                  causeCode: "version_mismatch",
                  component,
                },
              }
            : {}),
        });
      stage = "page_call";
      const result = await callPage(lazy, onInvoke);
      stage = "page_decode";
      return Result.isError(result)
        ? pageErr({
            code: "page_failed",
            observedFailure: observedFailure(result.error),
            ...(component
              ? {
                  readFailure: {
                    stage: "page_call" as const,
                    ...observedFailure(result.error),
                    component,
                  },
                }
              : {}),
          })
        : decodePageReply(codec, result.value, component);
    },
    catch: (error) => ({
      code: "page_failed" as const,
      observedFailure: observedFailure(error),
      ...(component
        ? {
            readFailure: {
              stage:
                error instanceof NexusError && error.code === "E_SERVICE_UNAVAILABLE"
                  ? ("page_acquire" as const)
                  : ("page_call" as const),
              ...observedFailure(error),
              component,
            },
          }
        : {}),
    }),
  });
  try {
    return await Promise.race([
      invoked.then((result) => (Result.isError(result) ? pageErr<T>(result.error) : result.value)),
      new Promise<PageManagerResult<T>>((resolve) => {
        timer = setTimeout(
          () =>
            resolve(
              pageErr({
                code: "page_failed",
                observedFailure: { kind: "nexus", causeCode: "E_CALL_TIMEOUT" },
                ...(component
                  ? {
                      readFailure: { stage, kind: "nexus", causeCode: "E_CALL_TIMEOUT", component },
                    }
                  : {}),
              }),
            ),
          4_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function mutationReply<T>(
  codec: { deserialize(value: unknown): Promise<BetterResult<T, Failure>> },
  operation: () => RemoteValue<unknown>,
  timeoutMs = 4_000,
): Promise<BetterResult<T, MaterialCallFailure>> {
  let invoked = false;
  let at: NonNullable<Failure["cause"]>["at"] = "bg.page_acquire";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const boundary = (error: unknown): MaterialCallFailure => ({
    ...materialBoundaryFailure(error, at),
    ...(!invoked ? { notInvoked: true } : {}),
  });
  const call = async (): Promise<BetterResult<T, MaterialCallFailure>> => {
    try {
      const lazy = operation();
      at = "bg.page_call";
      const response = await callPage(lazy, () => {
        invoked = true;
      });
      if (response.isErr()) return Result.err(boundary(response.error));
      at = "bg.page_decode";
      try {
        const decoded = await codec.deserialize(response.value);
        return decoded.isErr() && decoded.error.code === "invalid_result_envelope"
          ? Result.err({
              code: "invalid_result_envelope",
              cause: { at, kind: "protocol", code: "invalid_result_envelope" },
            })
          : decoded;
      } catch {
        return Result.err({
          code: "invalid_result_envelope",
          cause: { at, kind: "protocol", code: "invalid_result_envelope" },
        });
      }
    } catch (error) {
      return Result.err(boundary(error));
    }
  };
  try {
    return await Promise.race([
      call(),
      new Promise<BetterResult<T, MaterialCallFailure>>((resolve) => {
        timer = setTimeout(
          () =>
            resolve(Result.err(boundary(new NexusError("Page reply timeout", "E_CALL_TIMEOUT")))),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function decodePageReply<T>(
  codec: {
    deserialize(value: unknown): Promise<BetterResult<T, PageReplyError>>;
  },
  wire: unknown,
  component?: import("@mpctl/contracts").ReadFailure["component"],
): Promise<PageManagerResult<T>> {
  const decoding = await Result.tryPromise({
    try: () => codec.deserialize(wire),
    catch: () => ({
      code: "invalid_result_envelope" as const,
      observedFailure: observedFailure(undefined, true),
      ...(component
        ? {
            readFailure: {
              stage: "page_decode" as const,
              kind: "protocol" as const,
              causeCode: "invalid_result_envelope",
              component,
            },
          }
        : {}),
    }),
  });
  if (Result.isError(decoding)) return pageErr(decoding.error);
  const decoded = decoding.value;
  if (Result.isError(decoded)) {
    const facts = {
      ...(decoded.error.readFailure ? { readFailure: decoded.error.readFailure } : {}),
      ...(decoded.error.cleanupFailed ? { cleanupFailed: true as const } : {}),
      ...(decoded.error.ended !== undefined ? { ended: decoded.error.ended } : {}),
      ...(decoded.error.failure ? { failure: decoded.error.failure } : {}),
      observedFailure: decoded.error.readFailure
        ? { kind: decoded.error.readFailure.kind, causeCode: decoded.error.readFailure.causeCode }
        : { kind: "domain" as const, causeCode: decoded.error.code },
    };
    if (decoded.error.code === "invalid_result_envelope")
      return pageErr({
        code: "invalid_result_envelope",
        observedFailure: observedFailure(undefined, true),
        ...(component
          ? {
              readFailure: {
                stage: "page_decode" as const,
                kind: "protocol" as const,
                causeCode: "invalid_result_envelope",
                component,
              },
            }
          : {}),
      });
    if (decoded.error.code === "route_changed" || decoded.error.code === "target_unavailable")
      return pageErr({ code: "target_unavailable", ...facts });
    if (decoded.error.code === "not_logged_in") return pageErr({ code: "not_logged_in", ...facts });
    if (decoded.error.code === "content_conflict" || decoded.error.code === "invalid_fields")
      return pageErr({ code: decoded.error.code, ...facts });
    if (
      decoded.error.code === "cover_unavailable" ||
      decoded.error.code === "cover_input_unavailable" ||
      decoded.error.code === "cover_update_unknown" ||
      decoded.error.code === "hash_failed" ||
      decoded.error.code === "unsupported"
    )
      return pageErr({
        code: decoded.error.code,
        ...facts,
        ...("baselineHash" in decoded.error && typeof decoded.error.baselineHash === "string"
          ? { baselineHash: decoded.error.baselineHash }
          : {}),
      });
    return pageErr({
      code: "page_failed",
      ...facts,
    });
  }
  return pageOk(decoded.value);
}

export type PageBinding = {
  tabId: number;
  documentId: string;
  url: string;
  routeRevision?: number;
};
type ObservedBoundaryFailure = {
  kind: "domain" | "runtime" | "nexus" | "protocol";
  causeCode: string;
};
type PageManagerErrorDetails =
  | { code: "page_failed" }
  | { code: "target_unavailable" }
  | { code: "target_ambiguous" }
  | { code: "not_logged_in" }
  | { code: "invalid_result_envelope" }
  | { code: "missing_group"; groupId: number }
  | { code: "navigation_failed"; stage: ArticleNavigationStage }
  | { code: "content_conflict" | "invalid_fields" }
  | ({
      code:
        | "asset_upload_unknown"
        | "asset_list_failed"
        | "asset_ambiguous"
        | "invalid_asset"
        | "asset_too_large"
        | "cleanup_failed"
        | "dialog_unavailable"
        | "library_open_unknown"
        | "invalid_payload";
    } & { cleanupFailed?: true })
  | ({
      code:
        | "cover_unavailable"
        | "cover_input_unavailable"
        | "cover_update_unknown"
        | "hash_failed";
      baselineHash?: string;
    } & { cleanupFailed?: true })
  | { code: "unsupported" };
export type PageManagerError = PageManagerErrorDetails & {
  pageCreated?: boolean;
  cleanupFailed?: true;
  ended?: boolean;
  failure?: Failure;
  baselineHash?: string;
  readFailure?: import("@mpctl/contracts").ReadFailure;
  observedFailure?: ObservedBoundaryFailure;
};
export type PageManagerResult<T> = BetterResult<T, PageManagerError>;
// Local invocation knowledge, never a provider receipt or a public failure envelope.
type MaterialCallFailure = Failure & { notInvoked?: true };

function materialBoundaryFailure(error: unknown, at: NonNullable<Failure["cause"]>["at"]): Failure {
  const page =
    typeof error === "object" && error !== null && "code" in error
      ? (error as {
          code: string;
          observedFailure?: ObservedBoundaryFailure;
          readFailure?: import("@mpctl/contracts").ReadFailure;
        })
      : undefined;
  const cause =
    page?.observedFailure ??
    (page?.readFailure
      ? { kind: page.readFailure.kind, causeCode: page.readFailure.causeCode }
      : undefined) ??
    (error instanceof Error || !page
      ? observedFailure(error)
      : { kind: "domain" as const, causeCode: page.code });
  const code =
    page?.code === "target_unavailable" ||
    page?.code === "target_ambiguous" ||
    page?.code === "not_logged_in" ||
    page?.code === "page_failed"
      ? page.code
      : "receipt_unreachable";
  return { code, cause: { at, kind: cause.kind, code: cause.causeCode } };
}

const pageOk = <T>(value: T): PageManagerResult<T> => Result.ok(value);
const pageErr = <T = never>(error: PageManagerError, pageCreated = false): PageManagerResult<T> =>
  Result.err({ ...error, ...(pageCreated ? { pageCreated: true } : {}) });

function observedFailure(error: unknown, protocol = false): ObservedBoundaryFailure {
  if (error instanceof PageAdmissionError)
    return { kind: "protocol", causeCode: "version_mismatch" };
  return {
    kind: protocol ? "protocol" : error instanceof NexusError ? "nexus" : "runtime",
    causeCode: protocol
      ? "invalid_result_envelope"
      : error instanceof NexusError
        ? error.code
        : "unexpected_exception",
  };
}

const navigationErr = <T = never>(
  stage: ArticleNavigationStage,
  pageCreated = false,
): PageManagerResult<T> => pageErr({ code: "navigation_failed", stage }, pageCreated);

const chromeResult = <T>(operation: () => Promise<T>): Promise<PageManagerResult<T>> =>
  Result.tryPromise({
    try: operation,
    catch: (error) =>
      isExactMissingGroupError(error)
        ? { code: "missing_group" as const, groupId: missingGroupId(error) }
        : { code: "page_failed" as const, observedFailure: observedFailure(error) },
  });

export function restorePagesOnStartup(
  restore: () => Promise<unknown>,
  onStartup: (listener: () => void) => void,
): void {
  const run = () => {
    void restore().catch(() => undefined);
  };
  run();
  onStartup(run);
}

type PageEditorServiceRemote = import("@nexus-js/core").Remote<PageEditorService>;

type BrowserTab = { id?: number; url?: string };
export type NavigationProgress = {
  dispatch<T>(code: string, action: () => Promise<T>): Promise<T>;
  created(role: "home" | "draft-list" | "editor", tabId?: number): Promise<void>;
  bound(binding: PageBinding): Promise<void>;
  uncertain(code: string): void;
  sourceReady(binding?: PageBinding): void;
  reloading?(binding: {
    tabId: number;
    documentId?: string;
    url: string;
  }): (completed: PageBinding) => void;
  placed?(): Promise<void>;
  dialogEnded?(): void;
  materialInvoked?(): void;
  tabRemoved?(tabId: number): void;
  failed?(error: {
    code: string;
    stage?: ArticleNavigationStage;
    observedFailure?: ObservedBoundaryFailure;
    readFailure?: import("@mpctl/contracts").ReadFailure;
    ended?: boolean;
    failure?: Failure;
    cleanupFailed?: true;
  }): void;
};
type SavedEditorTarget = {
  tabId: number;
  url: string;
  previousDocumentId?: string;
  changed?: true;
  firstDocumentId?: string;
  firstRouteRevision?: number;
  firstUrl?: string;
};
function managedPageIdentity(url: string | undefined): string | undefined {
  if (isPublicRootUrl(url)) return "home";
  const route = classifyAppmsgUrl(url);
  if (route.kind === "unsupported") return undefined;
  return route.kind === "saved-editor" ? `saved-editor:${route.groupId}` : route.kind;
}

type PageChrome = {
  getGroup(id: number): Promise<unknown>;
  queryGroups?(): Promise<Array<{ id: number; title?: string; windowId?: number }>>;
  createTab(options: { url: string; active: boolean }): Promise<BrowserTab>;
  executeMain?(details: {
    tabId: number;
    func: (...args: string[]) => unknown;
    args?: string[];
  }): Promise<unknown[]>;
  groupTabs(tabIds: number, groupId?: number): Promise<number>;
  updateGroup(id: number, options: { title: string }): Promise<void>;
  queryGroup(groupId: number): Promise<BrowserTab[]>;
  queryMpTabs?(): Promise<BrowserTab[]>;
  queryAllTabs?(): Promise<BrowserTab[]>;
  getTab(id: number): Promise<BrowserTab>;
  reloadTab?(id: number): Promise<void>;
  updateTab?(id: number, options: { url: string }): Promise<void>;
  moveTab?(id: number, windowId: number): Promise<void>;
  getLocal?(key: string): Promise<Record<string, unknown>>;
  setLocal?(values: Record<string, unknown>): Promise<void>;
  getSession(key?: string | null): Promise<Record<string, unknown>>;
  setSession(values: Record<string, unknown>): Promise<void>;
  onTabUpdated?(listener: (tabId: number, status: "loading" | "complete") => void): void;
  onTabRemoved?(listener: (tabId: number) => void): void;
  getFrame?(details: {
    tabId: number;
    frameId: number;
  }): Promise<{ documentId?: string; url?: string } | null>;
  onBeforeNavigate?(listener: (details: { tabId: number; frameId: number }) => void): void;
  onCommitted?(
    listener: (details: { tabId: number; frameId: number; documentId: string }) => void,
  ): void;
};

const chromePageApi: PageChrome = {
  getGroup: (id) => chrome.tabGroups.get(id),
  queryGroups: () => chrome.tabGroups.query({ title: "mpctl" }),
  createTab: (options) => chrome.tabs.create(options),
  executeMain: async ({ tabId, func, args }) =>
    chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args }),
  groupTabs: (tabIds, groupId) =>
    chrome.tabs.group({ tabIds, ...(groupId === undefined ? {} : { groupId }) }),
  updateGroup: async (id, options) => {
    await chrome.tabGroups.update(id, options);
  },
  queryGroup: (groupId) => chrome.tabs.query({ groupId }),
  queryMpTabs: () => chrome.tabs.query({ url: "https://mp.weixin.qq.com/*" }),
  queryAllTabs: () => chrome.tabs.query({}),
  getTab: (id) => chrome.tabs.get(id),
  reloadTab: (id) => chrome.tabs.reload(id),
  updateTab: async (id, options) => {
    await chrome.tabs.update(id, options);
  },
  moveTab: async (id, windowId) => {
    await chrome.tabs.move(id, { windowId, index: -1 });
  },
  getLocal: (key) => chrome.storage.local.get(key),
  setLocal: async (values) => {
    await chrome.storage.local.set(values);
  },
  getSession: (key) => chrome.storage.session.get(key ?? null),
  setSession: async (values) => {
    await chrome.storage.session.set(values);
  },
  onTabUpdated: (listener) =>
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (info.status === "loading" || info.status === "complete") listener(tabId, info.status);
    }),
  onTabRemoved: (listener) => chrome.tabs.onRemoved.addListener(listener),
  getFrame: (details) => chrome.webNavigation.getFrame(details),
  onBeforeNavigate: (listener) =>
    chrome.webNavigation.onBeforeNavigate.addListener((details) => listener(details)),
  onCommitted: (listener) =>
    chrome.webNavigation.onCommitted.addListener((details) => listener(details)),
};

export function createPageManager(
  api: PageChrome = chromePageApi,
  connectPage?: (binding: PageBinding) => Promise<PageEditorServiceRemote>,
  readPageStatus?: (binding: PageBinding) => Promise<{
    state: "ready" | "not_logged_in" | "loading";
    route: string;
    documentReady: boolean;
  }>,
  readDraftGroups?: (binding: PageBinding) => Promise<Array<{ candidate: string; title: string }>>,
  connectStatus: (binding: PageBinding) => Promise<Connection> = connectChromeStatus,
) {
  let groupId: number | undefined;
  let resolvingGroup: Promise<PageManagerResult<number>> | undefined;
  let ensuringDraftList: Promise<PageManagerResult<PageBinding>> | undefined;
  let refreshingDraftList: Promise<PageManagerResult<PageBinding>> | undefined;
  let acquiringHome: Promise<PageManagerResult<PageBinding>> | undefined;
  let acquiringHomeTabId: number | undefined;
  let restoring: Promise<PageManagerResult<void>> | undefined;
  let groupRevision = 0;
  let recoveryCandidate: { id: number; updated: boolean; saved: boolean } | undefined;
  let savedGroupHint: number | undefined;
  let sessionGroupReadRequired = Boolean(api.getLocal);
  const documents = new Map<number, PageBinding>();
  const invalidated = new Set<string>();
  const navigationPending = new Map<number, number>();
  const navigationStartDocument = new Map<number, string | undefined>();
  const navigationCommit = new Map<number, { navigationId: number; documentId: string }>();
  const frameChecks = new Map<number, number>();
  const frameCheckPending = new Set<number>();
  const frameCheckErrors = new Map<number, { documentId: string; error: PageManagerError }>();
  // Only live BODY acquisition waits subscribe to document invalidation. DOM
  // services do not share this readiness requirement or own these resources.
  const editorWaits = new Set<() => void>();
  const checkEditorWaits = () => {
    for (const check of editorWaits) check();
  };
  const ownsCurrentDocument = (binding: PageBinding): boolean => {
    const current = documents.get(binding.tabId);
    return Boolean(
      current &&
      current.documentId === binding.documentId &&
      (current.routeRevision ?? 0) === (binding.routeRevision ?? 0) &&
      !invalidated.has(`${binding.tabId}:${binding.documentId}`) &&
      !navigationPending.has(binding.tabId) &&
      !frameCheckPending.has(binding.tabId),
    );
  };
  const waitForEditor = (
    connection: Connection,
    binding: PageBinding,
    deadline: number,
  ): Promise<PageManagerResult<void>> =>
    new Promise((resolve) => {
      let settled = false;
      let checking = false;
      const cleanup: Array<() => void> = [];
      const finish = (result: PageManagerResult<void>) => {
        if (settled) return;
        settled = true;
        for (const stop of cleanup.splice(0)) stop();
        resolve(result);
      };
      const guard = (): PageManagerResult<void> => {
        if (!ownsCurrentDocument(binding)) return pageErr({ code: "target_unavailable" });
        if (connection.status !== "connected")
          return pageErr({
            code: "page_failed",
            readFailure: {
              stage: "page_acquire",
              kind: "nexus",
              causeCode: "E_CONN_CLOSED",
              component: "body",
            },
          });
        if (!hasPreparationVersion(connection.contextMeta))
          return pageErr({
            code: "page_failed",
            readFailure: {
              stage: "page_acquire",
              kind: "protocol",
              causeCode: "version_mismatch",
              component: "body",
            },
          });
        return pageOk(undefined);
      };
      const check = () => {
        if (settled) return;
        const valid = guard();
        if (valid.isErr()) {
          finish(valid);
          return;
        }
        if (checking) return;
        checking = true;
        void manager.isCurrent(binding).then(
          (current) => {
            checking = false;
            if (settled) return;
            const stillValid = guard();
            if (stillValid.isErr()) {
              finish(stillValid);
              return;
            }
            if (current.isErr()) {
              finish(pageErr(current.error));
              return;
            }
            if (!current.value) {
              finish(pageErr({ code: "target_unavailable" }));
              return;
            }
            if (Date.now() >= deadline) return timeout();
            if (hasExpiredLogin(connection.contextMeta)) finish(pageErr({ code: "not_logged_in" }));
            else if (hasReadyEditor(connection.contextMeta)) finish(pageOk(undefined));
          },
          (error) =>
            finish(
              pageErr({
                code: "page_failed",
                readFailure: {
                  stage: "page_acquire",
                  ...observedFailure(error),
                  component: "body",
                },
              }),
            ),
        );
      };
      editorWaits.add(check);
      cleanup.push(() => editorWaits.delete(check));
      const timeout = () => {
        if (settled) return;
        const valid = guard();
        finish(
          valid.isErr()
            ? valid
            : pageErr({
                code: "page_failed",
                readFailure: {
                  stage: "page_acquire",
                  kind: "runtime",
                  causeCode: "editor_bootstrap_timeout",
                  component: "body",
                },
              }),
        );
      };
      // Reserve the final second of the existing budget for a single content
      // observation. DOM readiness is independent of MAIN, so login can change
      // without an editor identity event. Neither this call nor a stuck reply
      // may extend the BODY deadline or reconnect to a different session.
      const observeLogin = async () => {
        if (settled) return;
        const valid = guard();
        if (valid.isErr()) return finish(valid);
        const current = await manager.isCurrent(binding);
        if (settled) return;
        const stillValid = guard();
        if (stillValid.isErr()) return finish(stillValid);
        if (current.isErr()) return finish(pageErr(current.error));
        if (!current.value) return finish(pageErr({ code: "target_unavailable" }));
        if (Date.now() >= deadline) return timeout();
        if (hasExpiredLogin(connection.contextMeta))
          return finish(pageErr({ code: "not_logged_in" }));
        if (hasReadyEditor(connection.contextMeta)) return finish(pageOk(undefined));
        const remaining = deadline - Date.now();
        if (remaining <= 0) return timeout();
        const status = connection.safeGet(contentStatusToken, { callTimeout: remaining });
        if (status.isErr()) return;
        const invoked = await callPage(status.value.status());
        if (settled) return;
        const afterCall = guard();
        if (afterCall.isErr()) return finish(afterCall);
        if (invoked.isErr()) return;
        const result = await decodePageReply(contentStatusResultCodec, invoked.value);
        if (settled) return;
        const afterStatus = await manager.isCurrent(binding);
        if (settled) return;
        const afterObservation = guard();
        if (afterObservation.isErr()) return finish(afterObservation);
        if (afterStatus.isErr()) return finish(pageErr(afterStatus.error));
        if (!afterStatus.value) return finish(pageErr({ code: "target_unavailable" }));
        if (Date.now() >= deadline) return timeout();
        if (hasExpiredLogin(connection.contextMeta))
          return finish(pageErr({ code: "not_logged_in" }));
        if (hasReadyEditor(connection.contextMeta)) return finish(pageOk(undefined));
        if (
          result.isOk() &&
          result.value.route === appmsgRouteIdentity(binding.url) &&
          result.value.state === "not_logged_in"
        )
          finish(pageErr({ code: "not_logged_in" }));
      };
      const timer = setTimeout(timeout, Math.max(0, deadline - Date.now()));
      cleanup.push(() => clearTimeout(timer));
      const statusTimer = setTimeout(
        () => void observeLogin().catch(timeout),
        Math.max(0, deadline - Date.now() - 1_000),
      );
      cleanup.push(() => clearTimeout(statusTimer));
      const retain = (stop: () => void) => {
        if (settled) stop();
        else cleanup.push(stop);
      };
      retain(connection.onDisconnected(check));
      retain(connection.subscribeIdentity(check));
      check();
    });
  const savedOpenTargets = new Set<SavedEditorTarget>();
  const navigationObservers = new Set<NavigationProgress>();
  const nativeCaptureQueues = new Map<number, Promise<void>>();
  function decodeNativeCapture(results: unknown[]) {
    const entry = results[0];
    const capture =
      entry && typeof entry === "object" && "result" in entry ? entry.result : undefined;
    if (!capture || typeof capture !== "object") return undefined;
    const hasKind = "kind" in capture;
    const kind = hasKind ? capture.kind : undefined;
    const url = "url" in capture ? capture.url : undefined;
    const ended = "ended" in capture ? capture.ended : undefined;
    const notDispatched = "notDispatched" in capture ? capture.notDispatched : undefined;
    const failure = "observedFailure" in capture ? capture.observedFailure : undefined;
    return {
      hasKind,
      kind,
      url: typeof url === "string" ? url : undefined,
      ended: typeof ended === "boolean" ? ended : undefined,
      notDispatched: notDispatched === true,
      handlerException: !!(
        failure &&
        typeof failure === "object" &&
        "causeCode" in failure &&
        failure.causeCode === "native_handler_exception"
      ),
    };
  }
  async function captureNative(
    binding: PageBinding,
    func: (...args: string[]) => unknown,
    args?: string[],
    progress?: NavigationProgress,
  ): Promise<PageManagerResult<ReturnType<typeof decodeNativeCapture>>> {
    const previous = nativeCaptureQueues.get(binding.tabId);
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous ? previous.then(() => lock) : lock;
    nativeCaptureQueues.set(binding.tabId, queued);
    let result: PageManagerResult<ReturnType<typeof decodeNativeCapture>>;
    try {
      await previous;
      const current = await manager.isCurrent(binding);
      if (Result.isError(current)) result = pageErr(current.error);
      else if (!current.value) result = navigationErr("source_changed");
      else if (!api.executeMain) result = navigationErr("native_control_unavailable");
      else {
        result = await Result.tryPromise({
          try: () =>
            dispatch(progress, "native_capture", () =>
              api.executeMain!({ tabId: binding.tabId, func, ...(args ? { args } : {}) }),
            ),
          catch: (error) => ({
            code: "page_failed" as const,
            observedFailure: observedFailure(error),
          }),
        }).then((capture) =>
          Result.isError(capture)
            ? pageErr(capture.error)
            : pageOk(decodeNativeCapture(capture.value)),
        );
      }
      if (result.isOk()) {
        const capture = result.value;
        if (
          !capture ||
          !capture.hasKind ||
          (capture.kind === "captured"
            ? capture.ended !== true && !capture.notDispatched
            : capture.kind !== "control_unavailable" && capture.ended !== true) ||
          capture.ended === false
        )
          progress?.uncertain("native_capture_end_unverified");
        if (capture?.handlerException)
          result = pageErr({
            code: "page_failed",
            observedFailure: { kind: "runtime", causeCode: "native_handler_exception" },
          });
      }
    } finally {
      release();
      if (nativeCaptureQueues.get(binding.tabId) === queued)
        nativeCaptureQueues.delete(binding.tabId);
    }
    return result!;
  }
  const sourceReloads = new Map<string, Promise<PageManagerResult<number | undefined>>>();
  const dispatch = <T>(
    progress: NavigationProgress | undefined,
    code: string,
    action: () => Promise<T>,
  ): Promise<T> => (progress ? progress.dispatch(code, action) : action());
  let placingTab = Promise.resolve();
  const savedOpens = new Map<string, Promise<PageManagerResult<PageBinding | undefined>>>();
  const serializePlacement = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = placingTab;
    let release!: () => void;
    placingTab = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const uniquePlacement = async (
    url: string | undefined,
    group?: number,
    tabId?: number,
  ): Promise<PageManagerResult<void>> => {
    const identity = managedPageIdentity(url);
    if (!identity) return pageOk(undefined);
    const inventory =
      group !== undefined
        ? await chromeResult(() => api.queryGroup(group))
        : api.queryMpTabs
          ? await chromeResult(() => api.queryMpTabs!())
          : pageOk([]);
    if (Result.isError(inventory)) return pageErr(inventory.error);
    return inventory.value.some(
      (tab) => tab.id !== tabId && managedPageIdentity(tab.url) === identity,
    )
      ? pageErr({ code: "target_ambiguous" })
      : pageOk(undefined);
  };
  const groupManagedTab = (
    tabId: number,
    group: number,
    progress?: NavigationProgress,
  ): Promise<PageManagerResult<number>> =>
    serializePlacement(async () => {
      const tab = await chromeResult(() => api.getTab(tabId));
      if (Result.isError(tab)) return pageErr(tab.error);
      const unique = await uniquePlacement(tab.value.url, group, tabId);
      if (Result.isError(unique)) return pageErr(unique.error);
      const grouped = await chromeResult(() =>
        dispatch(progress, "tab_group", () => api.groupTabs(tabId, group)),
      );
      if (grouped.isOk()) await progress?.placed?.();
      return grouped;
    });
  const createManagedTab = (
    url: string,
    active: boolean,
    group?: number,
    source?: PageBinding,
    progress?: NavigationProgress,
  ): Promise<PageManagerResult<BrowserTab>> =>
    serializePlacement(async () => {
      const unique = await uniquePlacement(url, group);
      if (Result.isError(unique)) return pageErr(unique.error);
      if (source) {
        const current = await manager.isCurrent(source);
        if (Result.isError(current)) return pageErr(current.error);
        if (!current.value) return navigationErr("source_changed");
      }
      const created = await chromeResult(() =>
        dispatch(progress, "tab_create", () => api.createTab({ url, active })),
      );
      if (Result.isError(created)) return created;
      if (created.value.id === undefined) {
        progress?.uncertain("tab_create_end_unverified");
        return pageErr({ code: "page_failed" });
      }
      const kind = classifyAppmsgUrl(url).kind;
      await progress?.created(
        kind === "draft-list"
          ? "draft-list"
          : kind === "new" || kind === "saved-editor"
            ? "editor"
            : "home",
        created.value.id,
      );
      // Identity inspection, creation and group placement are one operation.
      // Never close or navigate an existing editor to resolve duplicates.
      if (group !== undefined) {
        const stillUnique = await uniquePlacement(
          created.value.url ?? url,
          group,
          created.value.id,
        );
        if (Result.isError(stillUnique)) return pageErr(stillUnique.error, true);
        const grouped = await chromeResult(() =>
          dispatch(progress, "tab_group", () => api.groupTabs(created.value.id!, group)),
        );
        if (Result.isError(grouped)) return pageErr(grouped.error, true);
        await progress?.placed?.();
      }
      return created;
    });
  const waitForSavedEditor = async (
    target: SavedEditorTarget,
    group: number,
    pageCreated: boolean,
    progress?: NavigationProgress,
  ): Promise<PageManagerResult<PageBinding>> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const opened = documents.get(target.tabId);
      if (opened) {
        target.firstDocumentId ??= opened.documentId;
        target.firstRouteRevision ??= opened.routeRevision ?? 0;
        target.firstUrl ??= opened.url;
        if (
          opened.documentId !== target.firstDocumentId ||
          (opened.routeRevision ?? 0) !== target.firstRouteRevision ||
          !sameFinalTabUrl(opened.url, target.firstUrl) ||
          !sameFinalTabUrl(opened.url, target.url)
        )
          return navigationErr("target_not_ready", pageCreated);
        const current = await manager.isCurrent(opened);
        if (Result.isError(current)) return pageErr(current.error, pageCreated);
        if (current.value) {
          await progress?.bound(opened);
          const status = await manager.pageStatus(opened);
          if (Result.isError(status)) return pageErr(status.error, pageCreated);
          if (status.value.state === "not_logged_in")
            return pageErr({ code: "not_logged_in" }, pageCreated);
          if (status.value.state === "ready" && status.value.documentReady) {
            const unique = await uniquePlacement(target.url, group, target.tabId);
            if (Result.isError(unique)) return pageErr(unique.error, pageCreated);
            const tabs = await chromeResult(() => api.queryGroup(group));
            if (Result.isError(tabs)) return pageErr(tabs.error, pageCreated);
            const tab = tabs.value.find((candidate) => candidate.id === target.tabId);
            if (!tab || !sameFinalTabUrl(tab.url, opened.url))
              return navigationErr("target_not_ready", pageCreated);
            const finalCurrent = await manager.isCurrent(opened);
            if (Result.isError(finalCurrent)) return pageErr(finalCurrent.error, pageCreated);
            if (finalCurrent.value) {
              return pageOk(opened);
            }
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return navigationErr("target_not_ready", pageCreated);
  };
  const ownsExactDocument = (binding: PageBinding) =>
    ownsCurrentDocument(binding) && sameFinalTabUrl(documents.get(binding.tabId)?.url, binding.url);
  const exactCurrent = async (binding: PageBinding): Promise<PageManagerResult<void>> => {
    if (!ownsExactDocument(binding)) return navigationErr("source_changed");
    const tab = await chromeResult(() => api.getTab(binding.tabId));
    if (tab.isErr()) return tab;
    return ownsExactDocument(binding) && sameFinalTabUrl(tab.value.url, binding.url)
      ? pageOk(undefined)
      : navigationErr("source_changed");
  };
  // One owned expired page, one native URL, no retry/replacement. This is shared
  // only by saved-editor recovery and its expired-list source dependency.
  const navigateExpiredPage = async (
    source: PageBinding,
    expired: PageBinding,
    url: string,
    group: number,
    progress?: NavigationProgress,
  ): Promise<PageManagerResult<PageBinding>> => {
    if (!api.updateTab) return pageErr({ code: "not_logged_in" });
    const revision = groupRevision;
    source = { ...source };
    expired = { ...expired };
    const target: SavedEditorTarget = {
      tabId: expired.tabId,
      url,
      previousDocumentId: expired.documentId,
    };
    const unchanged = () =>
      groupId === group &&
      groupRevision === revision &&
      !resolvingGroup &&
      !restoring &&
      ownsExactDocument(source) &&
      ownsExactDocument(expired);
    const sourceGuard = async (): Promise<PageManagerResult<void>> => {
      const current = await exactCurrent(source);
      if (current.isErr()) return current;
      if (groupId !== group || groupRevision !== revision) return navigationErr("source_changed");
      const status = await manager.pageStatus(source);
      if (status.isErr()) return status;
      if (status.value.state !== "ready" || !status.value.documentReady)
        return navigationErr("source_changed");
      const final = await exactCurrent(source);
      return final.isErr()
        ? final
        : groupId === group && groupRevision === revision
          ? pageOk(undefined)
          : navigationErr("source_changed");
    };
    const guard = async (): Promise<PageManagerResult<void>> => {
      if (!unchanged()) return navigationErr("source_changed");
      const freshSource = await sourceGuard();
      if (freshSource.isErr()) return freshSource;
      if (classifyAppmsgUrl(url).kind === "saved-editor") {
        const candidates = await manager.listDraftGroups(source);
        if (candidates.isErr()) return candidates;
        if (
          candidates.value.filter((candidate) => isSavedEditorForGroup(url, candidate.groupId))
            .length !== 1
        )
          return navigationErr("source_changed");
      }
      const unique = await uniquePlacement(expired.url, group, expired.tabId);
      if (unique.isErr()) return unique;
      const members = await chromeResult(() => api.queryGroup(group));
      if (members.isErr()) return members;
      if (
        !members.value.some(
          (tab) => tab.id === source.tabId && sameFinalTabUrl(tab.url, source.url),
        ) ||
        !members.value.some(
          (tab) => tab.id === expired.tabId && sameFinalTabUrl(tab.url, expired.url),
        )
      )
        return navigationErr("source_changed");
      const current = await exactCurrent(expired);
      if (current.isErr()) return current;
      const sourceAtDispatch = await exactCurrent(source);
      if (sourceAtDispatch.isErr()) return sourceAtDispatch;
      const targetAtDispatch = await exactCurrent(expired);
      if (targetAtDispatch.isErr()) return targetAtDispatch;
      const statusAtDispatch = await manager.pageStatus(expired);
      if (statusAtDispatch.isErr()) return statusAtDispatch;
      if (statusAtDispatch.value.state !== "not_logged_in") return navigationErr("source_changed");
      return unchanged() ? pageOk(undefined) : navigationErr("source_changed");
    };
    let complete: ((binding: PageBinding) => void) | undefined;
    try {
      const dispatched = await serializePlacement(async () => {
        const before = await guard();
        if (before.isErr()) return before;
        return chromeResult(() =>
          dispatch(progress, "relogin_navigation", async () => {
            const final = await guard();
            if (final.isErr()) return final;
            if (!unchanged()) return navigationErr("source_changed");
            savedOpenTargets.add(target);
            complete = progress?.reloading?.(expired);
            if (!unchanged()) return navigationErr("source_changed");
            invalidated.add(`${expired.tabId}:${expired.documentId}`);
            documents.delete(expired.tabId);
            checkEditorWaits();
            await api.updateTab!(expired.tabId, { url });
            return pageOk(undefined);
          }),
        ).then((result) => (result.isErr() ? pageErr(result.error) : result.value));
      });
      if (dispatched.isErr()) return dispatched;
      let fresh: PageManagerResult<PageBinding>;
      if (classifyAppmsgUrl(url).kind === "saved-editor") {
        fresh = await waitForSavedEditor(target, group, false);
      } else {
        const deadline = Date.now() + 15_000;
        fresh = navigationErr("target_not_ready");
        while (Date.now() < deadline) {
          const binding = documents.get(expired.tabId);
          if (binding) {
            target.firstDocumentId ??= binding.documentId;
            target.firstRouteRevision ??= binding.routeRevision ?? 0;
            target.firstUrl ??= binding.url;
            if (
              binding.documentId === expired.documentId ||
              binding.documentId !== target.firstDocumentId ||
              (binding.routeRevision ?? 0) !== target.firstRouteRevision ||
              !sameFinalTabUrl(binding.url, url) ||
              !sameFinalTabUrl(binding.url, target.firstUrl)
            )
              break;
            const current = await exactCurrent(binding);
            if (current.isErr()) {
              fresh = current;
              break;
            }
            const status = await manager.pageStatus(binding);
            if (status.isErr()) {
              fresh = status;
              break;
            }
            if (status.value.state === "not_logged_in") {
              fresh = pageErr({ code: "not_logged_in" });
              break;
            }
            if (status.value.state === "ready" && status.value.documentReady) {
              fresh = pageOk(binding);
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (fresh.isErr()) return fresh;
      const binding = fresh.value;
      if (target.changed || binding.documentId === expired.documentId)
        return navigationErr("target_not_ready");
      const sourceBeforeBinding = await sourceGuard();
      if (sourceBeforeBinding.isErr()) return sourceBeforeBinding;
      const targetBeforeBinding = await exactCurrent(binding);
      if (targetBeforeBinding.isErr()) return targetBeforeBinding;
      if (classifyAppmsgUrl(url).kind === "saved-editor") await progress?.bound(binding);
      const provenSource = await sourceGuard();
      if (provenSource.isErr()) return provenSource;
      const unique = await uniquePlacement(url, group, expired.tabId);
      if (unique.isErr()) return unique;
      const members = await chromeResult(() => api.queryGroup(group));
      if (members.isErr()) return members;
      if (
        !members.value.some(
          (tab) => tab.id === source.tabId && sameFinalTabUrl(tab.url, source.url),
        )
      )
        return navigationErr("source_changed");
      const finalSource = await exactCurrent(source);
      if (finalSource.isErr()) return finalSource;
      const final = await exactCurrent(binding);
      if (final.isErr()) return final;
      const ready = await manager.pageStatus(binding);
      if (ready.isErr()) return ready;
      if (ready.value.state !== "ready" || !ready.value.documentReady)
        return navigationErr("target_not_ready");
      const currentAtReturn = await exactCurrent(binding);
      if (currentAtReturn.isErr()) return currentAtReturn;
      const sourceAtReturn = await exactCurrent(source);
      if (sourceAtReturn.isErr()) return sourceAtReturn;
      if (
        !ownsExactDocument(source) ||
        !ownsExactDocument(binding) ||
        target.changed ||
        groupId !== group ||
        groupRevision !== revision ||
        binding.documentId !== target.firstDocumentId ||
        (binding.routeRevision ?? 0) !== target.firstRouteRevision ||
        !sameFinalTabUrl(binding.url, url)
      )
        return navigationErr("target_not_ready");
      complete?.(binding); // Only fresh observed proof ends BG's navigation reservation.
      if (classifyAppmsgUrl(url).kind === "draft-list") progress?.sourceReady(binding);
      return pageOk(binding);
    } finally {
      savedOpenTargets.delete(target);
    }
  };
  api.onBeforeNavigate?.(({ tabId, frameId }) => {
    if (frameId !== 0) return;
    const navigationId = (navigationPending.get(tabId) ?? 0) + 1;
    navigationPending.set(tabId, navigationId);
    checkEditorWaits();
    navigationStartDocument.set(tabId, documents.get(tabId)?.documentId);
    navigationCommit.delete(tabId);
  });
  api.onCommitted?.(({ tabId, frameId, documentId }) => {
    if (frameId !== 0) return;
    for (const target of savedOpenTargets.values()) {
      if (target.tabId === tabId && target.firstDocumentId === undefined)
        target.firstDocumentId = documentId;
    }
    const navigationId = navigationPending.get(tabId);
    if (navigationId !== undefined) navigationCommit.set(tabId, { navigationId, documentId });
    const current = documents.get(tabId);
    if (current && current.documentId !== documentId) {
      invalidated.add(`${current.tabId}:${current.documentId}`);
      documents.delete(tabId);
      checkEditorWaits();
    }
    if (
      current?.documentId === documentId &&
      documentId !== navigationStartDocument.get(tabId) &&
      navigationCommit.get(tabId)?.documentId === documentId &&
      navigationCommit.get(tabId)?.navigationId === navigationId
    ) {
      navigationPending.delete(tabId);
      navigationStartDocument.delete(tabId);
      navigationCommit.delete(tabId);
      frameCheckPending.delete(tabId);
    }
  });
  const settleUnknownFrame = (
    tabId: number,
    checkId: number,
    navigationId: number,
    binding: PageBinding,
    error: PageManagerError,
  ) => {
    const latest = documents.get(tabId);
    if (
      frameChecks.get(tabId) !== checkId ||
      navigationPending.has(tabId) ||
      (navigationPending.get(tabId) ?? 0) !== navigationId ||
      latest?.documentId !== binding.documentId ||
      (latest.routeRevision ?? 0) !== (binding.routeRevision ?? 0)
    )
      return;
    invalidated.add(`${latest.tabId}:${latest.documentId}`);
    documents.delete(tabId);
    checkEditorWaits();
    frameCheckPending.delete(tabId);
    frameCheckErrors.set(tabId, { documentId: binding.documentId, error });
  };
  api.onTabUpdated?.((tabId, status) => {
    if (status !== "loading") return;
    const current = documents.get(tabId);
    if (!current) return;
    const checkId = (frameChecks.get(tabId) ?? 0) + 1;
    frameChecks.set(tabId, checkId);
    frameCheckPending.add(tabId);
    checkEditorWaits();
    frameCheckErrors.delete(tabId);
    const navigationId = navigationPending.get(tabId) ?? 0;
    const resolveFrame = api.getFrame;
    if (!resolveFrame) {
      settleUnknownFrame(tabId, checkId, navigationId, current, { code: "page_failed" });
      return;
    }
    void Result.tryPromise({
      try: () => Promise.resolve(resolveFrame({ tabId, frameId: 0 })),
      catch: () => ({ code: "page_failed" as const }),
    }).then((frame) => {
      if (Result.isError(frame)) {
        settleUnknownFrame(tabId, checkId, navigationId, current, frame.error);
        return;
      }
      const latest = documents.get(tabId);
      if (
        frameChecks.get(tabId) !== checkId ||
        navigationPending.has(tabId) ||
        (navigationPending.get(tabId) ?? 0) !== navigationId ||
        latest?.documentId !== current.documentId
      )
        return;
      if (frame.value?.documentId === current.documentId) {
        frameCheckPending.delete(tabId);
        return;
      }
      settleUnknownFrame(tabId, checkId, navigationId, current, { code: "target_unavailable" });
    });
  });
  api.onTabRemoved?.((tabId) => {
    for (const observer of navigationObservers) observer.tabRemoved?.(tabId);
    const current = documents.get(tabId);
    if (current) {
      invalidated.add(`${current.tabId}:${current.documentId}`);
    }
    documents.delete(tabId);
    checkEditorWaits();
    navigationPending.delete(tabId);
    navigationStartDocument.delete(tabId);
    navigationCommit.delete(tabId);
    frameCheckPending.delete(tabId);
    frameChecks.delete(tabId);
  });
  const resolveManagedGroup = async (
    progress?: NavigationProgress,
  ): Promise<PageManagerResult<number>> => {
    if (groupId !== undefined) {
      const cached = groupId;
      const checked = await chromeResult(() => api.getGroup(cached));
      if (Result.isOk(checked)) return pageOk(cached);
      if (checked.error.code !== "missing_group") return pageErr(checked.error);
      if (checked.error.groupId !== cached) return pageErr({ code: "page_failed" });
      if (groupId !== cached || groupRevision !== resolvingRevision) return pageErr(checked.error);
      groupId = undefined;
    }

    if (recoveryCandidate) {
      const candidate = recoveryCandidate;
      const checked = await chromeResult(() => api.getGroup(candidate.id));
      if (Result.isError(checked)) {
        if (checked.error.code !== "missing_group") return pageErr(checked.error);
        if (recoveryCandidate === candidate) recoveryCandidate = undefined;
        return recoverManagedGroup(progress);
      }
      if (!candidate.updated) {
        const updated = await chromeResult(() =>
          dispatch(progress, "group_update", () =>
            api.updateGroup(candidate.id, { title: "mpctl" }),
          ),
        );
        if (Result.isError(updated)) return pageErr(updated.error);
        candidate.updated = true;
      }
      if (!candidate.saved) {
        const saved = await saveGroupLock(candidate.id);
        if (Result.isError(saved)) return pageErr(saved.error);
        candidate.saved = true;
      }
      groupId = candidate.id;
      recoveryCandidate = undefined;
      groupRevision++;
      return pageOk(candidate.id);
    }
    if (savedGroupHint !== undefined) {
      const candidate = savedGroupHint;
      const checked = await chromeResult(() => api.getGroup(candidate));
      if (Result.isError(checked)) {
        if (checked.error.code !== "missing_group") return pageErr(checked.error);
        if (savedGroupHint === candidate) savedGroupHint = undefined;
        return recoverManagedGroup(progress);
      }
      if (api.setLocal) {
        const saved = await chromeResult(() => api.setLocal!({ managedGroupId: candidate }));
        if (Result.isError(saved)) return pageErr(saved.error);
      }
      if (savedGroupHint === candidate) savedGroupHint = undefined;
      groupId = candidate;
      groupRevision++;
      return pageOk(candidate);
    }
    return recoverManagedGroup(progress);
  };
  const readGroupLock = async (): Promise<PageManagerResult<Record<string, unknown>>> => {
    if (!api.getLocal) return chromeResult(() => api.getSession("managedGroupId"));
    const local = await chromeResult(() => api.getLocal!("managedGroupId"));
    if (Result.isError(local)) return pageErr(local.error);
    return typeof local.value.managedGroupId === "number"
      ? pageOk(local.value)
      : chromeResult(() => api.getSession("managedGroupId"));
  };
  const saveGroupLock = async (id: number): Promise<PageManagerResult<void>> => {
    if (api.setLocal) {
      const local = await chromeResult(() => api.setLocal!({ managedGroupId: id }));
      if (Result.isError(local)) return pageErr(local.error);
    }
    return chromeResult(() => api.setSession({ managedGroupId: id }));
  };
  const recoverManagedGroup = (
    progress?: NavigationProgress,
  ): Promise<PageManagerResult<number>> => {
    if (!api.queryGroups) return createManagedGroup(progress);
    return (async () => {
      const queried = await chromeResult(() => api.queryGroups!());
      if (Result.isError(queried)) return pageErr(queried.error);
      const existing = queried.value
        .filter((group) => group.title === "mpctl")
        .sort((a, b) => a.id - b.id);
      for (const candidate of existing) {
        const checked = await chromeResult(() => api.getGroup(candidate.id));
        if (Result.isError(checked)) {
          if (checked.error.code === "missing_group") continue;
          return pageErr(checked.error);
        }
        recoveryCandidate = { id: candidate.id, updated: true, saved: false };
        return resolveManagedGroup(progress);
      }
      return createManagedGroup(progress);
    })();
  };
  let resolvingRevision = 0;
  const createManagedGroup = async (
    progress?: NavigationProgress,
  ): Promise<PageManagerResult<number>> => {
    let anchorTabId = acquiringHomeTabId;
    if (anchorTabId === undefined) {
      const tabs = api.queryMpTabs ? await chromeResult(() => api.queryMpTabs!()) : pageOk([]);
      if (Result.isError(tabs)) return pageErr(tabs.error);
      const currentMpTabs = tabs.value;
      const homeRouteTabs = currentMpTabs.filter(
        (tab) => tab.id !== undefined && classifyAppmsgUrl(tab.url).kind === "home",
      );
      if (homeRouteTabs.length === 1) anchorTabId = homeRouteTabs[0]!.id;
    }
    if (anchorTabId === undefined) {
      const observedHomes = [...documents.values()].filter((binding) => isHomePageUrl(binding.url));
      if (observedHomes.length === 1) {
        const candidate = observedHomes[0]!;
        const observed = await chromeResult(async () => {
          const tab = await api.getTab(candidate.tabId);
          const frame = await api.getFrame?.({ tabId: candidate.tabId, frameId: 0 });
          return { tab, frame };
        });
        if (Result.isOk(observed)) {
          const { tab, frame } = observed.value;
          if (
            tab.url === candidate.url &&
            (!api.getFrame || frame?.documentId === candidate.documentId)
          )
            anchorTabId = candidate.tabId;
        }
      }
    }
    if (anchorTabId === undefined) {
      const created = await createManagedTab(
        "https://mp.weixin.qq.com/",
        false,
        undefined,
        undefined,
        progress,
      );
      if (Result.isError(created)) return pageErr(created.error);
      if (created.value.id === undefined) return pageErr({ code: "page_failed" });
      anchorTabId = created.value.id;
      acquiringHomeTabId = anchorTabId;
    }
    const grouped = await chromeResult(() =>
      dispatch(progress, "group_create", () => api.groupTabs(anchorTabId!)),
    );
    if (Result.isError(grouped)) return pageErr(grouped.error);
    await progress?.placed?.();
    const id = grouped.value;
    const candidate = { id, updated: false, saved: false };
    recoveryCandidate = candidate;
    const updated = await chromeResult(() =>
      dispatch(progress, "group_update", () => api.updateGroup(id, { title: "mpctl" })),
    );
    if (Result.isError(updated)) return pageErr(updated.error);
    candidate.updated = true;
    const saved = await saveGroupLock(id);
    if (Result.isError(saved)) return pageErr(saved.error);
    candidate.saved = true;
    if (recoveryCandidate === candidate) recoveryCandidate = undefined;
    groupId = id;
    groupRevision++;
    return pageOk(id);
  };
  const reloadObservedSource = async (
    kind: "home" | "draft-list",
    group: number,
    preferredTabId?: number,
    progress?: NavigationProgress,
  ): Promise<PageManagerResult<number | undefined>> => {
    if (!api.reloadTab) return pageOk(undefined);
    const queried = api.queryMpTabs
      ? await chromeResult(() => api.queryMpTabs!())
      : await chromeResult(() => api.queryGroup(group));
    if (Result.isError(queried)) return pageErr(queried.error);
    const tabs = queried.value;
    const candidates = tabs.filter(
      (tab) =>
        tab.id !== undefined &&
        (preferredTabId === undefined || tab.id === preferredTabId) &&
        classifyAppmsgUrl(tab.url).kind === kind,
    );
    if (candidates.length > 1) return navigationErr("source_ambiguous");
    const candidate = candidates[0];
    if (candidate?.id === undefined || !candidate.url) return pageOk(undefined);
    const key = `${candidate.id}:${kind}`;
    const existing = sourceReloads.get(key);
    if (existing) return await existing;
    const attempt = (async () => {
      const currentResult = await chromeResult(() => api.getTab(candidate.id!));
      if (Result.isError(currentResult)) return pageErr(currentResult.error);
      const current = currentResult.value;
      if (current.url !== candidate.url || classifyAppmsgUrl(current.url).kind !== kind)
        return pageOk(undefined);
      const grouped = await groupManagedTab(candidate.id!, group, progress);
      if (Result.isError(grouped)) return pageErr(grouped.error);
      // Placement and its evidence checkpoint may have observed another document.
      // Verify that document after every awaited step, then reserve the baseline
      // in the actual dispatch callback with no await before Chrome reload.
      const source = documents.get(candidate.id!);
      if (!source || !ownsCurrentDocument(source)) return pageErr({ code: "target_unavailable" });
      const tabAtDispatch = await chromeResult(() => api.getTab(candidate.id!));
      if (tabAtDispatch.isErr()) return pageErr(tabAtDispatch.error);
      let completeReload: ((binding: PageBinding) => void) | undefined;
      const reloaded = await chromeResult(() =>
        dispatch(progress, "source_reload", () => {
          if (
            documents.get(candidate.id!) !== source ||
            !ownsCurrentDocument(source) ||
            !sameFinalTabUrl(tabAtDispatch.value.url, source.url) ||
            classifyAppmsgUrl(source.url).kind !== kind ||
            appmsgRouteIdentity(source.url) !== appmsgRouteIdentity(candidate.url)
          )
            return Promise.resolve(pageErr({ code: "target_unavailable" }));
          completeReload = progress?.reloading?.(source);
          return api.reloadTab!(candidate.id!).then(() => pageOk(undefined));
        }),
      );
      if (Result.isError(reloaded)) return pageErr(reloaded.error);
      if (reloaded.value.isErr()) return pageErr(reloaded.value.error);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const binding = documents.get(candidate.id!);
        if (
          binding &&
          binding.documentId !== source.documentId &&
          ownsCurrentDocument(binding) &&
          classifyAppmsgUrl(binding.url).kind === kind &&
          appmsgRouteIdentity(binding.url) === appmsgRouteIdentity(source.url)
        ) {
          completeReload?.(binding);
          progress?.sourceReady(binding);
          return pageOk(candidate.id);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return pageOk(undefined);
    })();
    sourceReloads.set(key, attempt);
    try {
      return await attempt;
    } finally {
      if (sourceReloads.get(key) === attempt) sourceReloads.delete(key);
    }
  };
  const executionReceipt = async <
    T extends BodyReceipt | FieldsReceipt | UploadReceipt | CoverReceipt | SaveReceipt,
  >(
    target: OperationTarget,
    id: string,
    codec: { deserialize(value: unknown): Promise<BetterResult<T | null, Failure>> },
    operation: (connection: Connection) => RemoteValue<unknown>,
    body = false,
  ): Promise<BetterResult<T | null, Failure>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lookup = async (): Promise<BetterResult<T | null, Failure>> => {
      try {
        // Historical bindings are not restored capabilities; validate the current frame on both sides.
        if (!api.getFrame) return Result.err({ code: "receipt_unreachable" });
        const tab = await api.getTab(target.tabId);
        const frame = await api.getFrame({ tabId: target.tabId, frameId: 0 });
        if (
          !tab?.url ||
          frame?.documentId !== target.documentId ||
          appmsgRouteIdentity(frame.url) !== target.route ||
          appmsgRouteIdentity(tab.url) !== target.route
        )
          return Result.err({ code: "target_unavailable" });
        const connection = await connectStatus({
          tabId: target.tabId,
          documentId: target.documentId,
          url: tab.url,
        });
        if (
          connection.status !== "connected" ||
          !hasPreparationVersion(connection.contextMeta) ||
          (body && !hasReadyEditor(connection.contextMeta))
        )
          return Result.err({ code: "receipt_unreachable" });
        const response = await callPage(operation(connection));
        if (response.isErr()) return Result.err({ code: "receipt_unreachable" });
        const receipt = await codec.deserialize(response.value);
        if (receipt.isErr()) return receipt;
        const after = await api.getFrame({ tabId: target.tabId, frameId: 0 });
        if (
          after?.documentId !== target.documentId ||
          appmsgRouteIdentity(after.url) !== target.route
        )
          return Result.err({ code: "target_unavailable" });
        if (
          receipt.value &&
          (receipt.value.executorId !== target.executorId || receipt.value.operationId !== id)
        )
          return Result.err({ code: "evidence_conflict" });
        return receipt;
      } catch {
        return Result.err({ code: "receipt_unreachable" });
      }
    };
    try {
      return await Promise.race([
        lookup(),
        new Promise<BetterResult<T | null, Failure>>((resolve) => {
          timer = setTimeout(() => resolve(Result.err({ code: "receipt_unreachable" })), 4_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const manager = {
    observeNavigation(progress: NavigationProgress): () => void {
      navigationObservers.add(progress);
      return () => navigationObservers.delete(progress);
    },
    observe(binding: PageBinding): void {
      this.observeConnection(binding.tabId, binding.documentId, binding.url);
    },
    observeConnection(
      tabId: number | undefined,
      documentId: string | undefined,
      url: string | undefined,
    ): void {
      if (tabId === undefined || !documentId) return;
      if (invalidated.has(`${tabId}:${documentId}`)) return;
      for (const target of savedOpenTargets) {
        if (target.tabId !== tabId || target.previousDocumentId === undefined) continue;
        target.firstDocumentId ??= documentId;
        target.firstUrl ??= url;
        target.firstRouteRevision ??= 0;
        if (
          target.firstDocumentId !== documentId ||
          !target.firstUrl ||
          !sameFinalTabUrl(url, target.firstUrl)
        )
          target.changed = true;
      }
      const route = classifyAppmsgUrl(url);
      const previous = documents.get(tabId);
      if (previous && previous.documentId !== documentId) {
        invalidated.add(`${previous.tabId}:${previous.documentId}`);
        frameChecks.set(tabId, (frameChecks.get(tabId) ?? 0) + 1);
        frameCheckPending.delete(tabId);
      }
      if (route.kind === "unsupported") {
        if (previous?.documentId === documentId)
          invalidated.add(`${previous.tabId}:${previous.documentId}`);
        documents.delete(tabId);
        checkEditorWaits();
        return;
      }
      const routeRevision =
        previous?.documentId === documentId &&
        appmsgRouteIdentity(previous.url) !== appmsgRouteIdentity(url)
          ? (previous.routeRevision ?? 0) + 1
          : previous?.documentId === documentId
            ? previous.routeRevision
            : 0;
      const binding = {
        tabId,
        documentId,
        url: url!,
        ...(routeRevision ? { routeRevision } : {}),
      };
      documents.set(tabId, binding);
      checkEditorWaits();
      const commit = navigationCommit.get(tabId);
      if (
        commit?.documentId === documentId &&
        commit.navigationId === navigationPending.get(tabId)
      ) {
        navigationPending.delete(tabId);
        navigationStartDocument.delete(tabId);
        navigationCommit.delete(tabId);
        frameCheckPending.delete(tabId);
      }
    },
    async managedGroup(progress?: NavigationProgress): Promise<PageManagerResult<number>> {
      if (resolvingGroup) return resolvingGroup;
      if (restoring) {
        const restored = await restoring;
        if (Result.isError(restored)) return pageErr(restored.error);
        return this.managedGroup(progress);
      }
      resolvingRevision = groupRevision;
      const attempt = (async (): Promise<PageManagerResult<number>> => {
        if (sessionGroupReadRequired && groupId === undefined && recoveryCandidate === undefined) {
          const saved = await readGroupLock();
          if (Result.isError(saved)) return pageErr(saved.error);
          savedGroupHint =
            typeof saved.value.managedGroupId === "number" ? saved.value.managedGroupId : undefined;
          sessionGroupReadRequired = false;
        }
        return resolveManagedGroup(progress);
      })();
      resolvingGroup = attempt;
      try {
        return await attempt;
      } finally {
        if (resolvingGroup === attempt) resolvingGroup = undefined;
      }
    },
    async ensureEditorTab(progress?: NavigationProgress): Promise<PageManagerResult<PageBinding>> {
      const existing = await this.findCurrentEditor({ new: true });
      if (existing.isErr()) return pageErr(existing.error);
      if (existing.value) return pageErr({ code: "target_ambiguous" });
      const group = await this.managedGroup(progress);
      if (Result.isError(group)) return pageErr(group.error);
      return this.openFromManagedHome("openNewEditor", "new", progress);
    },
    async ensureDraftList(
      options: { refresh?: boolean } = {},
      progress?: NavigationProgress,
    ): Promise<PageManagerResult<PageBinding>> {
      if (options.refresh) {
        if (refreshingDraftList) return refreshingDraftList;
        const attempt = (async (): Promise<PageManagerResult<PageBinding>> => {
          // A fresh request must not be satisfied by a normal ensure already in flight.
          if (ensuringDraftList) {
            const normal = await ensuringDraftList;
            if (Result.isError(normal)) return pageErr(normal.error);
          }
          const group = await this.managedGroup(progress);
          if (Result.isError(group)) return pageErr(group.error);
          let existing = await this.findDraftList();
          if (Result.isError(existing)) return pageErr(existing.error);
          if (!existing.value) {
            const acquired = await this.ensureDraftList({}, progress);
            if (Result.isError(acquired)) return pageErr(acquired.error);
            return pageOk(acquired.value);
          }
          const source = existing.value;
          const current = await this.isCurrent(source);
          if (Result.isError(current)) return pageErr(current.error);
          if (!current.value || classifyAppmsgUrl(source.url).kind !== "draft-list")
            return pageErr({ code: "target_unavailable" });

          const sourceStatus = await this.pageStatus(source);
          if (sourceStatus.isErr()) return pageErr(sourceStatus.error);
          if (sourceStatus.value.state === "not_logged_in")
            return this.ensureDraftList({}, progress);

          const reloaded = await reloadObservedSource(
            "draft-list",
            group.value,
            source.tabId,
            progress,
          );
          if (Result.isError(reloaded)) return pageErr(reloaded.error);
          if (reloaded.value !== source.tabId) return pageErr({ code: "page_failed" });

          const refreshed = await this.findDraftList();
          if (Result.isError(refreshed)) return pageErr(refreshed.error);
          const binding = refreshed.value;
          if (
            !binding ||
            binding.tabId !== source.tabId ||
            binding.documentId === source.documentId ||
            appmsgRouteIdentity(binding.url) !== appmsgRouteIdentity(source.url)
          )
            return pageErr({ code: "target_unavailable" });
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const currentBinding = await this.isCurrent(binding);
            if (Result.isError(currentBinding)) return pageErr(currentBinding.error);
            if (!currentBinding.value) return pageErr({ code: "target_unavailable" });
            const currentGroup = await chromeResult(() => api.queryGroup(group.value));
            if (Result.isError(currentGroup)) return pageErr(currentGroup.error);
            if (!currentGroup.value.some((tab) => tab.id === binding.tabId))
              return pageErr({ code: "target_unavailable" });
            const managedGroup = await this.managedGroup(progress);
            if (Result.isError(managedGroup)) return pageErr(managedGroup.error);
            if (managedGroup.value !== group.value) return pageErr({ code: "target_unavailable" });
            const status = await this.pageStatus(binding);
            if (Result.isError(status)) return pageErr(status.error);
            const stillCurrent = await this.isCurrent(binding);
            if (Result.isError(stillCurrent)) return pageErr(stillCurrent.error);
            if (!stillCurrent.value) return pageErr({ code: "target_unavailable" });
            if (status.value.state === "not_logged_in") return this.ensureDraftList({}, progress);
            if (status.value.state === "ready" && status.value.documentReady) {
              progress?.sourceReady(binding);
              return pageOk(binding);
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return pageErr({ code: "page_failed" });
        })();
        refreshingDraftList = attempt;
        try {
          return await attempt;
        } finally {
          if (refreshingDraftList === attempt) refreshingDraftList = undefined;
        }
      }
      if (ensuringDraftList) return ensuringDraftList;
      const attempt = (async (): Promise<PageManagerResult<PageBinding>> => {
        const group = await this.managedGroup(progress);
        if (Result.isError(group)) return pageErr(group.error);
        const existing = await this.findDraftList();
        if (Result.isError(existing)) return pageErr(existing.error);
        if (existing.value) {
          const existingBinding = { ...existing.value };
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const current = await this.isCurrent(existingBinding);
            if (Result.isError(current)) return pageErr(current.error);
            if (!current.value) return pageErr({ code: "target_unavailable" });
            const status = await this.pageStatus(existingBinding);
            if (Result.isError(status)) return pageErr(status.error);
            if (status.value.state === "not_logged_in") {
              const recoveryRevision = groupRevision;
              const home = await this.findManagedHome();
              if (home.isErr()) return home;
              if (!home.value) return pageErr({ code: "not_logged_in" });
              const source = { ...home.value };
              const currentHome = await exactCurrent(source);
              if (currentHome.isErr()) return currentHome;
              const statusHome = await this.pageStatus(source);
              if (statusHome.isErr()) return statusHome;
              if (statusHome.value.state === "not_logged_in")
                return pageErr({ code: "not_logged_in" });
              if (statusHome.value.state !== "ready" || !statusHome.value.documentReady)
                return navigationErr("source_changed");
              const connected = await this.connectContent(source);
              if (connected.isErr()) return connected;
              const native = await decodeRemote(openDraftListResultCodec, () =>
                connected.value.get(homePageToken).openDraftList(),
              );
              if (native.isErr()) return native;
              if (classifyAppmsgUrl(native.value).kind !== "draft-list")
                return navigationErr("native_target_unsupported");
              const currentSource = await exactCurrent(source);
              if (currentSource.isErr()) return currentSource;
              const placed = await groupManagedTab(source.tabId, group.value, progress);
              if (placed.isErr()) return placed;
              if (groupId !== group.value || groupRevision !== recoveryRevision)
                return navigationErr("source_changed");
              return navigateExpiredPage(
                source,
                existingBinding,
                native.value,
                group.value,
                progress,
              );
            }
            if (status.value.state === "ready") {
              const stillCurrent = await this.isCurrent(existingBinding);
              if (Result.isError(stillCurrent)) return pageErr(stillCurrent.error);
              if (!stillCurrent.value) return pageErr({ code: "target_unavailable" });
              {
                progress?.sourceReady(existingBinding);
                return pageOk(existingBinding);
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return pageErr({ code: "page_failed" });
        }
        const reloaded = await reloadObservedSource("draft-list", group.value, undefined, progress);
        if (Result.isError(reloaded)) return pageErr(reloaded.error);
        if (reloaded.value !== undefined) {
          const binding = await this.findDraftList();
          if (Result.isError(binding)) return pageErr(binding.error);
          if (binding.value?.tabId === reloaded.value) {
            const reloadedBinding = binding.value;
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline) {
              const current = await this.isCurrent(reloadedBinding);
              if (Result.isError(current)) return pageErr(current.error);
              if (!current.value) break;
              const status = await this.pageStatus(reloadedBinding);
              if (Result.isError(status)) return pageErr(status.error);
              const stillCurrent = await this.isCurrent(reloadedBinding);
              if (Result.isError(stillCurrent)) return pageErr(stillCurrent.error);
              if (status.value.state === "ready" && stillCurrent.value)
                return pageOk(reloadedBinding);
              if (status.value.state === "not_logged_in") return pageErr({ code: "not_logged_in" });
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
        }
        return this.openFromManagedHome("openDraftList", "draft-list", progress);
      })();
      ensuringDraftList = attempt;
      try {
        return await attempt;
      } finally {
        if (ensuringDraftList === attempt) ensuringDraftList = undefined;
      }
    },
    async restore(): Promise<PageManagerResult<void>> {
      if (restoring) return restoring;
      if (resolvingGroup) {
        const resolution = await resolvingGroup;
        if (Result.isError(resolution) && groupId === undefined && recoveryCandidate === undefined)
          return pageErr(resolution.error);
        return this.restore();
      }
      const revision = groupRevision;
      const operation = (async (): Promise<PageManagerResult<void>> => {
        let saved: Record<string, unknown> = {};
        const lock = await readGroupLock();
        if (Result.isOk(lock)) saved = lock.value;
        else {
          const inMemoryGroupTookPriority =
            revision !== groupRevision || groupId !== undefined || recoveryCandidate !== undefined;
          if (!inMemoryGroupTookPriority) sessionGroupReadRequired = true;
          else saved = {};
          if (!inMemoryGroupTookPriority) return pageErr(lock.error);
        }
        if (revision === groupRevision && groupId === undefined && !recoveryCandidate) {
          savedGroupHint =
            typeof saved.managedGroupId === "number" ? saved.managedGroupId : undefined;
          sessionGroupReadRequired = false;
        }
        let validated: number | undefined;
        const canRestoreSavedGroup =
          revision === groupRevision && groupId === undefined && !recoveryCandidate;
        if (typeof saved.managedGroupId === "number" && canRestoreSavedGroup) {
          savedGroupHint = saved.managedGroupId;
          const checked = await chromeResult(() => api.getGroup(saved.managedGroupId as number));
          if (Result.isOk(checked)) validated = saved.managedGroupId;
          else {
            const inMemoryGroupTookPriority =
              revision !== groupRevision ||
              groupId !== undefined ||
              recoveryCandidate !== undefined;
            if (checked.error.code !== "missing_group") {
              if (!inMemoryGroupTookPriority) return pageErr(checked.error);
            } else if (savedGroupHint === saved.managedGroupId) {
              savedGroupHint = undefined;
            }
          }
        }
        if (revision === groupRevision && groupId === undefined && !recoveryCandidate) {
          if (validated !== undefined && api.setLocal) {
            const local = await chromeResult(() => api.setLocal!({ managedGroupId: validated! }));
            if (Result.isError(local)) return pageErr(local.error);
          }
          groupId = validated;
          if (validated !== undefined || savedGroupHint === saved.managedGroupId)
            savedGroupHint = undefined;
          if (validated !== undefined) groupRevision++;
        }
        // Restoring Chrome pointers never creates a WebSocket or revives a Nexus connection.
        return pageOk(undefined);
      })();
      restoring = operation;
      const result = await operation;
      if (restoring === operation) restoring = undefined;
      return result;
    },
    async cleanupWorkspace(progress?: NavigationProgress): Promise<
      PageManagerResult<{
        groupsRemoved: number;
        tabsMoved: number;
        groupsRemaining: number;
      }>
    > {
      const locked = await this.managedGroup(progress);
      if (Result.isError(locked)) return pageErr(locked.error);
      if (!api.queryGroups) return pageErr({ code: "page_failed" });
      const groupsResult = await chromeResult(() => api.queryGroups!());
      if (Result.isError(groupsResult)) return pageErr(groupsResult.error);
      const destinationResult = await chromeResult(() => api.getGroup(locked.value));
      if (Result.isError(destinationResult)) return pageErr(destinationResult.error);
      const groups = groupsResult.value;
      const destination = destinationResult.value as { windowId?: number };
      let tabsMoved = 0;
      let groupsRemoved = 0;
      for (const duplicate of groups) {
        if (duplicate.id === locked.value || duplicate.title !== "mpctl") continue;
        const tabsResult = await chromeResult(() => api.queryGroup(duplicate.id));
        if (Result.isError(tabsResult)) return pageErr(tabsResult.error);
        const tabs = tabsResult.value;
        for (const tab of tabs) {
          if (tab.id === undefined) continue;
          const unique = await uniquePlacement(tab.url, locked.value, tab.id);
          if (Result.isError(unique)) return pageErr(unique.error);
          if (destination?.windowId !== undefined && duplicate.windowId !== destination.windowId) {
            if (!api.moveTab) return pageErr({ code: "page_failed" });
            const moved = await chromeResult(() =>
              dispatch(progress, "tab_move", () => api.moveTab!(tab.id!, destination.windowId!)),
            );
            if (Result.isError(moved)) return pageErr(moved.error);
            await progress?.placed?.();
          }
          const moved = await groupManagedTab(tab.id!, locked.value, progress);
          if (Result.isError(moved)) return pageErr(moved.error);
          tabsMoved++;
        }
        const remaining = await chromeResult(() => api.queryGroups!());
        if (Result.isError(remaining)) return pageErr(remaining.error);
        if (!remaining.value.some((group) => group.id === duplicate.id)) groupsRemoved++;
      }
      const saved = await saveGroupLock(locked.value);
      if (Result.isError(saved)) return pageErr(saved.error);
      const finalGroups = await chromeResult(() => api.queryGroups!());
      if (Result.isError(finalGroups)) return pageErr(finalGroups.error);
      return pageOk({
        groupsRemoved,
        tabsMoved,
        groupsRemaining: finalGroups.value.filter((group) => group.title === "mpctl").length,
      });
    },
    async findCurrentEditor(
      selection?: import("@mpctl/contracts").ArticleCurrentInput,
    ): Promise<PageManagerResult<PageBinding | undefined>> {
      if (groupId === undefined) {
        const restored = await this.restore();
        if (Result.isError(restored)) return pageErr(restored.error);
      }
      const group = groupId;
      if (group === undefined) return pageOk(undefined);
      const queried = await chromeResult(() => api.queryGroup(group));
      if (Result.isError(queried)) return pageErr(queried.error);
      const selected = (url: string | undefined) => {
        const route = classifyAppmsgUrl(url);
        return selection?.new
          ? route.kind === "new"
          : selection?.candidate
            ? route.kind === "saved-editor" && route.groupId === selection.candidate
            : isEditorPageUrl(url);
      };
      const tabs = queried.value.filter((tab) => !isEditorPageUrl(tab.url) || selected(tab.url));
      if (tabs.filter((tab) => isEditorPageUrl(tab.url)).length > 1)
        return pageErr({ code: "target_ambiguous" });
      const allowed = new Set(tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
      const matches: PageBinding[] = [];
      for (const [tabId, binding] of documents) {
        // A role/group mismatch is not evidence that this document binding is stale:
        // managed home and draft-list pages are navigation sources and must survive editor lookup.
        if (!allowed.has(binding.tabId) || !selected(binding.url)) continue;
        const current = await this.isCurrent(binding);
        if (Result.isError(current)) return pageErr(current.error);
        if (!current.value) {
          // Pending identity checks are not evidence of a stale document. Keep
          // their binding so the frame result/navigation commit can settle it.
          if (navigationPending.has(tabId) || frameCheckPending.has(tabId))
            return pageErr({ code: "target_unavailable" });
          if (documents.get(tabId) === binding) documents.delete(tabId);
          checkEditorWaits();
          continue;
        }
        matches.push(binding);
      }
      if (matches.length > 1) return pageErr({ code: "target_ambiguous" });
      if (matches.length === 0) {
        const editors = tabs.filter((tab) => isEditorPageUrl(tab.url));
        if (editors.length > 1) return pageErr({ code: "target_ambiguous" });
        const tab = editors[0];
        if (tab?.id !== undefined && api.getFrame) {
          const frameResult = await chromeResult(() =>
            api.getFrame!({ tabId: tab.id!, frameId: 0 }),
          );
          if (Result.isError(frameResult)) return pageErr(frameResult.error);
          const frame = frameResult.value;
          const initialRoute = classifyAppmsgUrl(tab.url ?? "");
          if (initialRoute.kind !== "saved-editor") return pageErr({ code: "target_unavailable" });
          const initialGroupId = initialRoute.groupId;
          if (
            frame?.documentId &&
            frame.url &&
            tab.url &&
            initialRoute.kind === "saved-editor" &&
            isSavedEditorForGroup(frame.url, initialGroupId) &&
            !invalidated.has(`${tab.id}:${frame.documentId}`) &&
            !navigationPending.has(tab.id) &&
            !frameCheckPending.has(tab.id)
          ) {
            const confirm = await chromeResult(() => api.getTab(tab.id!));
            if (Result.isError(confirm)) return pageErr(confirm.error);
            const confirmedFrame = await chromeResult(() =>
              api.getFrame!({ tabId: tab.id!, frameId: 0 }),
            );
            if (Result.isError(confirmedFrame)) return pageErr(confirmedFrame.error);
            if (
              confirm.value.url !== tab.url ||
              confirmedFrame.value?.documentId !== frame.documentId ||
              confirmedFrame.value.url !== frame.url ||
              !isEditorPageUrl(confirmedFrame.value.url) ||
              invalidated.has(`${tab.id}:${frame.documentId}`) ||
              navigationPending.has(tab.id) ||
              frameCheckPending.has(tab.id)
            )
              return pageErr({ code: "target_unavailable" });
            const census = await chromeResult(() => api.queryGroup(group));
            if (Result.isError(census)) return pageErr(census.error);
            const currentEditors = census.value.filter((candidate) => selected(candidate.url));
            if (currentEditors.length > 1) return pageErr({ code: "target_ambiguous" });
            if (currentEditors.length !== 1 || currentEditors[0]?.id !== tab.id)
              return pageErr({ code: "target_unavailable" });
            this.observe({ tabId: tab.id, documentId: frame.documentId, url: frame.url });
            const trusted = documents.get(tab.id);
            if (!trusted || trusted.documentId !== frame.documentId)
              return pageErr({ code: "target_unavailable" });
            const binding = trusted;
            const connected = await this.connectContent(binding);
            if (Result.isError(connected)) return pageErr(connected.error);
            const finalCensus = await chromeResult(() => api.queryGroup(group));
            if (Result.isError(finalCensus)) return pageErr(finalCensus.error);
            const finalEditors = finalCensus.value.filter((candidate) => selected(candidate.url));
            if (finalEditors.length > 1) return pageErr({ code: "target_ambiguous" });
            if (finalEditors.length !== 1 || finalEditors[0]?.id !== tab.id)
              return pageErr({ code: "target_unavailable" });
            const current = await this.isCurrent(binding);
            if (Result.isError(current)) return pageErr(current.error);
            if (!current.value) return pageErr({ code: "target_unavailable" });
            return pageOk(binding);
          }
        }
        if (tab) return pageErr({ code: "target_unavailable" });
      }
      return pageOk(matches[0]);
    },
    async findDraftList(): Promise<PageManagerResult<PageBinding | undefined>> {
      if (groupId === undefined) return pageOk(undefined);
      const queried = await chromeResult(() => api.queryGroup(groupId!));
      if (Result.isError(queried)) return pageErr(queried.error);
      const tabs = queried.value;
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        const binding = documents.get(tab.id);
        if (binding && classifyAppmsgUrl(binding.url).kind === "draft-list") {
          const current = await this.isCurrent(binding);
          if (Result.isError(current)) return pageErr(current.error);
          if (current.value) return pageOk(binding);
        }
      }
      return pageOk(undefined);
    },
    async findManagedHome(): Promise<PageManagerResult<PageBinding | undefined>> {
      const queried = api.queryMpTabs
        ? await chromeResult(() => api.queryMpTabs!())
        : groupId === undefined
          ? pageOk([])
          : await chromeResult(() => api.queryGroup(groupId!));
      if (Result.isError(queried)) return pageErr(queried.error);
      const mpTabs = queried.value;
      const mpTabIds = new Set(mpTabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
      const mpTabsById = new Map(
        mpTabs.flatMap((tab) => (tab.id === undefined ? [] : [[tab.id, tab] as const])),
      );
      const findReady = async (allowed: Set<number>): Promise<PageManagerResult<PageBinding[]>> => {
        const homes: PageBinding[] = [];
        for (const binding of documents.values()) {
          if (
            !allowed.has(binding.tabId) ||
            !mpTabIds.has(binding.tabId) ||
            !isHomePageUrl(binding.url) ||
            !sameFinalTabUrl(mpTabsById.get(binding.tabId)?.url, binding.url)
          )
            continue;
          const current = await this.isCurrent(binding);
          if (Result.isError(current)) return pageErr(current.error);
          if (!current.value) continue;
          const connected = await this.connectContent(binding);
          if (Result.isError(connected)) return pageErr(connected.error);
          const ready = await decodeRemote(homeIsReadyResultCodec, () =>
            connected.value.get(homePageToken).isReady(),
          );
          if (Result.isError(ready)) return pageErr(ready.error);
          if (ready.value) homes.push(binding);
        }
        return pageOk(homes);
      };
      const homes = await findReady(mpTabIds);
      if (Result.isError(homes)) return pageErr(homes.error);
      if (homes.value.length > 1) return navigationErr("source_ambiguous");
      return pageOk(homes.value[0]);
    },
    async ensureManagedHome(
      progress?: NavigationProgress,
    ): Promise<PageManagerResult<PageBinding>> {
      if (acquiringHome) return acquiringHome;
      const attempt = (async (): Promise<PageManagerResult<PageBinding>> => {
        let existing: PageBinding | undefined;
        let existingAmbiguous = false;
        const found = await this.findManagedHome();
        if (Result.isError(found)) {
          if (found.error.code !== "navigation_failed" || found.error.stage !== "source_ambiguous")
            return pageErr(found.error);
          existingAmbiguous = true;
        } else existing = found.value;
        if (existing) {
          progress?.sourceReady(existing);
          return pageOk(existing);
        }
        const group = await this.managedGroup(progress);
        if (Result.isError(group)) return pageErr(group.error);
        const saved = await chromeResult(() => api.getSession("managedHomeTabId"));
        if (Result.isError(saved)) return pageErr(saved.error);
        const savedHomeTabId = saved.value.managedHomeTabId;
        if (typeof savedHomeTabId === "number") {
          const tabsResult = api.queryMpTabs
            ? await chromeResult(() => api.queryMpTabs!())
            : await chromeResult(() => api.queryGroup(group.value));
          if (Result.isError(tabsResult)) return pageErr(tabsResult.error);
          const tabs = tabsResult.value;
          const owned = tabs.find((tab) => tab.id === savedHomeTabId);
          if (owned && classifyAppmsgUrl(owned.url).kind === "home") {
            const binding = documents.get(savedHomeTabId);
            const currentBinding = binding ? await this.isCurrent(binding) : pageOk(false);
            if (Result.isError(currentBinding)) return pageErr(currentBinding.error);
            if (
              binding &&
              isHomePageUrl(binding.url) &&
              sameFinalTabUrl(owned.url, binding.url) &&
              Result.isOk(currentBinding) &&
              currentBinding.value
            ) {
              const connected = await this.connectContent(binding);
              if (Result.isError(connected)) return pageErr(connected.error);
              const ready = await decodeRemote(homeIsReadyResultCodec, () =>
                connected.value.get(homePageToken).isReady(),
              );
              if (Result.isError(ready)) return pageErr(ready.error);
              if (ready.value) return pageOk(binding);
            }
            const reloaded = await reloadObservedSource(
              "home",
              group.value,
              savedHomeTabId,
              progress,
            );
            if (Result.isError(reloaded)) return pageErr(reloaded.error);
            if (reloaded.value !== undefined) {
              const reloadDeadline = Date.now() + 15_000;
              while (Date.now() < reloadDeadline) {
                const current = documents.get(savedHomeTabId);
                const isCurrent = current ? await this.isCurrent(current) : pageOk(false);
                if (Result.isError(isCurrent)) return pageErr(isCurrent.error);
                if (
                  current &&
                  isHomePageUrl(current.url) &&
                  Result.isOk(isCurrent) &&
                  isCurrent.value
                ) {
                  const connected = await this.connectContent(current);
                  if (Result.isError(connected)) return pageErr(connected.error);
                  const ready = await decodeRemote(homeIsReadyResultCodec, () =>
                    connected.value.get(homePageToken).isReady(),
                  );
                  if (Result.isError(ready)) return pageErr(ready.error);
                  if (ready.value) {
                    const status = await this.pageStatus(current);
                    if (Result.isError(status)) return pageErr(status.error);
                    const currentAfterStatus = await this.isCurrent(current);
                    if (Result.isError(currentAfterStatus))
                      return pageErr(currentAfterStatus.error);
                    if (status.value.state === "ready" && currentAfterStatus.value) {
                      progress?.sourceReady(current);
                      return pageOk(current);
                    }
                  }
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            }
          }
        }
        let existingHome: PageBinding | undefined;
        const foundHome = await this.findManagedHome();
        if (Result.isError(foundHome)) {
          if (
            foundHome.error.code !== "navigation_failed" ||
            foundHome.error.stage !== "source_ambiguous"
          )
            return pageErr(foundHome.error);
          existingAmbiguous = true;
        } else existingHome = foundHome.value;
        if (existingHome) {
          const grouped = await groupManagedTab(existingHome!.tabId, group.value, progress);
          if (Result.isError(grouped)) return pageErr(grouped.error);
          return pageOk(existingHome);
        }
        const mpTabsResult = api.queryMpTabs
          ? await chromeResult(() => api.queryMpTabs!())
          : await chromeResult(() => api.queryGroup(group.value));
        if (Result.isError(mpTabsResult)) return pageErr(mpTabsResult.error);
        const mpTabs = mpTabsResult.value;
        const homeTabs = mpTabs.filter(
          (tab) => tab.id !== undefined && classifyAppmsgUrl(tab.url).kind === "home",
        );
        existingAmbiguous ||= homeTabs.length > 1;
        if (!existingAmbiguous) {
          const reloadedHome = await reloadObservedSource("home", group.value, undefined, progress);
          if (Result.isError(reloadedHome)) return pageErr(reloadedHome.error);
          if (reloadedHome.value !== undefined) {
            const home = documents.get(reloadedHome.value);
            const status = home
              ? await this.pageStatus(home)
              : pageErr({ code: "target_unavailable" });
            if (Result.isError(status) && status.error.code !== "target_unavailable")
              return pageErr(status.error);
            const currentHome = home ? await this.isCurrent(home) : pageOk(false);
            if (Result.isError(currentHome)) return pageErr(currentHome.error);
            if (
              home &&
              isHomePageUrl(home.url) &&
              Result.isOk(status) &&
              status.value.state === "ready" &&
              Result.isOk(currentHome) &&
              currentHome.value
            ) {
              progress?.sourceReady(home);
              return pageOk(home);
            }
          }
        }
        const acquireOwnedRoot = async (): Promise<PageManagerResult<PageBinding>> => {
          const tabsResult = api.queryMpTabs
            ? await chromeResult(() => api.queryMpTabs!())
            : await chromeResult(() => api.queryGroup(group.value));
          if (Result.isError(tabsResult)) return pageErr(tabsResult.error);
          const tabs = tabsResult.value;
          let ownedTab =
            typeof savedHomeTabId === "number"
              ? tabs.find((tab) => tab.id === savedHomeTabId && isPublicRootUrl(tab.url))
              : tabs.find((tab) => tab.id === acquiringHomeTabId && isPublicRootUrl(tab.url));
          if (!ownedTab) {
            const created = await createManagedTab(
              "https://mp.weixin.qq.com/",
              true,
              group.value,
              undefined,
              progress,
            );
            if (Result.isError(created)) return pageErr(created.error);
            ownedTab = created.value;
            if (ownedTab.id === undefined) return navigationErr("site_root_timeout");
            acquiringHomeTabId = ownedTab.id;
            const savedHome = await chromeResult(() =>
              api.setSession({ managedHomeTabId: ownedTab!.id! }),
            );
            if (Result.isError(savedHome)) return pageErr(savedHome.error);
          }
          const ownedTabId = ownedTab.id!;
          const grouped = await groupManagedTab(ownedTabId, group.value, progress);
          if (Result.isError(grouped)) return pageErr(grouped.error);
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            const binding = documents.get(ownedTabId);
            const currentBinding = binding ? await this.isCurrent(binding) : pageOk(false);
            if (Result.isError(currentBinding)) return pageErr(currentBinding.error);
            if (
              binding &&
              isHomePageUrl(binding.url) &&
              Result.isOk(currentBinding) &&
              currentBinding.value
            ) {
              const connected = await this.connectContent(binding);
              if (Result.isError(connected)) return pageErr(connected.error);
              const ready = await decodeRemote(homeIsReadyResultCodec, () =>
                connected.value.get(homePageToken).isReady(),
              );
              if (Result.isError(ready)) return pageErr(ready.error);
              const afterReady = await this.isCurrent(binding);
              if (Result.isError(afterReady)) return pageErr(afterReady.error);
              if (ready.value && afterReady.value) {
                const status = await this.pageStatus(binding);
                if (Result.isError(status)) return pageErr(status.error);
                const currentAfterStatus = await this.isCurrent(binding);
                if (Result.isError(currentAfterStatus)) return pageErr(currentAfterStatus.error);
                if (status.value.state === "ready" && currentAfterStatus.value) {
                  progress?.sourceReady(binding);
                  return pageOk(binding);
                }
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return navigationErr("site_root_timeout");
        };
        return acquireOwnedRoot();
      })();
      acquiringHome = attempt;
      try {
        return await attempt;
      } finally {
        if (acquiringHome === attempt) {
          acquiringHome = undefined;
          acquiringHomeTabId = undefined;
        }
      }
    },
    async openFromManagedHome(
      action: "openDraftList" | "openNewEditor",
      expected: "draft-list" | "new",
      progress?: NavigationProgress,
    ): Promise<PageManagerResult<PageBinding>> {
      const homeResult = await this.ensureManagedHome(progress);
      if (Result.isError(homeResult)) return pageErr(homeResult.error);
      const home = homeResult.value;
      const group = await this.managedGroup(progress);
      if (Result.isError(group)) return pageErr(group.error);
      const mpTabsResult = api.queryMpTabs
        ? await chromeResult(() => api.queryMpTabs!())
        : await chromeResult(() => api.queryGroup(group.value));
      if (Result.isError(mpTabsResult)) return pageErr(mpTabsResult.error);
      const mpTabs = mpTabsResult.value;
      const baseline = new Set(mpTabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
      const connection = await this.connectContent(home);
      if (Result.isError(connection)) return pageErr(connection.error);
      let targetUrl: string | undefined;
      if (action === "openNewEditor") {
        const sourceTabsResult = api.queryAllTabs
          ? await chromeResult(() => api.queryAllTabs!())
          : pageOk(undefined);
        if (Result.isError(sourceTabsResult)) return pageErr(sourceTabsResult.error);
        const sourceTabs = sourceTabsResult.value;
        const homeBeforeCapture = await this.isCurrent(home);
        if (Result.isError(homeBeforeCapture)) return pageErr(homeBeforeCapture.error);
        if (!sourceTabs?.some((tab) => tab.id === home.tabId) || !homeBeforeCapture.value)
          return navigationErr("source_changed");
        if (!api.executeMain) return navigationErr("native_control_unavailable");
        const homeAtCapture = await this.isCurrent(home);
        if (Result.isError(homeAtCapture)) return pageErr(homeAtCapture.error);
        if (!homeAtCapture.value) return navigationErr("source_changed");
        const captureResult = await captureNative(
          home,
          captureNativeNewEditorUrl,
          undefined,
          progress,
        );
        if (Result.isError(captureResult)) return pageErr(captureResult.error);
        const capture = captureResult.value;
        const sourceTabsAfterResult = api.queryAllTabs
          ? await chromeResult(() => api.queryAllTabs!())
          : pageOk(undefined);
        if (Result.isError(sourceTabsAfterResult)) return pageErr(sourceTabsAfterResult.error);
        const sourceTabsAfterCapture = sourceTabsAfterResult.value;
        const homeAfterCapture = await this.isCurrent(home);
        if (Result.isError(homeAfterCapture)) return pageErr(homeAfterCapture.error);
        if (
          !sourceTabsAfterCapture?.some((tab) => tab.id === home.tabId) ||
          !homeAfterCapture.value
        )
          return navigationErr("source_changed");
        if (!capture?.hasKind) return navigationErr("native_target_missing");
        if (capture.kind === "control_unavailable")
          return navigationErr("native_control_unavailable");
        if (capture.kind === "ambiguous") return navigationErr("native_target_ambiguous");
        if (capture.kind === "unsupported") return navigationErr("native_target_unsupported");
        if (capture.kind !== "captured" || capture.url === undefined)
          return navigationErr("native_target_missing");
        targetUrl = capture.url;
      } else {
        const decoded = await decodeRemote(openDraftListResultCodec, () =>
          connection.value.get(homePageToken).openDraftList(),
        );
        if (Result.isError(decoded)) return pageErr(decoded.error);
        targetUrl = decoded.value;
      }
      const observedRoute = classifyAppmsgUrl(targetUrl);
      if (!targetUrl) return navigationErr("native_target_missing");
      const targetRoute = observedRoute;
      if (targetRoute.kind !== expected) return navigationErr("native_target_unsupported");
      const homeBeforeOpen = await this.isCurrent(home);
      if (Result.isError(homeBeforeOpen)) return pageErr(homeBeforeOpen.error);
      if (!homeBeforeOpen.value) return navigationErr("source_changed");
      const openedResult = await createManagedTab(targetUrl, true, group.value, home, progress);
      if (Result.isError(openedResult))
        return openedResult.error.code === "target_ambiguous" || openedResult.error.pageCreated
          ? pageErr(openedResult.error)
          : pageErr({
              ...openedResult.error,
              code: "navigation_failed",
              stage: "target_tab_create_failed",
            });
      const openedTab = openedResult.value;
      if (openedTab.id === undefined) return navigationErr("target_tab_create_failed");
      {
        const deadline = Date.now() + 15_000;
        let observedTarget = false;
        let firstTargetDocument: Pick<PageBinding, "documentId" | "routeRevision"> | undefined;
        while (Date.now() < deadline) {
          const matches = [...documents.values()].filter((binding) => {
            const isNativeTarget = binding.tabId === openedTab.id && !baseline.has(binding.tabId);
            return isNativeTarget && classifyAppmsgUrl(binding.url).kind === expected;
          });
          if (matches.length === 1) {
            observedTarget = true;
            const binding = matches[0]!;
            if (!firstTargetDocument) {
              firstTargetDocument = {
                documentId: binding.documentId,
                routeRevision: binding.routeRevision,
              };
            } else if (
              binding.documentId !== firstTargetDocument.documentId ||
              (binding.routeRevision ?? 0) !== (firstTargetDocument.routeRevision ?? 0)
            ) {
              return navigationErr("target_not_ready", true);
            }
            const targetCurrent = await this.isCurrent(binding);
            if (Result.isError(targetCurrent)) return pageErr(targetCurrent.error, true);
            if (!targetCurrent.value) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              continue;
            }
            if (expected === "new") await progress?.bound(binding);
            const statusResult = await this.pageStatus(binding);
            if (Result.isError(statusResult)) return pageErr(statusResult.error, true);
            const status = statusResult.value;
            if (status.state === "not_logged_in") {
              return pageErr({ code: "not_logged_in" }, true);
            }
            if (status.state === "ready") {
              const finalTabResult = await chromeResult(() => api.getTab(openedTab.id!));
              if (Result.isError(finalTabResult)) return pageErr(finalTabResult.error, true);
              const finalTab = finalTabResult.value;
              const latest = documents.get(openedTab.id);
              const currentAtReturn = await this.isCurrent(binding);
              if (Result.isError(currentAtReturn)) return pageErr(currentAtReturn.error, true);
              if (
                !latest ||
                latest.documentId !== firstTargetDocument.documentId ||
                (latest.routeRevision ?? 0) !== (firstTargetDocument.routeRevision ?? 0) ||
                !sameFinalTabUrl(targetUrl, binding.url) ||
                !sameFinalTabUrl(finalTab.url, binding.url) ||
                !currentAtReturn.value
              )
                return navigationErr("target_not_ready", true);
              {
                if (expected === "draft-list") progress?.sourceReady(binding);
                return pageOk(binding);
              }
            }
          }
          if (matches.length > 1) {
            return navigationErr("native_target_ambiguous", true);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return navigationErr(observedTarget ? "target_not_ready" : "target_not_observed", true);
      }
    },
    async listDraftGroups(
      binding: PageBinding,
    ): Promise<PageManagerResult<Array<{ groupId: string; title: string }>>> {
      const initialCurrent = await this.isCurrent(binding);
      if (Result.isError(initialCurrent)) return pageErr(initialCurrent.error);
      if (classifyAppmsgUrl(binding.url).kind !== "draft-list" || !initialCurrent.value)
        return pageErr({ code: "target_unavailable" });
      const statusResult = await this.pageStatus(binding);
      if (Result.isError(statusResult)) return pageErr(statusResult.error);
      const status = statusResult.value;
      const currentAfterStatus = await this.isCurrent(binding);
      if (Result.isError(currentAfterStatus)) return pageErr(currentAfterStatus.error);
      if (!currentAfterStatus.value) return pageErr({ code: "target_unavailable" });
      if (status.state === "not_logged_in") return pageErr({ code: "not_logged_in" });
      if (status.state !== "ready") return pageErr({ code: "page_failed" });
      let drafts: PageManagerResult<Array<{ candidate: string; title: string }>>;
      if (readDraftGroups) {
        const read = await Result.tryPromise({
          try: () => readDraftGroups(binding),
          catch: () => ({ code: "page_failed" as const }),
        });
        drafts = Result.isError(read) ? pageErr(read.error) : pageOk(read.value);
      } else {
        const connected = await this.connectContent(binding);
        if (Result.isError(connected)) return pageErr(connected.error);
        drafts = await decodeRemote(listDraftsResultCodec, () =>
          connected.value.get(draftPageToken).listDrafts(),
        );
      }
      if (Result.isError(drafts)) return pageErr(drafts.error);
      const currentAfterRead = await this.isCurrent(binding);
      if (Result.isError(currentAfterRead)) return pageErr(currentAfterRead.error);
      if (!currentAfterRead.value) return pageErr({ code: "target_unavailable" });
      const statusAfterRead = await this.pageStatus(binding);
      if (Result.isError(statusAfterRead)) return pageErr(statusAfterRead.error);
      const currentAfterStatusRead = await this.isCurrent(binding);
      if (Result.isError(currentAfterStatusRead)) return pageErr(currentAfterStatusRead.error);
      if (!currentAfterStatusRead.value) return pageErr({ code: "target_unavailable" });
      if (statusAfterRead.value.state === "not_logged_in")
        return pageErr({ code: "not_logged_in" });
      if (statusAfterRead.value.state !== "ready" || drafts.value.length === 0)
        return pageErr({ code: "page_failed" });
      return pageOk(drafts.value.map(({ candidate, title }) => ({ groupId: candidate, title })));
    },
    async openDraftGroup(
      binding: PageBinding,
      candidateId: string,
      progress?: NavigationProgress,
    ): Promise<PageManagerResult<PageBinding | undefined>> {
      binding = { ...binding };
      const key = `${binding.tabId}:${binding.documentId}:${candidateId}`;
      const pending = savedOpens.get(key);
      if (pending) return pending;
      const attempt = (async (): Promise<PageManagerResult<PageBinding | undefined>> => {
        const workspaceGroup = groupId;
        const revision = groupRevision;
        const source = await this.isCurrent(binding);
        if (Result.isError(source)) return pageErr(source.error);
        if (
          !source.value ||
          classifyAppmsgUrl(binding.url).kind !== "draft-list" ||
          groupId === undefined
        )
          return pageErr({ code: "target_unavailable" });
        const sourceUrl = await exactCurrent(binding);
        if (sourceUrl.isErr()) return sourceUrl;
        const candidates = await this.listDraftGroups(binding);
        if (Result.isError(candidates)) return pageErr(candidates.error);
        if (candidates.value.filter((draft) => draft.groupId === candidateId).length !== 1)
          return pageOk(undefined);
        const tabs = await chromeResult(() => api.queryGroup(groupId!));
        if (Result.isError(tabs)) return pageErr(tabs.error);
        const matches = tabs.value.filter((tab) =>
          isSavedEditorForGroup(tab.url ?? "", candidateId),
        );
        if (matches.length > 1) return pageErr({ code: "target_ambiguous" });
        let expired: PageBinding | undefined;
        if (matches.length === 1) {
          const existing = documents.get(matches[0]!.id!);
          if (!existing) return pageErr({ code: "target_unavailable" });
          const valid = await this.validateSavedArticle(existing, candidateId);
          if (valid.isErr() && valid.error.code !== "not_logged_in") return pageErr(valid.error);
          if (valid.isErr()) expired = { ...existing };
          else {
            const members = await chromeResult(() => api.queryGroup(groupId!));
            if (Result.isError(members)) return pageErr(members.error);
            const sameDraft = members.value.filter((tab) =>
              isSavedEditorForGroup(tab.url ?? "", candidateId),
            );
            if (sameDraft.length > 1) return pageErr({ code: "target_ambiguous" });
            const editorCurrent = await this.isCurrent(existing);
            if (Result.isError(editorCurrent)) return pageErr(editorCurrent.error);
            const sourceAfter = await this.isCurrent(binding);
            if (Result.isError(sourceAfter)) return pageErr(sourceAfter.error);
            if (
              valid.value.valid &&
              editorCurrent.value &&
              sameDraft[0]?.id === existing.tabId &&
              sourceAfter.value
            )
              await progress?.bound(existing);
            return valid.value.valid &&
              editorCurrent.value &&
              sameDraft[0]?.id === existing.tabId &&
              sourceAfter.value
              ? pageOk(existing)
              : pageErr({ code: "target_unavailable" });
          }
        }
        const currentBeforeCapture = await this.isCurrent(binding);
        if (Result.isError(currentBeforeCapture)) return pageErr(currentBeforeCapture.error);
        if (!currentBeforeCapture.value) return pageOk(undefined);
        if (expired) {
          const exactSource = await exactCurrent(binding);
          if (exactSource.isErr()) return exactSource;
          const readySource = await this.pageStatus(binding);
          if (readySource.isErr()) return readySource;
          if (
            readySource.value.state !== "ready" ||
            !readySource.value.documentReady ||
            !ownsExactDocument(binding)
          )
            return navigationErr("source_changed");
        }
        if (!api.executeMain) return navigationErr("native_control_unavailable");
        const captured = await captureNative(
          binding,
          captureNativeDraftEditorUrl,
          [candidateId],
          progress,
        );
        if (Result.isError(captured)) return pageErr(captured.error);
        const capture = captured.value;
        if (capture?.hasKind) {
          if (capture.kind === "control_unavailable")
            return navigationErr("native_control_unavailable");
          if (capture.kind === "ambiguous") return navigationErr("native_target_ambiguous");
        }
        const targetUrl = capture?.kind === "captured" ? capture.url : undefined;
        if (!targetUrl) return navigationErr("native_target_missing");
        if (expired && capture?.ended !== true) return navigationErr("native_target_missing");
        const route = classifyAppmsgUrl(targetUrl);
        if (route.kind === "unsupported") return navigationErr("native_target_unsupported");
        if (route.kind !== "saved-editor" || route.groupId !== candidateId)
          return navigationErr("native_target_missing");
        const currentAfterCapture = await this.isCurrent(binding);
        if (Result.isError(currentAfterCapture)) return pageErr(currentAfterCapture.error);
        if (!currentAfterCapture.value) return navigationErr("source_changed");
        if (expired) {
          if (
            groupId !== workspaceGroup ||
            groupRevision !== revision ||
            workspaceGroup === undefined
          )
            return navigationErr("source_changed");
          return navigateExpiredPage(binding, expired, targetUrl, workspaceGroup, progress);
        }
        if (!api.queryAllTabs) return pageOk(undefined);
        const baselineResult = await chromeResult(() => api.queryAllTabs!());
        if (Result.isError(baselineResult)) return pageErr(baselineResult.error);
        const baseline = baselineResult.value;
        const currentAfterBaseline = await this.isCurrent(binding);
        if (Result.isError(currentAfterBaseline)) return pageErr(currentAfterBaseline.error);
        if (!currentAfterBaseline.value) return pageOk(undefined);
        const tabIds = baseline.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
        if (tabIds.length !== baseline.length) return pageOk(undefined);
        const openedResult = await createManagedTab(targetUrl, true, groupId, binding, progress);
        if (Result.isError(openedResult))
          return openedResult.error.code === "target_ambiguous" || openedResult.error.pageCreated
            ? pageErr(openedResult.error)
            : pageErr({
                ...openedResult.error,
                code: "navigation_failed",
                stage: "target_tab_create_failed",
              });
        const opened = openedResult.value;
        if (opened.id === undefined || tabIds.includes(opened.id))
          return navigationErr("target_tab_create_failed");
        const target = {
          tabId: opened.id,
          url: targetUrl,
          ...(documents.get(opened.id)?.documentId
            ? {
                firstDocumentId: documents.get(opened.id)!.documentId,
                firstRouteRevision: documents.get(opened.id)!.routeRevision ?? 0,
              }
            : {}),
        };
        savedOpenTargets.add(target);
        try {
          const workspaceGroupResult = await this.managedGroup(progress);
          if (Result.isError(workspaceGroupResult)) {
            return pageErr(workspaceGroupResult.error, true);
          }
          const workspaceGroupId = workspaceGroupResult.value;
          return await waitForSavedEditor(target, workspaceGroupId, true, progress);
        } finally {
          savedOpenTargets.delete(target);
        }
      })();
      savedOpens.set(key, attempt);
      try {
        return await attempt;
      } finally {
        if (savedOpens.get(key) === attempt) savedOpens.delete(key);
      }
    },
    async validateSavedArticle(
      binding: PageBinding,
      groupId: string,
    ): Promise<PageManagerResult<{ valid: boolean; title: string }>> {
      const initialCurrent = await this.isCurrent(binding);
      if (Result.isError(initialCurrent)) return pageErr(initialCurrent.error);
      if (!initialCurrent.value) return pageOk({ valid: false, title: "" });
      const pageResult = await this.pageStatus(binding);
      if (Result.isError(pageResult)) return pageErr(pageResult.error);
      const page = pageResult.value;
      if (page.state === "not_logged_in") return pageErr({ code: "not_logged_in" });
      if (page.state !== "ready") return pageOk({ valid: false, title: "" });
      const connection = await this.connectContent(binding);
      if (Result.isError(connection)) return pageErr(connection.error);
      const draft = connection.value.safeGet(draftPageToken);
      if (Result.isError(draft))
        return pageErr({ code: "page_failed", observedFailure: observedFailure(draft.error) });
      const validated = await callPage(draft.value.validateDraft(groupId));
      if (Result.isError(validated))
        return pageErr({ code: "page_failed", observedFailure: observedFailure(validated.error) });
      const state = await decodePageReply(validateDraftResultCodec, validated.value);
      if (Result.isError(state)) return pageErr(state.error);
      const counted = await callPage(draft.value.currentItemCount());
      if (Result.isError(counted))
        return pageErr({ code: "page_failed", observedFailure: observedFailure(counted.error) });
      const count = await decodePageReply(currentItemCountResultCodec, counted.value);
      if (Result.isError(count)) return pageErr(count.error);
      const currentAfterRead = await this.isCurrent(binding);
      if (Result.isError(currentAfterRead)) return pageErr(currentAfterRead.error);
      if (!currentAfterRead.value) return pageOk({ valid: false, title: state.value.title });
      const status = await this.pageStatus(binding);
      if (Result.isError(status)) return pageErr(status.error);
      const currentAfterStatus = await this.isCurrent(binding);
      if (Result.isError(currentAfterStatus)) return pageErr(currentAfterStatus.error);
      if (!currentAfterStatus.value) return pageOk({ valid: false, title: state.value.title });
      if (status.value.state === "not_logged_in") return pageErr({ code: "not_logged_in" });
      if (status.value.state !== "ready") return pageOk({ valid: false, title: state.value.title });
      const route = classifyAppmsgUrl(binding.url);
      return pageOk({
        valid:
          state.value.valid &&
          count.value === 1 &&
          route.kind === "saved-editor" &&
          route.groupId === groupId,
        title: state.value.title,
      });
    },
    async getExecutionReceipt(
      target: OperationTarget,
      id: string,
      operation: "body" | "fields" | "upload" | "cover" | "save",
    ): Promise<
      BetterResult<
        BodyReceipt | FieldsReceipt | UploadReceipt | CoverReceipt | SaveReceipt | null,
        Failure
      >
    > {
      switch (operation) {
        case "body":
          return this.getBodyReceipt(target, id);
        case "fields":
          return this.getFieldsReceipt(target, id);
        case "upload":
          return this.getUploadReceipt(target, id);
        case "cover":
          return executionReceipt(target, id, coverReceiptResultCodec, (c) =>
            c.get(articleCoverPageToken, { callTimeout: 2_000 }).getReceipt(id),
          );
        case "save":
          return executionReceipt(target, id, saveReceiptResultCodec, (c) =>
            c.get(articleCoverPageToken, { callTimeout: 2_000 }).getReceipt(id),
          );
      }
    },
    async getBodyReceipt(
      target: OperationTarget,
      id: string,
    ): Promise<BetterResult<BodyReceipt | null, Failure>> {
      return executionReceipt(
        target,
        id,
        pageEditorReceiptResultCodec,
        (c) => c.get(pageEditorToken, { callTimeout: 2_000 }).getReceipt(id),
        true,
      );
    },
    async open(binding: PageBinding) {
      if (!isEditorPageUrl(binding.url)) return pageErr({ code: "target_unavailable" });
      const current = await this.isCurrent(binding);
      if (Result.isError(current)) return pageErr(current.error);
      if (!current.value) return pageErr({ code: "target_unavailable" });
      const deadline = Date.now() + 10_000;
      const connected = await Result.tryPromise({
        try: async () => {
          if (connectPage) return pageOk(await connectPage(binding));
          const connection = await connectStatus(binding);
          const ready = await waitForEditor(connection, binding, deadline);
          if (ready.isErr()) return pageErr(ready.error);
          if (!ownsCurrentDocument(binding)) return pageErr({ code: "target_unavailable" });
          if (
            connection.status !== "connected" ||
            !hasPreparationVersion(connection.contextMeta) ||
            !hasReadyEditor(connection.contextMeta)
          )
            return pageErr({
              code: "page_failed",
              readFailure: {
                stage: "page_acquire",
                kind: "runtime",
                causeCode: "editor_readiness_lost",
                component: "body",
              },
            });
          const acquired = connection.safeGet(pageEditorToken);
          if (acquired.isErr())
            return pageErr({
              code: "page_failed",
              observedFailure: observedFailure(acquired.error),
              readFailure: {
                stage: "page_acquire",
                ...observedFailure(acquired.error),
                component: "body",
              },
            });
          return pageOk(acquired.value);
        },
        catch: (error) => ({
          code: "page_failed" as const,
          observedFailure:
            error instanceof PageAdmissionError
              ? { kind: "protocol" as const, causeCode: "version_mismatch" }
              : observedFailure(error),
        }),
      });
      if (Result.isError(connected)) return pageErr(connected.error);
      if (connected.value.isErr()) return pageErr(connected.value.error);
      const editor = connected.value.value;
      const afterConnect = await this.isCurrent(binding);
      if (afterConnect.isErr()) return pageErr(afterConnect.error);
      if (!afterConnect.value) return pageErr({ code: "target_unavailable" });
      const session = editor.ready().connection;
      if (!hasPreparationVersion(session.contextMeta))
        return pageErr({
          code: "page_failed",
          observedFailure: { kind: "protocol", causeCode: "version_mismatch" },
        });
      if (!connectPage && (session.status !== "connected" || !hasReadyEditor(session.contextMeta)))
        return pageErr({
          code: "page_failed",
          readFailure: {
            stage: "page_acquire",
            kind: "runtime",
            causeCode: "editor_readiness_lost",
            component: "body",
          },
        });
      return pageOk({
        ready: () => decodeRemote(pageEditorReadyResultCodec, () => editor.ready(), "body"),
        getContent: () =>
          decodeRemote(pageEditorContentResultCodec, () => editor.getContent(), "body"),
        setContent: (
          html: string,
          expectedHash: string,
          execution: import("./page-contracts").BodyExecution,
        ) =>
          mutationReply(pageEditorWriteResultCodec, () =>
            editor.setContent(html, expectedHash, execution),
          ),
        setCoverFromBody: (input: BodyCoverExecution) =>
          mutationReply(coverWriteResultCodec, () => editor.setCoverFromBody(input)),
      });
    },
    async connectContent(binding: PageBinding): Promise<PageManagerResult<Connection>> {
      const current = await this.isCurrent(binding);
      if (Result.isError(current)) return pageErr(current.error);
      if (!current.value) return pageErr({ code: "target_unavailable" });
      const connected = await Result.tryPromise({
        try: () => connectStatus(binding),
        catch: (error) => ({
          code: "page_failed" as const,
          observedFailure:
            error instanceof PageAdmissionError
              ? { kind: "protocol" as const, causeCode: "version_mismatch" }
              : observedFailure(error),
        }),
      });
      if (Result.isError(connected)) return pageErr(connected.error);
      const afterConnect = await this.isCurrent(binding);
      if (afterConnect.isErr()) return pageErr(afterConnect.error);
      if (!afterConnect.value) return pageErr({ code: "target_unavailable" });
      if (!hasPreparationVersion(connected.value.contextMeta))
        return pageErr({
          code: "page_failed",
          observedFailure: { kind: "protocol", causeCode: "version_mismatch" },
        });
      return pageOk(connected.value);
    },
    async readArticleFields(
      binding: PageBinding,
    ): Promise<PageManagerResult<{ title: string; author: string; summary: string }>> {
      const connected = await this.connectContent(binding);
      if (Result.isError(connected)) return pageErr(connected.error);
      const acquired = connected.value.safeGet(articleFieldsToken);
      if (acquired.isErr())
        return pageErr({
          code: "page_failed",
          observedFailure: observedFailure(acquired.error),
          readFailure: {
            stage: "page_acquire",
            ...observedFailure(acquired.error),
            component: "fields",
          },
        });
      return decodeRemote(
        articleFieldsResultCodec,
        () => acquired.value.readArticleFields(),
        "fields",
      );
    },
    async readArticleCover(binding: PageBinding) {
      const connected = await this.connectContent(binding);
      if (Result.isError(connected)) return pageErr(connected.error);
      const acquired = connected.value.safeGet(articleCoverPageToken);
      if (acquired.isErr())
        return pageErr({
          code: "page_failed",
          observedFailure: observedFailure(acquired.error),
          readFailure: {
            stage: "page_acquire",
            ...observedFailure(acquired.error),
            component: "cover",
          },
        });
      return decodeRemote(articleCoverHashResultCodec, () => acquired.value.read(), "cover");
    },
    async coverIdentity(
      binding: PageBinding,
    ): Promise<BetterResult<{ executorId: string }, Failure>> {
      let at: NonNullable<Failure["cause"]>["at"] = "bg.page_connect";
      try {
        const connected = await this.connectContent(binding);
        if (connected.isErr()) return Result.err(materialBoundaryFailure(connected.error, at));
        at = "bg.page_acquire";
        const acquired = connected.value.safeGet(articleCoverPageToken);
        if (acquired.isErr()) return Result.err(materialBoundaryFailure(acquired.error, at));
        at = "bg.page_call";
        const response = await callPage(acquired.value.identity());
        if (response.isErr()) return Result.err(materialBoundaryFailure(response.error, at));
        at = "bg.page_decode";
        const decoded = await fieldsIdentityResultCodec.deserialize(response.value);
        return decoded.isErr() && decoded.error.code === "invalid_result_envelope"
          ? Result.err({
              code: "invalid_result_envelope",
              cause: { at, kind: "protocol", code: "invalid_result_envelope" },
            })
          : decoded;
      } catch (error) {
        return Result.err(materialBoundaryFailure(error, at));
      }
    },
    async setCoverFromBody(
      binding: PageBinding,
      input: BodyCoverExecution,
    ): Promise<BetterResult<CoverReceipt, MaterialCallFailure>> {
      try {
        const editor = await this.open(binding);
        if (editor.isErr())
          return Result.err({
            ...materialBoundaryFailure(editor.error, "bg.page_connect"),
            notInvoked: true,
          });
        return editor.value.setCoverFromBody(input);
      } catch (error) {
        return Result.err({
          ...materialBoundaryFailure(error, "bg.page_connect"),
          notInvoked: true,
        });
      }
    },
    async setArticleCover(
      binding: PageBinding,
      candidate: { filename: string; thumbnailUrl: string },
      expectedHash: string,
      execution: CoverExecution,
    ): Promise<BetterResult<CoverReceipt, MaterialCallFailure>> {
      let at: NonNullable<Failure["cause"]>["at"] = "bg.page_connect";
      let invoked = false;
      let receipt: BetterResult<CoverReceipt, MaterialCallFailure> | undefined;
      const boundary = (error: unknown): MaterialCallFailure => ({
        ...materialBoundaryFailure(error, at),
        ...(!invoked ? { notInvoked: true as const } : {}),
      });
      try {
        const connected = await this.connectContent(binding);
        if (connected.isErr()) return Result.err(boundary(connected.error));
        at = "bg.page_acquire";
        const acquired = connected.value.safeGet(articleCoverPageToken, { callTimeout: 25_000 });
        if (acquired.isErr()) return Result.err(boundary(acquired.error));
        const coverPage = acquired.value;
        const guard = async (): Promise<BetterResult<void, { code: string }>> => {
          const current = await this.isCurrent(binding);
          if (current.isErr() || !current.value) return Result.err({ code: "target_unavailable" });
          const group = await this.managedGroup();
          if (group.isErr()) return Result.err({ code: "target_unavailable" });
          const membership = await chromeResult(() => api.queryGroup(group.value));
          if (membership.isErr() || !membership.value.some((tab) => tab.id === binding.tabId))
            return Result.err({ code: "target_unavailable" });
          const route = classifyAppmsgUrl(binding.url);
          if (route.kind === "saved-editor") {
            const saved = await this.validateSavedArticle(binding, route.groupId);
            if (saved.isErr() || !saved.value.valid)
              return Result.err({ code: "target_unavailable" });
          }
          const final = await this.isCurrent(binding);
          return final.isOk() && final.value
            ? Result.ok(undefined)
            : Result.err({ code: "target_unavailable" });
        };
        const checked = await guard();
        if (checked.isErr()) return Result.err(boundary(checked.error));
        at = "bg.page_call";
        const called = await callPage(coverPage.set(candidate, expectedHash, execution), () => {
          invoked = true;
        });
        if (called.isErr()) return Result.err(boundary(called.error));
        at = "bg.page_decode";
        receipt = await coverWriteResultCodec.deserialize(called.value);
        if (receipt.isErr() && receipt.error.code === "invalid_result_envelope")
          return Result.err({
            code: "invalid_result_envelope",
            cause: { at, kind: "protocol", code: "invalid_result_envelope" },
          });
        return receipt;
      } catch (error) {
        return receipt ?? Result.err(boundary(error));
      }
    },
    async saveArticle(
      binding: PageBinding,
      execution: SaveExecution,
    ): Promise<BetterResult<SaveReceipt, MaterialCallFailure>> {
      try {
        const connected = await this.connectContent(binding);
        if (connected.isErr())
          return Result.err({
            ...materialBoundaryFailure(connected.error, "bg.page_connect"),
            notInvoked: true,
          });
        const group = await this.managedGroup();
        if (group.isErr())
          return Result.err({
            ...materialBoundaryFailure(group.error, "bg.page_connect"),
            notInvoked: true,
          });
        const unique = await uniquePlacement(binding.url, group.value, binding.tabId);
        if (unique.isErr())
          return Result.err({
            ...materialBoundaryFailure(unique.error, "bg.page_connect"),
            notInvoked: true,
          });
        return mutationReply(
          saveWriteResultCodec,
          () => {
            const acquired = connected.value.safeGet(articleCoverPageToken, {
              callTimeout: 25_000,
            });
            if (acquired.isErr()) throw acquired.error;
            return acquired.value.save(execution);
          },
          25_000,
        );
      } catch (error) {
        return Result.err({
          ...materialBoundaryFailure(error, "bg.page_connect"),
          notInvoked: true,
        });
      }
    },
    async resolveImage(
      binding: PageBinding,
      candidate: { filename: string; thumbnailUrl: string },
    ) {
      const connected = await this.connectContent(binding);
      if (connected.isErr()) return connected;
      return decodeRemote(assetImagePageResultCodec, () =>
        connected.value.get(pageEditorToken).resolveImage(candidate),
      );
    },
    async listMaterials(binding: PageBinding, onInvoke?: () => void) {
      const connected = await this.connectContent(binding);
      if (Result.isError(connected)) return pageErr({ ...connected.error, ended: true });
      return decodeRemote(
        materialListResultCodec,
        () => connected.value.get(materialPageToken).list(),
        undefined,
        onInvoke,
      );
    },
    async uploadMaterial(
      binding: PageBinding,
      payload: import("@mpctl/contracts").AssetPayload,
      execution: import("./background-contracts").UploadExecution,
    ): Promise<BetterResult<UploadReceipt, MaterialCallFailure>> {
      try {
        const connected = await this.connectContent(binding);
        if (connected.isErr())
          return Result.err({
            ...materialBoundaryFailure(connected.error, "bg.page_connect"),
            notInvoked: true,
          });
        return mutationReply(
          materialUploadResultCodec,
          () => {
            const acquired = connected.value.safeGet(materialPageToken, {
              callTimeout: assetUploadTimeouts.page,
            });
            if (acquired.isErr()) throw acquired.error;
            return acquired.value.upload(payload, execution);
          },
          assetUploadTimeouts.page,
        );
      } catch (error) {
        return Result.err({
          ...materialBoundaryFailure(error, "bg.page_connect"),
          notInvoked: true,
        });
      }
    },
    async materialIdentity(
      binding: PageBinding,
    ): Promise<BetterResult<{ executorId: string }, Failure>> {
      let at: NonNullable<Failure["cause"]>["at"] = "bg.page_connect";
      try {
        const connected = await this.connectContent(binding);
        if (connected.isErr()) return Result.err(materialBoundaryFailure(connected.error, at));
        at = "bg.page_acquire";
        const acquired = connected.value.safeGet(materialPageToken);
        if (acquired.isErr()) return Result.err(materialBoundaryFailure(acquired.error, at));
        at = "bg.page_call";
        const called = await callPage(acquired.value.identity());
        if (called.isErr()) return Result.err(materialBoundaryFailure(called.error, at));
        at = "bg.page_decode";
        try {
          const decoded = await materialIdentityResultCodec.deserialize(called.value);
          return decoded.isErr() && decoded.error.code === "invalid_result_envelope"
            ? Result.err({
                code: "invalid_result_envelope",
                cause: { at, kind: "protocol", code: "invalid_result_envelope" },
              })
            : decoded;
        } catch {
          return Result.err({
            code: "invalid_result_envelope",
            cause: { at, kind: "protocol", code: "invalid_result_envelope" },
          });
        }
      } catch (error) {
        return Result.err(materialBoundaryFailure(error, at));
      }
    },
    async getUploadReceipt(
      target: OperationTarget,
      id: string,
    ): Promise<BetterResult<UploadReceipt | null, Failure>> {
      return executionReceipt(target, id, uploadReceiptResultCodec, (c) =>
        c.get(materialPageToken, { callTimeout: 2_000 }).getReceipt(id),
      );
    },
    async fieldsIdentity(
      binding: PageBinding,
    ): Promise<BetterResult<{ executorId: string }, Failure>> {
      try {
        const connected = await this.connectContent(binding);
        if (connected.isErr()) return Result.err({ code: "target_unavailable" });
        const acquired = connected.value.safeGet(articleFieldsToken);
        if (acquired.isErr()) return Result.err({ code: "receipt_unreachable" });
        const called = await callPage(acquired.value.identity());
        return called.isErr()
          ? Result.err({ code: "receipt_unreachable" })
          : fieldsIdentityResultCodec.deserialize(called.value);
      } catch {
        return Result.err({ code: "receipt_unreachable" });
      }
    },
    async getFieldsReceipt(
      target: OperationTarget,
      id: string,
    ): Promise<BetterResult<FieldsReceipt | null, Failure>> {
      return executionReceipt(target, id, fieldsReceiptResultCodec, (c) =>
        c.get(articleFieldsToken, { callTimeout: 2_000 }).getReceipt(id),
      );
    },
    async updateArticleFields(
      binding: PageBinding,
      fields: { title?: string; author?: string; summary?: string },
      expectedHash: string,
      execution: FieldsExecution,
    ): Promise<BetterResult<FieldsReceipt, MaterialCallFailure>> {
      try {
        const connected = await this.connectContent(binding);
        if (connected.isErr())
          return Result.err({
            ...materialBoundaryFailure(connected.error, "bg.page_connect"),
            notInvoked: true,
          });
        return mutationReply(articleFieldUpdateResultCodec, () => {
          const acquired = connected.value.safeGet(articleFieldsToken);
          if (acquired.isErr()) throw acquired.error;
          return acquired.value.updateArticleFields(fields, expectedHash, execution);
        });
      } catch (error) {
        return Result.err({
          ...materialBoundaryFailure(error, "bg.page_connect"),
          notInvoked: true,
        });
      }
    },
    async pageStatus(binding: PageBinding): Promise<
      PageManagerResult<{
        state: "ready" | "not_logged_in" | "loading";
        route: string;
        documentReady: boolean;
      }>
    > {
      const initialCurrent = await this.isCurrent(binding);
      if (Result.isError(initialCurrent)) return pageErr(initialCurrent.error);
      if (!initialCurrent.value)
        return pageOk({ state: "loading", route: "unsupported", documentReady: false });
      let result: PageManagerResult<{
        state: "ready" | "not_logged_in" | "loading";
        route: string;
        documentReady: boolean;
      }>;
      if (readPageStatus) {
        const read = await Result.tryPromise({
          try: () => readPageStatus(binding),
          catch: (error) => ({
            code: "page_failed" as const,
            observedFailure: observedFailure(error),
          }),
        });
        result = Result.isError(read) ? pageErr(read.error) : pageOk(read.value);
      } else {
        const connected = await this.connectContent(binding);
        if (Result.isError(connected)) return pageErr(connected.error);
        const status = connected.value.safeGet(contentStatusToken);
        if (Result.isError(status))
          return pageErr({ code: "page_failed", observedFailure: observedFailure(status.error) });
        const invoked = await callPage(status.value.status());
        if (Result.isError(invoked))
          return pageErr({ code: "page_failed", observedFailure: observedFailure(invoked.error) });
        result = await decodePageReply(contentStatusResultCodec, invoked.value);
      }
      if (Result.isError(result)) return pageErr(result.error);
      const currentAfterStatus = await this.isCurrent(binding);
      if (Result.isError(currentAfterStatus)) return pageErr(currentAfterStatus.error);
      if (!currentAfterStatus.value)
        return pageOk({ state: "loading", route: "unsupported", documentReady: false });
      if (result.value.route !== appmsgRouteIdentity(binding.url))
        return pageOk({
          state: "loading",
          route: result.value.route,
          documentReady: result.value.documentReady,
        });
      return pageOk(result.value);
    },
    async isCurrent(binding: PageBinding): Promise<PageManagerResult<boolean>> {
      if (!ownsCurrentDocument(binding)) return pageOk(false);
      const tabResult = await chromeResult(() => api.getTab(binding.tabId));
      if (Result.isError(tabResult)) {
        const latestAfterFailure = documents.get(binding.tabId);
        const observedRouteAfterFailure = appmsgRouteIdentity(latestAfterFailure?.url);
        const bindingRoute = appmsgRouteIdentity(binding.url);
        if (
          !ownsCurrentDocument(binding) ||
          !bindingRoute ||
          observedRouteAfterFailure !== bindingRoute
        )
          return pageOk(false);
        return pageErr(tabResult.error);
      }
      const tab = tabResult.value;
      const latest = documents.get(binding.tabId);
      if (!ownsCurrentDocument(binding)) return pageOk(false);
      const observedRoute = appmsgRouteIdentity(latest?.url);
      const bindingRoute = appmsgRouteIdentity(binding.url);
      const currentRoute = appmsgRouteIdentity(tab?.url);
      return pageOk(
        Boolean(
          observedRoute &&
          bindingRoute &&
          currentRoute &&
          observedRoute === bindingRoute &&
          currentRoute === bindingRoute,
        ),
      );
    },
    dispose() {
      documents.clear();
      checkEditorWaits();
    },
  };
  return manager;
}

async function connectChromeStatus(binding: PageBinding): Promise<Connection> {
  const connected = await backgroundNexus.safeConnect({
    target: chromeTarget.contentDocument({
      tabId: binding.tabId,
      documentId: binding.documentId,
    }),
    timeout: 1_000,
  });
  if (Result.isError(connected)) throw connected.error;
  if (!hasPreparationVersion(connected.value.contextMeta)) throw new PageAdmissionError();
  return connected.value;
}

class PageAdmissionError extends Error {}

function isExactMissingGroupError(error: unknown, id?: number): boolean {
  if (!(error instanceof Error)) return false;
  const match = /^No group with id: (\d+)(?:\.)?$/.exec(error.message);
  return Boolean(match && (id === undefined || Number(match[1]) === id));
}

function missingGroupId(error: unknown): number {
  return error instanceof Error ? Number(/^No group with id: (\d+)/.exec(error.message)?.[1]) : NaN;
}

function sameFinalTabUrl(currentValue: string | undefined, bindingValue: string): boolean {
  if (!currentValue) return false;
  try {
    const current = new URL(currentValue);
    const binding = new URL(bindingValue);
    if (
      current.origin !== binding.origin ||
      current.pathname !== binding.pathname ||
      current.hash !== binding.hash ||
      appmsgRouteIdentity(current.href) !== appmsgRouteIdentity(binding.href)
    )
      return false;
    const withoutTimestamp = (params: URLSearchParams) => {
      const entries = [...params.entries()].filter(([key]) => key !== "timestamp");
      return entries.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey === rightKey
          ? leftValue.localeCompare(rightValue)
          : leftKey.localeCompare(rightKey),
      );
    };
    return (
      JSON.stringify(withoutTimestamp(current.searchParams)) ===
      JSON.stringify(withoutTimestamp(binding.searchParams))
    );
  } catch {
    return false;
  }
}
