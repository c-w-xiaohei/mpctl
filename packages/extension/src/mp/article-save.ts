import { Result, type Result as BetterResult } from "better-result";
import type { Failure } from "@mpctl/contracts";
import { classifyAppmsgUrl } from "./routes";
import { hasUniqueObservedCurrentItem } from "./drafts";
import { detectLoginTimeout } from "./editor";
import {
  hasNewManualSave,
  getHistoryPortal,
  isHistoryPortalVisible,
  readManualSaveHistory,
  type SaveHistoryGuard,
} from "./save-history";

export type ArticleSaveError = {
  code:
    | "invalid_options"
    | "save_control_unavailable"
    | "history_unavailable"
    | "target_lost"
    | "page_failed"
    | "save_unknown"
    | "not_logged_in"
    | "target_unavailable"
    | "route_changed"
    | "cleanup_failed";
  cleanupFailed?: true;
};
export type ArticleSaveObservation = Pick<
  import("../background-contracts").SaveReceipt,
  "effect" | "result" | "ended"
>;

const SAVE_LABEL = "保存为草稿";
const HISTORY_LABEL = "历史版本";
const HISTORY_CONTAINER = ".appmsg_history_new";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

type Guard = SaveHistoryGuard;

export async function saveArticle(
  document: Document,
  targetGuard: () => BetterResult<
    void,
    { code: "target_lost" | "not_logged_in" | "target_unavailable" | "route_changed" }
  >,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    publish?(observation: ArticleSaveObservation): void;
  } = {},
): Promise<ArticleSaveObservation> {
  let observation: ArticleSaveObservation = {
    effect: { outcome: "not_dispatched", persistence: "unverified" },
    ended: false,
  };
  const publish = (next: ArticleSaveObservation) => {
    observation = next;
    options.publish?.(next);
  };
  const initialRoute = classifyAppmsgUrl(document.location?.href);
  if (
    initialRoute.kind === "new" ||
    (initialRoute.kind === "saved-editor" && document.querySelector("#js_save_success"))
  ) {
    const original = new URL(document.location.href);
    const checked = targetGuard();
    const button = findSaveButton(document);
    const notice = document.querySelector<HTMLElement>("#js_save_success");
    if (
      checked.isErr() ||
      !button ||
      !notice ||
      !hasUniqueObservedCurrentItem(document) ||
      isVisible(notice, document)
    ) {
      publish({
        ...observation,
        ended: true,
        result: {
          status: "error",
          error: {
            code: checked.isErr()
              ? checked.error.code === "target_lost"
                ? "target_unavailable"
                : checked.error.code
              : "save_control_unavailable",
          },
        },
      });
      return observation;
    }
    const timeout = options.timeoutMs ?? MAX_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      publish({
        ...observation,
        ended: true,
        result: { status: "error", error: { code: "invalid_operation" } },
      });
      return observation;
    }
    let acknowledged = false;
    let candidate: string | undefined;
    const item = document.querySelector(".js_appmsg_item.current");
    const observe = () => {
      if (acknowledged) return;
      // The native success callback changes the same document's route and
      // shows this notice. A pre-existing toast or a route alone is insufficient.
      const current = new URL(document.location.href);
      const route = classifyAppmsgUrl(current.href);
      acknowledged =
        document.querySelector("#js_save_success") === notice &&
        isVisible(notice, document) &&
        notice.textContent?.trim() === "已保存" &&
        current.origin === original.origin &&
        current.searchParams.get("token") === original.searchParams.get("token") &&
        route.kind === "saved-editor" &&
        (initialRoute.kind === "new" || route.groupId === initialRoute.groupId) &&
        item === document.querySelector(".js_appmsg_item.current") &&
        detectLoginTimeout(document).state !== "not_logged_in" &&
        hasUniqueObservedCurrentItem(document);
      if (acknowledged && route.kind === "saved-editor") candidate = route.groupId;
    };
    const observer = new document.defaultView!.MutationObserver(observe);
    observer.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    publish({ effect: { outcome: "unknown", persistence: "unverified" }, ended: false });
    try {
      button.click();
      const deadline = Date.now() + Math.min(timeout, MAX_TIMEOUT_MS);
      while (!acknowledged && Date.now() < deadline) {
        observe();
        if (!acknowledged) await delay(50);
      }
      publish(
        acknowledged
          ? {
              effect: { outcome: "confirmed", persistence: "unverified", candidate },
              ended: true,
              result: { status: "ok", value: {} },
            }
          : { ...observation, result: { status: "error", error: { code: "save_unknown" } } },
      );
    } catch {
      publish({ ...observation, result: { status: "error", error: { code: "save_unknown" } } });
    } finally {
      observer.disconnect();
    }
    return observation;
  }
  let guardCause: string | undefined;
  const guard: Guard = () => {
    const checked = targetGuard();
    if (checked.isErr()) guardCause ??= checked.error.code;
    return checked.isErr() ? Result.err({ code: "target_lost" }) : Result.ok(undefined);
  };
  let uiDispatched = false;
  let nativeEnded = false;
  let cause: NonNullable<Failure["cause"]> | undefined;
  const result = await (async (): Promise<BetterResult<{ confirmed: true }, ArticleSaveError>> => {
    const requestedTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const requestedInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    if (
      !Number.isFinite(requestedTimeout) ||
      !Number.isFinite(requestedInterval) ||
      requestedTimeout <= 0 ||
      requestedInterval <= 0
    )
      return Result.err({ code: "invalid_options" });
    const timeoutMs = Math.min(requestedTimeout, MAX_TIMEOUT_MS);
    const pollIntervalMs = Math.min(requestedInterval, 1_000);
    let initialHistoryVisible = false;
    let container: HTMLElement | undefined;
    let launcher: HTMLElement | undefined;
    let initialPortal: HTMLElement | undefined;
    let ownedPortal: HTMLElement | undefined;
    let ownedTable: HTMLTableElement | undefined;
    let dispatched = false;
    let confirmed = false;
    let primaryError: ArticleSaveError | undefined;
    let failureAt: "content.preflight" | "content.save_dispatch" | "content.save_confirm" =
      "content.preflight";
    let runtimeFailure = false;
    let historyTransitionPending = false;
    try {
      const initialGuard = checkGuard(guard);
      if (initialGuard.isErr()) return Result.err({ code: initialGuard.error.code });
      const button = findSaveButton(document);
      if (!button) return Result.err({ code: "save_control_unavailable" });
      const history = locateHistoryLauncher(document);
      if (!history) return Result.err({ code: "history_unavailable" });
      ({ container, launcher } = history);
      const initialPortalResult = getHistoryPortal(document);
      if (initialPortalResult.isErr()) return Result.err({ code: "history_unavailable" });
      initialPortal = initialPortalResult.value;
      initialHistoryVisible = Boolean(initialPortal && isHistoryPortalVisible(document));
      if (!initialHistoryVisible) {
        const beforeOpen = checkGuard(guard);
        if (beforeOpen.isErr()) return Result.err({ code: beforeOpen.error.code });
        uiDispatched = true;
        historyTransitionPending = true;
        launcher.click();
      }
      const before = await waitForManualHistory(
        document,
        guard,
        timeoutMs,
        pollIntervalMs,
        container,
        launcher,
        initialPortal,
      );
      if (before.isOk()) {
        historyTransitionPending = false;
        ownedPortal = before.value.portal;
        ownedTable = before.value.table;
      }
      if (before.isErr()) primaryError = { code: before.error.code };
      else if (!checkGuard(guard).isOk()) primaryError = { code: "target_lost" };
      else {
        const immediateButton = findSaveButton(document);
        if (!immediateButton || immediateButton !== button || !isVisible(immediateButton, document))
          primaryError = { code: "save_control_unavailable" };
        else if (!checkGuard(guard).isOk()) primaryError = { code: "target_lost" };
        else if (
          getHistoryPortal(document).unwrapOr(undefined) !== ownedPortal ||
          !samePortalTable(before.value.portal, before.value.table)
        )
          primaryError = { code: "history_unavailable" };
        else {
          // Once click may be invoked, even an exception has an uncertain native outcome.
          dispatched = true;
          publish({ effect: { outcome: "unknown", persistence: "unverified" }, ended: false });
          failureAt = "content.save_dispatch";
          immediateButton.click();
          failureAt = "content.save_confirm";
          const deadline = Date.now() + timeoutMs;
          let reopenedAfterCollapse = false;
          while (Date.now() <= deadline) {
            if (!checkGuard(guard).isOk()) {
              primaryError = { code: "target_lost" };
              break;
            }
            const after = readManualSaveHistory(document, guard);
            if (
              after.isOk() &&
              (after.value.portal !== ownedPortal || after.value.table !== ownedTable)
            ) {
              primaryError = { code: "save_unknown" };
              break;
            }
            if (after.isErr()) {
              const currentPortal = getHistoryPortal(document);
              if (
                reopenedAfterCollapse ||
                !sameHistoryLauncher(document, container, launcher) ||
                currentPortal.isErr() ||
                (currentPortal.value && currentPortal.value !== ownedPortal) ||
                isHistoryPortalVisible(document) ||
                !checkGuard(guard).isOk()
              ) {
                primaryError = { code: "save_unknown" };
                break;
              }
              // The native save may collapse history. Reopen only this verified display once;
              // this is a readonly observation transition, never another save dispatch.
              uiDispatched = true;
              historyTransitionPending = true;
              launcher.click();
              reopenedAfterCollapse = true;
              const reopened = await waitForManualHistory(
                document,
                guard,
                Math.max(1, deadline - Date.now()),
                pollIntervalMs,
                container,
                launcher,
                undefined,
                undefined,
                true,
              );
              if (reopened.isErr()) {
                primaryError = { code: reopened.error.code };
                break;
              }
              ownedPortal = reopened.value.portal;
              ownedTable = reopened.value.table;
              historyTransitionPending = false;
              continue;
            }
            if (hasNewManualSave(before.value, after.value)) {
              confirmed = true;
              publish({
                effect: { outcome: "confirmed", persistence: "unverified" },
                ended: false,
              });
              break;
            }
            await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
          }
          if (!confirmed && !primaryError) primaryError = { code: "save_unknown" };
        }
      }
    } catch {
      runtimeFailure = true;
      primaryError = dispatched ? { code: "save_unknown" } : { code: "page_failed" };
    }

    if (primaryError)
      cause ??= {
        at: failureAt,
        kind: runtimeFailure ? "runtime" : "domain",
        code: runtimeFailure ? "unexpected_exception" : primaryError.code,
      };

    let cleanupDispatched = false;
    // Do not toggle a display whose original open/reopen has not been observed.
    const cleanup = restoreHistoryDisplay(
      document,
      guard,
      container,
      launcher,
      initialHistoryVisible,
      initialPortal,
      ownedPortal,
      ownedTable,
      historyTransitionPending,
      () => {
        cleanupDispatched = true;
        historyTransitionPending = true;
        uiDispatched = true;
      },
    );
    if (cleanupDispatched && cleanup.isOk()) historyTransitionPending = false;
    const cleanupFailed = cleanup.isErr();
    if (
      !historyTransitionPending &&
      ((!dispatched && cleanup.isOk()) || (confirmed && (!cleanupDispatched || cleanup.isOk())))
    )
      nativeEnded = true;

    if (primaryError) {
      return Result.err(cleanupFailed ? { ...primaryError, cleanupFailed: true } : primaryError);
    }
    if (confirmed)
      return cleanupFailed
        ? Result.err({
            code: "cleanup_failed",
            cleanupFailed: true,
          })
        : Result.ok({ confirmed: true });
    return Result.err({ code: "save_unknown" });
  })();
  const code: Failure["code"] =
    result.isErr() && result.error.code === "target_lost"
      ? guardCause === "not_logged_in" || guardCause === "route_changed"
        ? guardCause
        : "target_unavailable"
      : result.isErr() &&
          result.error.code !== "invalid_options" &&
          result.error.code !== "target_lost"
        ? result.error.code
        : "page_failed";
  const failure: Failure = {
    code,
    cause:
      guardCause && (!cause || cause.code === "target_lost")
        ? { at: "content.guard", kind: "domain", code: guardCause }
        : (cause ?? {
            at: "content.save_confirm",
            kind: "domain",
            code: result.isErr() ? result.error.code : code,
          }),
    ...(result.isErr() && result.error.cleanupFailed
      ? { cleanup: { at: "content.history_cleanup", kind: "domain", code: "cleanup_failed" } }
      : {}),
  };
  publish({
    ...observation,
    ended: nativeEnded || (!uiDispatched && observation.effect.outcome === "not_dispatched"),
    result:
      observation.effect.outcome === "confirmed"
        ? { status: "ok", value: result.isErr() ? { cleanup: failure } : {} }
        : { status: "error", error: failure },
  });
  return observation;
}

