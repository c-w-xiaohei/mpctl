import { chromeTarget } from "@nexus-js/chrome";
import { type Connection } from "@nexus-js/core";
import { Result, type Result as BetterResult } from "better-result";
import { type ArticleNavigationStage } from "@mpctl/contracts";
import { backgroundNexus } from "./background-runtime";

import { pageEditorToken, type PageEditorService } from "./page-contracts";
import { contentStatusToken, draftPageToken, homePageToken } from "./background-contracts";
import {
  contentStatusResultCodec,
  currentItemCountResultCodec,
  homeIsReadyResultCodec,
  listDraftsResultCodec,
  openDraftListResultCodec,
  validateDraftResultCodec,
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

export type NativeTargetCapture =
  | { kind: "captured"; url: string }
  | { kind: "ambiguous" | "unavailable" | "unsupported" | "control_unavailable" };

async function decodeRemote<T>(
  codec: {
    deserialize(value: unknown): Promise<import("better-result").Result<T, { code: string }>>;
  },
  operation: () => unknown,
): Promise<PageManagerResult<T>> {
  const remote = await Result.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: () => ({ code: "page_failed" as const }),
  });
  if (Result.isError(remote)) return pageErr(remote.error);
  const decoded = await codec.deserialize(remote.value);
  if (Result.isError(decoded)) {
    if (decoded.error.code === "invalid_result_envelope")
      return pageErr({ code: "invalid_result_envelope" });
    if (decoded.error.code === "route_changed" || decoded.error.code === "target_unavailable")
      return pageErr({ code: "target_unavailable" });
    if (decoded.error.code === "not_logged_in") return pageErr({ code: "not_logged_in" });
    return pageErr({ code: "page_failed" });
  }
  return pageOk(decoded.value);
}

/** Capture only one supported URL actually produced by the site's native Article control. */
export async function captureNativeNewEditorUrl(_unused?: string): Promise<NativeTargetCapture> {
  const page = window;
  const originalOpen = page.open;
  const captured: string[] = [];
  let lastCapturedAt = 0;
  let unsupportedTarget = false;
  page.open = ((url?: string | URL | null, target?: string, features?: string) => {
    if (url != null) {
      try {
        const candidate = new URL(String(url), document.location.href);
        if (
          candidate.origin === "https://mp.weixin.qq.com" &&
          candidate.pathname === "/cgi-bin/appmsg"
        ) {
          if (
            candidate.searchParams.get("t") === "media/appmsg_edit_v2" &&
            candidate.searchParams.get("action") === "edit" &&
            candidate.searchParams.get("isNew") === "1" &&
            candidate.searchParams.get("type") === "77"
          ) {
            captured.push(candidate.href);
            lastCapturedAt = Date.now();
          } else {
            unsupportedTarget = true;
          }
          return null;
        }
      } catch {
        // Ignore malformed or unsupported popup targets and fail closed below.
      }
    }
    return url == null
      ? originalOpen.call(page, undefined, target, features)
      : originalOpen.call(page, url, target, features);
  }) as typeof window.open;
  try {
    const controls = [
      ...document.querySelectorAll<HTMLElement>("div.new-creation__menu-item"),
    ].filter((element) => {
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      return (
        element.textContent?.trim() === "文章" &&
        !element.hidden &&
        style?.display !== "none" &&
        style?.visibility !== "hidden" &&
        element.getClientRects().length > 0
      );
    });
    if (controls.length !== 1) return { kind: "control_unavailable" };
    controls[0]!.click();
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline && (captured.length === 0 || Date.now() - lastCapturedAt < 400))
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (captured.length > 1) return { kind: "ambiguous" };
    if (captured.length === 0 && unsupportedTarget) return { kind: "unsupported" };
    return captured.length === 1
      ? { kind: "captured", url: captured[0]! }
      : { kind: "unavailable" };
  } finally {
    page.open = originalOpen;
  }
}