function restoreHistoryDisplay(
  document: Document,
  guard: Guard,
  container: HTMLElement | undefined,
  launcher: HTMLElement | undefined,
  initialVisible: boolean,
  initialPortal: HTMLElement | undefined,
  ownedPortal: HTMLElement | undefined,
  ownedTable: HTMLTableElement | undefined,
  transitionPending: boolean,
  onDispatch: () => void,
): BetterResult<void, { code: "cleanup_failed" }> {
  if (!sameHistoryLauncher(document, container, launcher))
    return Result.err({ code: "cleanup_failed" });
  const valid = checkGuard(guard);
  if (valid.isErr()) return Result.err({ code: "cleanup_failed" });
  const portal = getHistoryPortal(document);
  if (portal.isErr()) return Result.err({ code: "cleanup_failed" });
  if (initialVisible && portal.value !== initialPortal && portal.value !== ownedPortal)
    return Result.err({ code: "cleanup_failed" });
  if (!initialVisible && portal.value && portal.value !== ownedPortal)
    return Result.err({ code: "cleanup_failed" });
  if (portal.value && !samePortalTable(portal.value, ownedTable))
    return Result.err({ code: "cleanup_failed" });
  if (transitionPending) return Result.err({ code: "cleanup_failed" });
  const visible = Result.try({
    try: () => isHistoryPortalVisible(document),
    catch: () => ({ code: "cleanup_failed" as const }),
  });
  if (visible.isErr()) return Result.err({ code: "cleanup_failed" });
  if (visible.value === initialVisible) return Result.ok(undefined);
  const toggled = Result.try({
    try: () => {
      onDispatch();
      launcher!.click();
    },
    catch: () => ({ code: "cleanup_failed" as const }),
  });
  if (toggled.isErr()) return Result.err({ code: "cleanup_failed" });
  const restored = Result.try({
    try: () => isHistoryPortalVisible(document) === initialVisible,
    catch: () => ({ code: "cleanup_failed" as const }),
  });
  return restored.isOk() && restored.value
    ? Result.ok(undefined)
    : Result.err({ code: "cleanup_failed" });
}

function checkGuard(guard: Guard) {
  const checked = Result.try({ try: guard, catch: () => ({ code: "target_lost" as const }) });
  if (checked.isErr()) return checked;
  return checked.value.isErr() ? checked.value : Result.ok(undefined);
}

function findSaveButton(document: Document): HTMLButtonElement | undefined {
  const candidates = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) =>
      button.tagName === "BUTTON" &&
      button.textContent?.trim() === SAVE_LABEL &&
      isVisible(button, document),
  );
  return candidates.length === 1 && !candidates[0]!.disabled ? candidates[0] : undefined;
}

function locateHistoryLauncher(
  document: Document,
): { container: HTMLElement; launcher: HTMLElement } | undefined {
  const containers = [...document.querySelectorAll<HTMLElement>(HISTORY_CONTAINER)].filter((item) =>
    isVisible(item, document),
  );
  if (containers.length !== 1) return undefined;
  const container = containers[0]!;
  if (
    container.tagName !== "DIV" ||
    container.id !== "history_bt" ||
    !container.classList.contains("appmsg_history_new") ||
    ![...container.querySelectorAll<HTMLElement>("p")].some(
      (label) => label.textContent?.trim() === HISTORY_LABEL,
    )
  )
    return undefined;
  return { container, launcher: container };
}