export async function captureNativeDraftEditorUrl(
  candidateId: string,
): Promise<NativeTargetCapture> {
  const cards = [
    ...document.querySelectorAll<HTMLElement>(".weui-desktop-card[data-appid]"),
  ].filter((card) => card.getAttribute("data-appid") === candidateId);
  if (cards.length !== 1) return { kind: "control_unavailable" };
  const card = cards[0]!;
  const cardStyle = card.ownerDocument.defaultView?.getComputedStyle(card);
  if (
    card.hidden ||
    card.getAttribute("aria-hidden") === "true" ||
    cardStyle?.display === "none" ||
    cardStyle?.visibility === "hidden" ||
    card.getClientRects().length === 0
  )
    return { kind: "control_unavailable" };
  const link = cards[0]!.querySelector<HTMLAnchorElement>(
    ".weui-desktop-tooltip__wrp.weui-desktop-link a",
  );
  if (!link) return { kind: "control_unavailable" };
  const validateTarget = (value: string | URL | undefined): string | undefined => {
    if (value === undefined) return undefined;
    try {
      const observed = new URL(String(value), document.location.href);
      if (
        observed.origin === "https://mp.weixin.qq.com" &&
        observed.pathname === "/cgi-bin/appmsg" &&
        observed.searchParams.get("t") === "media/appmsg_edit" &&
        observed.searchParams.get("action") === "edit" &&
        observed.searchParams.get("type") === "77" &&
        observed.searchParams.get("appmsgid") === candidateId
      )
        return observed.href;
    } catch {
      // Ignore malformed handler output and fail closed below.
    }
    return undefined;
  };
  const candidateIsCurrent = () => {
    const currentCards = [
      ...document.querySelectorAll<HTMLElement>(".weui-desktop-card[data-appid]"),
    ].filter((card) => card.getAttribute("data-appid") === candidateId);
    return currentCards.length === 1 && currentCards[0] === cards[0];
  };
  const initialHref = validateTarget(link.href);
  if (initialHref) return { kind: "captured", url: initialHref };
  // A visible draft card owns its hover-only toolbar; reveal the native Edit control.
  const linkStyle = link.ownerDocument.defaultView?.getComputedStyle(link);
  if (
    linkStyle?.display === "none" ||
    linkStyle?.visibility === "hidden" ||
    link.getClientRects().length === 0
  ) {
    card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    card.dispatchEvent(new MouseEvent("mouseenter"));
  }
  const targetIdentity = (value: string) => {
    const url = new URL(value);
    url.searchParams.delete("timestamp");
    url.searchParams.sort();
    return url.href;
  };
  let observedHref: string | undefined;
  const page = window as Window & { open: typeof window.open };
  const originalOpen = page.open;
  let captured: string | undefined;
  let ambiguousCapture = false;
  page.open = function (url?: string | URL, targetName?: string, features?: string) {
    if (url !== undefined && url !== null) {
      const target = validateTarget(url);
      if (target && captured !== undefined && targetIdentity(target) !== targetIdentity(captured))
        ambiguousCapture = true;
      else if (target) captured = target;
      else return originalOpen.call(page, url, targetName, features);
    }
    return null;
  } as typeof window.open;
  const preventSourceNavigation = (event: MouseEvent) => event.preventDefault();
  link.addEventListener("click", preventSourceNavigation, true);
  try {
    link.click();
    const deadline = Date.now() + 1_500;
    let lastChange = Date.now();
    let priorHref = link.href;
    let sawNativeResult = false;
    while (Date.now() < deadline) {
      if (!candidateIsCurrent()) return { kind: "control_unavailable" };
      if (link.href !== priorHref) {
        priorHref = link.href;
        lastChange = Date.now();
        const target = validateTarget(priorHref);
        if (target) {
          sawNativeResult = true;
          observedHref = target;
        }
      }
      if (ambiguousCapture) return { kind: "ambiguous" };
      if (Date.now() - lastChange >= 400) {
        if (observedHref && captured && targetIdentity(observedHref) !== targetIdentity(captured))
          return { kind: "ambiguous" };
        if (sawNativeResult && observedHref) return { kind: "captured", url: observedHref };
        if (captured) return { kind: "captured", url: captured };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (ambiguousCapture) return { kind: "ambiguous" };
    if (observedHref && captured && targetIdentity(observedHref) !== targetIdentity(captured))
      return { kind: "ambiguous" };
    const url = sawNativeResult ? observedHref : captured;
    return url ? { kind: "captured", url } : { kind: "unavailable" };
  } finally {
    link.removeEventListener("click", preventSourceNavigation, true);
    page.open = originalOpen;
  }
}

export type PageBinding = {
  tabId: number;
  documentId: string;
  url: string;
  routeRevision?: number;
};
type PageManagerErrorDetails =
  | { code: "page_failed" }
  | { code: "target_unavailable" }
  | { code: "target_ambiguous" }
  | { code: "not_logged_in" }
  | { code: "invalid_result_envelope" }
  | { code: "missing_group"; groupId: number }
  | { code: "navigation_failed"; stage: ArticleNavigationStage };
export type PageManagerError = PageManagerErrorDetails & { pageCreated?: boolean };
export type PageManagerResult<T> = BetterResult<T, PageManagerError>;

const pageOk = <T>(value: T): PageManagerResult<T> => Result.ok(value);
const pageErr = <T = never>(error: PageManagerError, pageCreated = false): PageManagerResult<T> =>
  Result.err({ ...error, ...(pageCreated ? { pageCreated: true } : {}) });
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
        : { code: "page_failed" as const },
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
  moveTab?(id: number, windowId: number): Promise<void>;
  getLocal?(key: string): Promise<Record<string, unknown>>;
  setLocal?(values: Record<string, unknown>): Promise<void>;
  getSession(key?: string | null): Promise<Record<string, unknown>>;
  setSession(values: Record<string, unknown>): Promise<void>;
  removeSession(key: string): Promise<void>;
  onTabUpdated?(listener: (tabId: number, status: "loading" | "complete") => void): void;
  onTabRemoved?(listener: (tabId: number) => void): void;
  getFrame?(details: { tabId: number; frameId: number }): Promise<{ documentId?: string } | null>;
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
  removeSession: async (key) => {
    await chrome.storage.session.remove(key);
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
  connectPage: (
    binding: PageBinding,
  ) => Promise<PageEditorService | PageEditorServiceRemote> = connectChromePage,
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
  const sessionQueues = new Map<number, Promise<PageManagerResult<void>>>();
  const sessionRevisions = new Map<number, number>();
  const savedOpenTargets = new Set<{
    tabId: number;
    url: string;
    firstDocumentId?: string;
    firstRouteRevision?: number;
  }>();
  const nativeCaptureQueues = new Map<number, Promise<void>>();
  async function captureNative(
    binding: PageBinding,
    func: (...args: string[]) => unknown,
    args?: string[],
  ): Promise<PageManagerResult<unknown[]>> {
    const previous = nativeCaptureQueues.get(binding.tabId);
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous ? previous.then(() => lock) : lock;
    nativeCaptureQueues.set(binding.tabId, queued);
    let result: PageManagerResult<unknown[]>;
    try {
      await previous;
      const current = await manager.isCurrent(binding);
      if (Result.isError(current)) result = pageErr(current.error);
      else if (!current.value) result = navigationErr("source_changed");
      else if (!api.executeMain) result = navigationErr("native_control_unavailable");
      else
        result = await Result.tryPromise({
          try: () => api.executeMain!({ tabId: binding.tabId, func, ...(args ? { args } : {}) }),
          catch: () => ({ code: "page_failed" as const }),
        }).then((capture) =>
          Result.isError(capture) ? pageErr(capture.error) : pageOk(capture.value),
        );
    } finally {
      release();
      if (nativeCaptureQueues.get(binding.tabId) === queued)
        nativeCaptureQueues.delete(binding.tabId);
    }
    return result!;
  }
  const sourceReloads = new Map<string, Promise<PageManagerResult<number | undefined>>>();
  const queueSession = (
    tabId: number,
    operation: () => Promise<PageManagerResult<void>>,
    isCurrent: () => boolean = () => true,
  ) => {
    const previous = sessionQueues.get(tabId) ?? Promise.resolve(pageOk(undefined));
    const queued = previous.then(async () => {
      if (!isCurrent()) return pageOk(undefined);
      const completed = await Result.tryPromise({
        try: () => Promise.resolve(operation()),
        catch: () => ({ code: "page_failed" as const }),
      });
      return Result.isError(completed) ? pageErr(completed.error) : completed.value;
    });
    sessionQueues.set(tabId, queued);
    void queued.then(
      (result) => {
        if (Result.isError(result))
          console.debug("mpctl.pages.session_hint_write", {
            result: "error",
            code: result.error.code,
          });
        if (sessionQueues.get(tabId) === queued) sessionQueues.delete(tabId);
      },
      () => {
        if (sessionQueues.get(tabId) === queued) sessionQueues.delete(tabId);
      },
    );
  };
  const nextSessionRevision = (tabId: number) => {
    const revision = (sessionRevisions.get(tabId) ?? 0) + 1;
    sessionRevisions.set(tabId, revision);
    return revision;
  };
  const removeDocumentHint = (tabId: number) => {
    nextSessionRevision(tabId);
    queueSession(tabId, async () => chromeResult(() => api.removeSession(`document:${tabId}`)));
  };
  const removeHintFromRestore = (tabId: number, revision: number) =>
    queueSession(
      tabId,
      async () => chromeResult(() => api.removeSession(`document:${tabId}`)),
      () => (sessionRevisions.get(tabId) ?? 0) === revision,
    );
  api.onBeforeNavigate?.(({ tabId, frameId }) => {
    if (frameId !== 0) return;
    const navigationId = (navigationPending.get(tabId) ?? 0) + 1;
    navigationPending.set(tabId, navigationId);
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
      removeDocumentHint(tabId);
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
    frameCheckPending.delete(tabId);
    frameCheckErrors.set(tabId, { documentId: binding.documentId, error });
    removeDocumentHint(tabId);
    console.debug("mpctl.pages.frame_check", { result: "error", code: error.code });
  };
  api.onTabUpdated?.((tabId, status) => {
    if (status !== "loading") return;
    const current = documents.get(tabId);
    if (!current) return;
    const checkId = (frameChecks.get(tabId) ?? 0) + 1;
    frameChecks.set(tabId, checkId);
    frameCheckPending.add(tabId);
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
    const current = documents.get(tabId);
    if (current) {
      invalidated.add(`${current.tabId}:${current.documentId}`);
    }
    documents.delete(tabId);
    navigationPending.delete(tabId);
    navigationStartDocument.delete(tabId);
    navigationCommit.delete(tabId);
    frameCheckPending.delete(tabId);
    frameChecks.delete(tabId);
    removeDocumentHint(tabId);
  });
  const resolveManagedGroup = async (): Promise<PageManagerResult<number>> => {
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
        return recoverManagedGroup();
      }
      if (!candidate.updated) {
        const updated = await chromeResult(() => api.updateGroup(candidate.id, { title: "mpctl" }));
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
        return recoverManagedGroup();
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
    return recoverManagedGroup();
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
  const recoverManagedGroup = (): Promise<PageManagerResult<number>> => {
    if (!api.queryGroups) return createManagedGroup();
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
        return resolveManagedGroup();
      }
      return createManagedGroup();
    })();
  };
  let resolvingRevision = 0;
  const createManagedGroup = async (): Promise<PageManagerResult<number>> => {
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
      const created = await chromeResult(() =>
        api.createTab({ url: "https://mp.weixin.qq.com/", active: false }),
      );
      if (Result.isError(created)) return pageErr(created.error);
      if (created.value.id === undefined) return pageErr({ code: "page_failed" });
      anchorTabId = created.value.id;
      acquiringHomeTabId = anchorTabId;
    }
    const grouped = await chromeResult(() => api.groupTabs(anchorTabId!));
    if (Result.isError(grouped)) return pageErr(grouped.error);
    const id = grouped.value;
    const candidate = { id, updated: false, saved: false };
    recoveryCandidate = candidate;
    const updated = await chromeResult(() => api.updateGroup(id, { title: "mpctl" }));
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
      const previousDocumentId = documents.get(candidate.id!)?.documentId;
      const grouped = await chromeResult(() => api.groupTabs(candidate.id!, group));
      if (Result.isError(grouped)) return pageErr(grouped.error);
      const reloaded = await chromeResult(() => api.reloadTab!(candidate.id!));
      if (Result.isError(reloaded)) return pageErr(reloaded.error);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const binding = documents.get(candidate.id!);
        if (
          binding &&
          binding.documentId !== previousDocumentId &&
          classifyAppmsgUrl(binding.url).kind === kind
        )
          return pageOk(candidate.id);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return pageOk(undefined);
    })();
    sourceReloads.set(key, attempt);
    const result = await attempt;
    if (sourceReloads.get(key) === attempt) sourceReloads.delete(key);
    return result;
  };
  const manager = {
    observe(binding: PageBinding): void {
      this.observeConnection(binding.tabId, binding.documentId, binding.url);
    },
    observeConnection(
      tabId: number | undefined,
      documentId: string | undefined,
      url: string | undefined,
    ): void {
      if (tabId === undefined || !documentId) {
        console.debug("mpctl.pages.observe_connection_ignored", {
          reason: tabId === undefined ? "missing_tab_id" : "missing_document_id",
          hasUrl: Boolean(url),
        });
        return;
      }
      if (invalidated.has(`${tabId}:${documentId}`)) return;
      const route = classifyAppmsgUrl(url);
      if (route.kind === "unsupported") {
        console.debug("mpctl.pages.observe_connection_ignored", {
          reason: "unsupported_route",
          hasTabId: true,
          hasDocumentId: true,
          hasUrl: Boolean(url),
        });
      }
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
      const sessionRevision = nextSessionRevision(tabId);
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
      console.debug("mpctl.pages.observe_connection_accepted", {
        route: route.kind,
        hasTabId: true,
        hasDocumentId: true,
      });
      console.debug("mpctl.pages.session_hint_write", { result: "attempted" });
      queueSession(
        tabId,
        async () => {
          const saved = await chromeResult(() =>
            api.setSession({ [`document:${tabId}`]: binding }),
          );
          if (Result.isOk(saved)) {
            console.debug("mpctl.pages.session_hint_write", { result: "success" });
          }
          return saved;
        },
        () => sessionRevisions.get(tabId) === sessionRevision,
      );
    },
    async managedGroup(): Promise<PageManagerResult<number>> {
      if (resolvingGroup) return resolvingGroup;
      if (restoring) {
        const restored = await restoring;
        if (Result.isError(restored)) return pageErr(restored.error);
        return this.managedGroup();
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
        return resolveManagedGroup();
      })();
      resolvingGroup = attempt;
      const result = await attempt;
      if (resolvingGroup === attempt) resolvingGroup = undefined;
      return result;
    },
    async ensureEditorTab(): Promise<PageManagerResult<PageBinding>> {
      const group = await this.managedGroup();
      if (Result.isError(group)) return pageErr(group.error);
      return this.openFromManagedHome("openNewEditor", "new");
    },
    async ensureDraftList(): Promise<PageManagerResult<PageBinding>> {
      if (ensuringDraftList) return ensuringDraftList;
      const attempt = (async (): Promise<PageManagerResult<PageBinding>> => {
        const group = await this.managedGroup();
        if (Result.isError(group)) return pageErr(group.error);
        const existing = await this.findDraftList();
        if (Result.isError(existing)) return pageErr(existing.error);
        if (existing.value) {
          const existingBinding = existing.value;
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const current = await this.isCurrent(existingBinding);
            if (Result.isError(current)) return pageErr(current.error);
            if (!current.value) return pageErr({ code: "target_unavailable" });
            const status = await this.pageStatus(existingBinding);
            if (Result.isError(status)) return pageErr(status.error);
            if (status.value.state === "not_logged_in") return pageErr({ code: "not_logged_in" });
            if (status.value.state === "ready") {
              const stillCurrent = await this.isCurrent(existingBinding);
              if (Result.isError(stillCurrent)) return pageErr(stillCurrent.error);
              if (!stillCurrent.value) return pageErr({ code: "target_unavailable" });
              return pageOk(existingBinding);
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return pageErr({ code: "page_failed" });
        }
        const reloaded = await reloadObservedSource("draft-list", group.value);
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
        return this.openFromManagedHome("openDraftList", "draft-list");
      })();
      ensuringDraftList = attempt;
      const result = await attempt;
      if (ensuringDraftList === attempt) ensuringDraftList = undefined;
      return result;
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
        const revisionsBeforeSessionRead = new Map(sessionRevisions);
        const records = await chromeResult(() => api.getSession(null));
        if (Result.isError(records)) return pageErr(records.error);
        for (const [key, value] of Object.entries(records.value)) {
          if (!key.startsWith("document:") || !isPageBinding(value)) continue;
          // Chrome's tab API does not expose the active document ID without webNavigation permission.
          // A restored serialized ID is only a hint; wait for the content-script Nexus connection to re-observe it.
          const tabId = Number(key.slice("document:".length));
          if (!Number.isInteger(tabId)) continue;
          if (documents.has(tabId)) continue;
          removeHintFromRestore(tabId, revisionsBeforeSessionRead.get(tabId) ?? 0);
        }
        // Restoring Chrome pointers never creates a WebSocket or revives a Nexus connection.
        return pageOk(undefined);
      })();
      restoring = operation;
      const result = await operation;
      if (restoring === operation) restoring = undefined;
      return result;
    },
    async cleanupWorkspace(): Promise<
      PageManagerResult<{
        groupsRemoved: number;
        tabsMoved: number;
        groupsRemaining: number;
      }>
    > {
      const locked = await this.managedGroup();
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
          if (destination?.windowId !== undefined && duplicate.windowId !== destination.windowId) {
            if (!api.moveTab) return pageErr({ code: "page_failed" });
            const moved = await chromeResult(() => api.moveTab!(tab.id!, destination.windowId!));
            if (Result.isError(moved)) return pageErr(moved.error);
          }
          const moved = await chromeResult(() => api.groupTabs(tab.id!, locked.value));
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
    async findCurrentEditor(): Promise<PageManagerResult<PageBinding | undefined>> {
      if (groupId === undefined) {
        const restored = await this.restore();
        if (Result.isError(restored)) return pageErr(restored.error);
      }
      const group = groupId;
      if (group === undefined) return pageOk(undefined);
      const queried = await chromeResult(() => api.queryGroup(group));
      if (Result.isError(queried)) return pageErr(queried.error);
      const tabs = queried.value;
      if (tabs.filter((tab) => isEditorPageUrl(tab.url)).length > 1)
        return pageErr({ code: "target_ambiguous" });
      const allowed = new Set(tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
      const matches: PageBinding[] = [];
      for (const [tabId, binding] of documents) {
        // A role/group mismatch is not evidence that this document binding is stale:
        // managed home and draft-list pages are navigation sources and must survive editor lookup.
        if (!allowed.has(binding.tabId) || !isEditorPageUrl(binding.url)) continue;
        const current = await this.isCurrent(binding);
        if (Result.isError(current)) return pageErr(current.error);
        if (!current.value) {
          documents.delete(tabId);
          continue;
        }
        matches.push(binding);
      }
      if (matches.length > 1) return pageErr({ code: "target_ambiguous" });
      if (matches.length === 0) {
        const tab = tabs.find((tab) => isEditorPageUrl(tab.url));
        if (tab?.id !== undefined && api.getFrame) {
          const frameResult = await chromeResult(() =>
            api.getFrame!({ tabId: tab.id!, frameId: 0 }),
          );
          if (Result.isError(frameResult)) return pageErr(frameResult.error);
          const frame = frameResult.value;
          if (frame?.documentId && tab.url) {
            const binding = { tabId: tab.id, documentId: frame.documentId, url: tab.url };
            const connected = await this.connectContent(binding);
            if (Result.isError(connected)) return pageErr(connected.error);
            this.observe(binding);
            const current = await this.isCurrent(binding);
            if (Result.isError(current)) return pageErr(current.error);
            if (current.value) return pageOk(binding);
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
    async ensureManagedHome(): Promise<PageManagerResult<PageBinding>> {
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
        if (existing) return pageOk(existing);
        const group = await this.managedGroup();
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
            const reloaded = await reloadObservedSource("home", group.value, savedHomeTabId);
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
                    if (status.value.state === "ready" && currentAfterStatus.value)
                      return pageOk(current);
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
          const grouped = await chromeResult(() => api.groupTabs(existingHome!.tabId, group.value));
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
          const reloadedHome = await reloadObservedSource("home", group.value);
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
            )
              return pageOk(home);
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
              : undefined;
          if (!ownedTab) {
            const created = await chromeResult(() =>
              api.createTab({ url: "https://mp.weixin.qq.com/", active: true }),
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
          const grouped = await chromeResult(() => api.groupTabs(ownedTabId, group.value));
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
                if (status.value.state === "ready" && currentAfterStatus.value)
                  return pageOk(binding);
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return navigationErr("site_root_timeout");
        };
        return acquireOwnedRoot();
      })();
      acquiringHome = attempt;
      const result = await attempt;
      if (acquiringHome === attempt) {
        acquiringHome = undefined;
        acquiringHomeTabId = undefined;
      }
      return result;
    },
    async openFromManagedHome(
      action: "openDraftList" | "openNewEditor",
      expected: "draft-list" | "new",
    ): Promise<PageManagerResult<PageBinding>> {
      const homeResult = await this.ensureManagedHome();
      if (Result.isError(homeResult)) {
        console.debug("mpctl.pages.native_navigation", {
          phase: "source_unavailable",
          expected,
        });
        return homeResult.error.code === "navigation_failed"
          ? pageErr(homeResult.error)
          : navigationErr("source_unavailable");
      }
      const home = homeResult.value;
      console.debug("mpctl.pages.native_navigation", { phase: "source_ready", expected });
      const group = await this.managedGroup();
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
        const captureResult = await captureNative(home, captureNativeNewEditorUrl);
        if (Result.isError(captureResult))
          return pageErr(
            captureResult.error.code === "page_failed"
              ? { code: "page_failed" }
              : captureResult.error,
          );
        const results = captureResult.value;
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
        const result = results[0];
        const capture =
          result && typeof result === "object" && "result" in result ? result.result : undefined;
        console.debug("mpctl.pages.native_capture", {
          result:
            capture && typeof capture === "object" && "kind" in capture ? capture.kind : "missing",
        });
        if (!capture || typeof capture !== "object" || !("kind" in capture))
          return navigationErr("native_target_missing");
        if (capture.kind === "control_unavailable")
          return navigationErr("native_control_unavailable");
        if (capture.kind === "ambiguous") return navigationErr("native_target_ambiguous");
        if (capture.kind === "unsupported") return navigationErr("native_target_unsupported");
        if (capture.kind !== "captured" || !("url" in capture) || typeof capture.url !== "string")
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
      console.debug("mpctl.pages.native_navigation", {
        phase: "native_target_captured",
        expected,
        targetPresent: Boolean(targetUrl),
        routeKind: observedRoute.kind,
        routeMatches: observedRoute.kind === expected,
      });
      if (!targetUrl) return navigationErr("native_target_missing");
      const targetRoute = observedRoute;
      if (targetRoute.kind !== expected) return navigationErr("native_target_unsupported");
      const homeBeforeOpen = await this.isCurrent(home);
      if (Result.isError(homeBeforeOpen)) return pageErr(homeBeforeOpen.error);
      if (!homeBeforeOpen.value) return navigationErr("source_changed");
      const openedResult = await chromeResult(() =>
        api.createTab({ url: targetUrl!, active: true }),
      );
      if (Result.isError(openedResult)) return navigationErr("target_tab_create_failed");
      const openedTab = openedResult.value;
      if (openedTab.id === undefined) return navigationErr("target_tab_create_failed");
      console.debug("mpctl.pages.native_navigation", {
        phase: "tab_created",
        expected,
        hasTabId: openedTab.id !== undefined,
      });
      const groupedTarget = await chromeResult(() => api.groupTabs(openedTab.id!, group.value));
      if (Result.isError(groupedTarget)) return pageErr(groupedTarget.error, true);
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
            const statusResult = await this.pageStatus(binding);
            if (Result.isError(statusResult)) return pageErr(statusResult.error, true);
            const status = statusResult.value;
            console.debug("mpctl.pages.native_navigation", {
              phase: "target_status",
              expected,
              state: status.state,
              routeMatches: classifyAppmsgUrl(binding.url).kind === expected,
            });
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
              return pageOk(binding);
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
    ): Promise<PageManagerResult<PageBinding | undefined>> {
      const current = await this.isCurrent(binding);
      if (Result.isError(current)) return pageErr(current.error);
      if (
        !current.value ||
        classifyAppmsgUrl(binding.url).kind !== "draft-list" ||
        groupId === undefined
      )
        return pageOk(undefined);
      const connection = await this.connectContent(binding);
      if (Result.isError(connection)) return pageErr(connection.error);
      const candidate = await decodeRemote(listDraftsResultCodec, () =>
        connection.value.get(draftPageToken).listDrafts(),
      );
      if (Result.isError(candidate)) return pageErr(candidate.error);
      if (candidate.value.filter((item) => item.candidate === candidateId).length !== 1) {
        return pageOk(undefined);
      }
      const currentBeforeCapture = await this.isCurrent(binding);
      if (Result.isError(currentBeforeCapture)) return pageErr(currentBeforeCapture.error);
      if (!currentBeforeCapture.value) return pageOk(undefined);
      if (!api.executeMain) return navigationErr("native_control_unavailable");
      const captured = await captureNative(binding, captureNativeDraftEditorUrl, [candidateId]);
      if (Result.isError(captured)) return pageErr(captured.error);
      const results = captured.value;
      const result = results[0];
      const capture =
        result && typeof result === "object" && "result" in result ? result.result : undefined;
      if (capture && typeof capture === "object" && "kind" in capture) {
        if (capture.kind === "control_unavailable")
          return navigationErr("native_control_unavailable");
        if (capture.kind === "ambiguous") return navigationErr("native_target_ambiguous");
      }
      const targetUrl =
        capture &&
        typeof capture === "object" &&
        "kind" in capture &&
        capture.kind === "captured" &&
        "url" in capture &&
        typeof capture.url === "string"
          ? capture.url
          : undefined;
      if (!targetUrl) return navigationErr("native_target_missing");
      const route = classifyAppmsgUrl(targetUrl);
      if (route.kind === "unsupported") return navigationErr("native_target_unsupported");
      if (route.kind !== "saved-editor" || route.groupId !== candidateId)
        return navigationErr("native_target_missing");
      const currentAfterCapture = await this.isCurrent(binding);
      if (Result.isError(currentAfterCapture)) return pageErr(currentAfterCapture.error);
      if (!currentAfterCapture.value) return navigationErr("source_changed");
      if (!api.queryAllTabs) return pageOk(undefined);
      const baselineResult = await chromeResult(() => api.queryAllTabs!());
      if (Result.isError(baselineResult)) return pageErr(baselineResult.error);
      const baseline = baselineResult.value;
      const currentAfterBaseline = await this.isCurrent(binding);
      if (Result.isError(currentAfterBaseline)) return pageErr(currentAfterBaseline.error);
      if (!currentAfterBaseline.value) return pageOk(undefined);
      const tabIds = baseline.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
      if (tabIds.length !== baseline.length) return pageOk(undefined);
      const openedResult = await chromeResult(() =>
        api.createTab({ url: targetUrl!, active: true }),
      );
      if (Result.isError(openedResult)) return navigationErr("target_tab_create_failed");
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
        const workspaceGroupResult = await this.managedGroup();
        if (Result.isError(workspaceGroupResult)) {
          savedOpenTargets.delete(target);
          return pageErr(workspaceGroupResult.error);
        }
        const workspaceGroupId = workspaceGroupResult.value;
        const grouped = await chromeResult(() => api.groupTabs(opened.id!, workspaceGroupId));
        if (Result.isError(grouped)) {
          savedOpenTargets.delete(target);
          return pageErr(grouped.error, true);
        }
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const opened = documents.get(target.tabId);
          const route = classifyAppmsgUrl(opened?.url);
          if (opened && route.kind === "saved-editor" && route.groupId === candidateId) {
            target.firstDocumentId ??= opened.documentId;
            target.firstRouteRevision ??= opened.routeRevision ?? 0;
            if (
              opened.documentId !== target.firstDocumentId ||
              (opened.routeRevision ?? 0) !== target.firstRouteRevision ||
              !sameFinalTabUrl(opened.url, target.url)
            ) {
              return navigationErr("target_not_ready", true);
            }
            const currentOpened = await this.isCurrent(opened);
            if (Result.isError(currentOpened)) return pageErr(currentOpened.error, true);
            if (!currentOpened.value) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              continue;
            }
            const statusResult = await this.pageStatus(opened);
            if (Result.isError(statusResult)) return pageErr(statusResult.error, true);
            const status = statusResult.value;
            if (status.state === "not_logged_in") return pageErr({ code: "not_logged_in" }, true);
            if (status.state !== "ready") {
              await new Promise((resolve) => setTimeout(resolve, 100));
              continue;
            }
            const groupedAgain = await chromeResult(() =>
              api.groupTabs(opened.tabId, workspaceGroupId),
            );
            if (Result.isError(groupedAgain)) return pageErr(groupedAgain.error, true);
            const finalTabResult = await chromeResult(() => api.getTab(target.tabId));
            if (Result.isError(finalTabResult)) return pageErr(finalTabResult.error, true);
            const finalTab = finalTabResult.value;
            if (!sameFinalTabUrl(finalTab.url, target.url)) {
              return navigationErr("target_not_ready", true);
            }
            const currentOpenedFinal = await this.isCurrent(opened);
            if (Result.isError(currentOpenedFinal)) return pageErr(currentOpenedFinal.error, true);
            if (!currentOpenedFinal.value) {
              const latest = documents.get(target.tabId);
              if (
                !latest ||
                latest.documentId !== target.firstDocumentId ||
                (latest.routeRevision ?? 0) !== target.firstRouteRevision
              )
                return navigationErr("target_not_ready", true);
              await new Promise((resolve) => setTimeout(resolve, 100));
              continue;
            }
            return pageOk(opened);
          }
          // A navigation commit can precede the first content Nexus session.
          // Wait for that pinned document's services, never adopt a replacement.
          if (opened && target.firstDocumentId !== undefined)
            return navigationErr("target_not_ready", true);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return navigationErr("target_not_ready", true);
      } finally {
        savedOpenTargets.delete(target);
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
      const draft = connection.value.get(draftPageToken);
      const state = await decodeRemote(validateDraftResultCodec, () =>
        draft.validateDraft(groupId),
      );
      if (Result.isError(state)) return pageErr(state.error);
      const count = await decodeRemote(currentItemCountResultCodec, () => draft.currentItemCount());
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
    async open(
      binding: PageBinding,
    ): Promise<PageManagerResult<PageEditorService | PageEditorServiceRemote>> {
      if (!isEditorPageUrl(binding.url)) return pageErr({ code: "target_unavailable" });
      const current = await this.isCurrent(binding);
      if (Result.isError(current)) return pageErr(current.error);
      if (!current.value) return pageErr({ code: "target_unavailable" });
      const connected = await Result.tryPromise({
        try: () => connectPage(binding),
        catch: () => ({ code: "page_failed" as const }),
      });
      return Result.isError(connected) ? pageErr(connected.error) : pageOk(connected.value);
    },
    async connectContent(binding: PageBinding): Promise<PageManagerResult<Connection>> {
      const current = await this.isCurrent(binding);
      if (Result.isError(current)) return pageErr(current.error);
      if (!current.value) return pageErr({ code: "target_unavailable" });
      const connected = await Result.tryPromise({
        try: () => connectStatus(binding),
        catch: () => ({ code: "page_failed" as const }),
      });
      return Result.isError(connected) ? pageErr(connected.error) : pageOk(connected.value);
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
          catch: () => ({ code: "page_failed" as const }),
        });
        result = Result.isError(read) ? pageErr(read.error) : pageOk(read.value);
      } else {
        const connected = await this.connectContent(binding);
        if (Result.isError(connected)) return pageErr(connected.error);
        result = await decodeRemote(contentStatusResultCodec, () =>
          connected.value.get(contentStatusToken).status(),
        );
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
      const current = documents.get(binding.tabId);
      if (
        !current ||
        current.documentId !== binding.documentId ||
        (current.routeRevision ?? 0) !== (binding.routeRevision ?? 0) ||
        invalidated.has(`${binding.tabId}:${binding.documentId}`) ||
        navigationPending.has(binding.tabId) ||
        frameCheckPending.has(binding.tabId)
      )
        return pageOk(false);
      const tabResult = await chromeResult(() => api.getTab(binding.tabId));
      if (Result.isError(tabResult)) {
        const latestAfterFailure = documents.get(binding.tabId);
        const observedRouteAfterFailure = appmsgRouteIdentity(latestAfterFailure?.url);
        const bindingRoute = appmsgRouteIdentity(binding.url);
        if (
          !latestAfterFailure ||
          latestAfterFailure.documentId !== binding.documentId ||
          (latestAfterFailure.routeRevision ?? 0) !== (binding.routeRevision ?? 0) ||
          invalidated.has(`${binding.tabId}:${binding.documentId}`) ||
          navigationPending.has(binding.tabId) ||
          frameCheckPending.has(binding.tabId) ||
          !bindingRoute ||
          observedRouteAfterFailure !== bindingRoute
        )
          return pageOk(false);
        return pageErr(tabResult.error);
      }
      const tab = tabResult.value;
      const latest = documents.get(binding.tabId);
      if (
        !latest ||
        latest.documentId !== binding.documentId ||
        (latest.routeRevision ?? 0) !== (binding.routeRevision ?? 0) ||
        invalidated.has(`${binding.tabId}:${binding.documentId}`) ||
        navigationPending.has(binding.tabId) ||
        frameCheckPending.has(binding.tabId)
      )
        return pageOk(false);
      const observedRoute = appmsgRouteIdentity(latest.url);
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
    },
  };
  return manager;
}

async function connectChromeStatus(binding: PageBinding): Promise<Connection> {
  return backgroundNexus.connect({
    target: chromeTarget.contentDocument({
      tabId: binding.tabId,
      documentId: binding.documentId,
    }),
    timeout: 1_000,
  });
}

async function connectChromePage(binding: PageBinding): Promise<PageEditorServiceRemote> {
  const connection = await connectChromeStatus(binding);
  return connection.get(pageEditorToken);
}

function isExactMissingGroupError(error: unknown, id?: number): boolean {
  if (!(error instanceof Error)) return false;
  const match = /^No group with id: (\d+)(?:\.)?$/.exec(error.message);
  return Boolean(match && (id === undefined || Number(match[1]) === id));
}

function missingGroupId(error: unknown): number {
  return error instanceof Error ? Number(/^No group with id: (\d+)/.exec(error.message)?.[1]) : NaN;
}

function isPageBinding(value: unknown): value is PageBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<PageBinding>;
  return (
    Number.isInteger(binding.tabId) &&
    typeof binding.documentId === "string" &&
    typeof binding.url === "string"
  );
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