function sameHistoryLauncher(
  document: Document,
  container: HTMLElement | undefined,
  launcher: HTMLElement | undefined,
): boolean {
  const current = locateHistoryLauncher(document);
  return Boolean(
    current &&
    current.container === container &&
    current.launcher === launcher &&
    current.container.id === "history_bt" &&
    current.container.classList.contains("appmsg_history_new"),
  );
}

function samePortalTable(portal: HTMLElement, table: HTMLTableElement | undefined): boolean {
  const tables = [...portal.querySelectorAll<HTMLTableElement>("table.appmsg_history_table")];
  return tables.length === 1 && tables[0] === table;
}

function uniqueHistoryTable(
  portal: HTMLElement,
  document?: Document,
): HTMLTableElement | undefined {
  const tables = [...portal.querySelectorAll<HTMLTableElement>("table.appmsg_history_table")];
  if (tables.length !== 1) return undefined;
  const table = tables[0]!;
  if (
    table.tagName !== "TABLE" ||
    !table.isConnected ||
    !table.classList.contains("appmsg_history_table") ||
    (document && !isVisible(table, document))
  )
    return undefined;
  return table;
}

async function waitForManualHistory(
  document: Document,
  guard: Guard,
  timeoutMs: number,
  pollIntervalMs: number,
  container: HTMLElement,
  launcher: HTMLElement,
  expectedPortal?: HTMLElement,
  expectedTable?: HTMLTableElement,
  allowPortalRemount = false,
) {
  const deadline = Date.now() + timeoutMs;
  let pinnedPortal = expectedPortal;
  let pinnedTable = expectedTable;
  while (true) {
    if (!checkGuard(guard).isOk()) return Result.err({ code: "target_lost" as const });
    if (!sameHistoryLauncher(document, container, launcher))
      return Result.err({ code: "target_lost" as const });
    const portal = getHistoryPortal(document);
    if (portal.isErr()) return Result.err({ code: "history_unavailable" as const });
    if (!allowPortalRemount && portal.value) {
      if (pinnedPortal && portal.value !== pinnedPortal)
        return Result.err({ code: "history_unavailable" as const });
      pinnedPortal ??= portal.value;
      const currentTable = uniqueHistoryTable(portal.value, document);
      if (pinnedTable && currentTable !== pinnedTable)
        return Result.err({ code: "history_unavailable" as const });
      pinnedTable ??= currentTable;
    }
    const history = readManualSaveHistory(document, guard);
    if (history.isOk()) {
      const readyPortal = getHistoryPortal(document);
      if (
        readyPortal.isErr() ||
        !readyPortal.value ||
        !sameHistoryLauncher(document, container, launcher) ||
        readyPortal.value !== history.value.portal ||
        !samePortalTable(readyPortal.value, history.value.table)
      )
        return Result.err({ code: "history_unavailable" as const });
      if (!allowPortalRemount && pinnedPortal && readyPortal.value !== pinnedPortal)
        return Result.err({ code: "history_unavailable" as const });
      if (!allowPortalRemount && pinnedTable && history.value.table !== pinnedTable)
        return Result.err({ code: "history_unavailable" as const });
      pinnedPortal ??= readyPortal.value;
      pinnedTable ??= history.value.table;
      return Result.ok(history.value);
    }
    if (history.error.code !== "history_unavailable") return history;
    if (!allowPortalRemount && pinnedPortal) {
      const currentPortal = getHistoryPortal(document);
      if (
        currentPortal.isErr() ||
        currentPortal.value !== pinnedPortal ||
        (pinnedTable && uniqueHistoryTable(pinnedPortal, document) !== pinnedTable)
      )
        return Result.err({ code: "history_unavailable" as const });
    }
    if (!sameHistoryLauncher(document, container, launcher))
      return Result.err({ code: "target_lost" as const });
    if (Date.now() >= deadline) return history;
    await delay(Math.min(pollIntervalMs, deadline - Date.now()));
  }
}

function isVisible(element: HTMLElement, document: Document): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true")
    return false;
  const style = document.defaultView?.getComputedStyle(element);
  return (
    style !== undefined &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    element.getClientRects().length > 0
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
