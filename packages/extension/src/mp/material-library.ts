import { Result } from "better-result";
import { assetFileLimits } from "@mpctl/contracts";

export type MaterialLibraryGuardError = {
  code: "not_logged_in" | "target_unavailable" | "route_changed" | "page_failed";
};
export type MaterialLibraryError = (
  | MaterialLibraryGuardError
  | { code: "dialog_unavailable" | "library_open_unknown" | "cleanup_failed" | "page_failed" }
) & {
  causeCode?: string;
  observedFailure?: { kind: "runtime"; causeCode: string };
};
export type MaterialLibraryGuard = () => import("better-result").Result<
  void,
  MaterialLibraryGuardError
>;
export type MaterialLibrarySession = { dialog: HTMLElement; opened: boolean };
export type MaterialLibraryResult = import("better-result").Result<
  MaterialLibrarySession,
  MaterialLibraryError
>;
export type MaterialLibraryCard = { filename: string; thumbnailUrl?: string };
export type MaterialLibrarySnapshot = {
  scope: "visible-page";
  cards: MaterialLibraryCard[];
};

export async function listMaterials(
  document: Document,
  guard: MaterialLibraryGuard,
): Promise<
  import("better-result").Result<
    MaterialLibrarySnapshot,
    import("../background-contracts").MaterialPageError
  >
> {
  let uiPending = false;
  const libraryFailure = (
    error: MaterialLibraryError,
    at: "content.library_open" | "content.library_cleanup" | "content.readback",
  ): import("@mpctl/contracts").Failure => ({
    code: error.code,
    cause: {
      at,
      kind: error.observedFailure?.kind ?? "domain",
      code: error.observedFailure?.causeCode ?? error.causeCode ?? error.code,
    },
  });
  const opening = await Result.tryPromise({
    try: () =>
      openMaterialLibrary(document, guard, {
        onDispatch: () => {
          uiPending = true;
        },
        onMenuObserved: () => {
          uiPending = false;
        },
      }),
    catch: () => ({ code: "page_failed" as const }),
  });
  if (opening.isErr())
    return Result.err({
      code: "page_failed",
      ended: !uiPending,
      failure: {
        code: "page_failed",
        cause: { at: "content.library_open", kind: "runtime", code: "unexpected_exception" },
      },
    });
  const opened = opening.value;
  if (opened.isErr())
    return Result.err({
      code: opened.error.code,
      ended: !uiPending,
      failure: libraryFailure(opened.error, "content.library_open"),
    });
  uiPending = false;
  const invocation = await Result.tryPromise({
    try: () => readMaterialLibrary(document, guard),
    catch: () => ({ code: "page_failed" as const }),
  });
  const result: import("better-result").Result<
    MaterialLibrarySnapshot,
    import("../background-contracts").MaterialPageError
  > = invocation.isErr()
    ? Result.err({
        code: "page_failed",
        failure: {
          code: "page_failed",
          cause: { at: "content.readback", kind: "runtime", code: "unexpected_exception" },
        },
      })
    : Result.mapError(invocation.value, (error) => ({
        code: error.code,
        failure: libraryFailure(error, "content.readback"),
      }));
  if (!opened.value.opened) return Result.mapError(result, (error) => ({ ...error, ended: true }));
  const closing = await Result.tryPromise({
    try: () =>
      closeMaterialLibrary(document, opened.value.dialog, guard, {
        onDispatch: () => {
          uiPending = true;
        },
      }),
    catch: () => ({
      code: "cleanup_failed" as const,
      observedFailure: { kind: "runtime" as const, causeCode: "unexpected_exception" },
    }),
  });
  const closed = closing.isOk() ? closing.value : Result.err(closing.error);
  if (closed.isErr()) {
    const cleanup = libraryFailure(closed.error, "content.library_cleanup");
    return result.isErr()
      ? Result.err({
          ...result.error,
          cleanupFailed: true,
          ended: !uiPending,
          failure: {
            ...(result.error.failure ?? {
              code: result.error.code,
              cause: { at: "content.readback", kind: "domain", code: result.error.code },
            }),
            cleanup: result.error.failure?.cleanup ?? cleanup.cause,
          },
        })
      : Result.err({
          code: "cleanup_failed",
          cleanupFailed: true,
          ended: !uiPending,
          failure: cleanup,
        });
  }
  return Result.mapError(result, (error) => ({ ...error, ended: true }));
}
export type MaterialCardReadResult = import("better-result").Result<
  MaterialLibraryCard[],
  {
    code: "page_failed";
    causeCode?:
      | "card_limit_exceeded"
      | "card_title_missing"
      | "card_title_empty"
      | "card_title_too_long"
      | "snapshot_read_exception";
  }
>;

const cardSelector = ".weui-desktop-img-picker__item";
const titleSelector = ".weui-desktop-img-picker__img-title";
const thumbnailSelector = ".weui-desktop-img-picker__img-thumb";
const maxVisibleCards = 1_000;

export async function readMaterialLibrary(
  document: Document,
  guard: MaterialLibraryGuard,
): Promise<import("better-result").Result<MaterialLibrarySnapshot, MaterialLibraryError>> {
  const dialog = observeDialog(document);
  if (Result.isError(dialog)) return dialog;
  if (!dialog.value || !isBodyDialog(dialog.value))
    return Result.err({ code: "dialog_unavailable" });
  const current = dialog.value;
  const beforeRead = guard();
  if (Result.isError(beforeRead)) return Result.err(beforeRead.error);
  const beforeSnapshot = observeDialog(document);
  if (Result.isError(beforeSnapshot)) return beforeSnapshot;
  if (beforeSnapshot.value !== current || !isBodyDialog(current))
    return Result.err({ code: "dialog_unavailable" });
  let cards = readMaterialCards(current, maxVisibleCards);
  // The native dialog mounts before its first file-page response. Do not
  // close it immediately and report that transient empty view as the list.
  const deadline = Date.now() + 1_500;
  while (cards.isOk() && cards.value.length === 0 && Date.now() < deadline) {
    const checked = guard();
    if (checked.isErr()) return checked;
    const observed = observeDialog(document);
    if (observed.isErr()) return observed;
    if (observed.value !== current) return Result.err({ code: "dialog_unavailable" });
    await delay(50);
    cards = readMaterialCards(current, maxVisibleCards);
  }
  if (Result.isError(cards)) return Result.err({ code: cards.error.code });
  const afterRead = guard();
  if (Result.isError(afterRead)) return Result.err(afterRead.error);
  const afterSnapshot = observeDialog(document);
  if (Result.isError(afterSnapshot)) return afterSnapshot;
  if (afterSnapshot.value !== current || !isBodyDialog(current))
    return Result.err({ code: "dialog_unavailable" });
  return Result.ok({ scope: "visible-page", cards: cards.value });
}

export function readMaterialCards(
  dialog: HTMLElement,
  maxCards = Number.POSITIVE_INFINITY,
): MaterialCardReadResult {
  return Result.try({
    try: () => {
      const elements = [...dialog.querySelectorAll<HTMLElement>(cardSelector)].filter(
        (candidate) => candidate.isConnected,
      );
      if (elements.length > maxCards)
        return Result.err({
          code: "page_failed" as const,
          causeCode: "card_limit_exceeded" as const,
        });
      const cards: MaterialLibraryCard[] = [];
      for (const card of elements) {
        const title = card.querySelector<HTMLElement>(titleSelector);
        if (!title)
          return Result.err({
            code: "page_failed" as const,
            causeCode: "card_title_missing" as const,
          });
        const filename = title.textContent ?? "";
        if (filename.length === 0)
          return Result.err({
            code: "page_failed" as const,
            causeCode: "card_title_empty" as const,
          });
        if (filename.length > assetFileLimits.maxFilenameLength)
          return Result.err({
            code: "page_failed" as const,
            causeCode: "card_title_too_long" as const,
          });
        const thumb = card.querySelector<HTMLElement>(thumbnailSelector);
        const style = thumb?.getAttribute("style") ?? "";
        const match = /background-image\s*:\s*url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/i.exec(
          style,
        );
        const url = match?.[1] ?? match?.[2] ?? match?.[3];
        const thumbnailUrl = url && isLibraryThumbnail(url) ? url : undefined;
        cards.push({ filename, ...(thumbnailUrl ? { thumbnailUrl } : {}) });
      }
      return Result.ok(cards);
    },
    catch: () => ({ code: "page_failed" as const, causeCode: "snapshot_read_exception" as const }),
  }).andThen((result) => result);
}

const dialogSelector = ".weui-desktop-dialog";
const menuSelector = "li#js_editor_insertimage";
const libraryChoiceSelector = ".js_img_from_local";
const defaultTimeoutMs = 1_500;
const pollIntervalMs = 50;

export async function openMaterialLibrary(
  document: Document,
  guard: MaterialLibraryGuard,
  options: { timeoutMs?: number; onDispatch?: () => void; onMenuObserved?: () => void } = {},
): Promise<MaterialLibraryResult> {
  const timeout = boundedTimeout(options.timeoutMs);
  const initial = observeDialog(document);
  if (Result.isError(initial)) return initial;
  if (initial.value) {
    const existing = initial.value;
    if (!isBodyDialog(existing)) return Result.err({ code: "dialog_unavailable" });
    const existingGuard = guard();
    if (Result.isError(existingGuard)) return Result.err(existingGuard.error);
    const revalidated = observeDialog(document);
    if (Result.isError(revalidated)) return revalidated;
    if (revalidated.value !== existing || !isBodyDialog(existing))
      return Result.err({ code: "dialog_unavailable" });
    return Result.ok({ dialog: existing, opened: false });
  }

  const menu = uniqueVisible(document.querySelectorAll<HTMLElement>(menuSelector));
  if (!menu) return Result.err({ code: "dialog_unavailable" });
  const choices = [...menu.querySelectorAll<HTMLElement>(libraryChoiceSelector)].filter(
    (element) => element.isConnected && hasExactText(element, "从图片库选择"),
  );
  const originalChoice = choices.length === 1 ? choices[0] : undefined;
  const choiceWasHidden = originalChoice && !isVisible(originalChoice);
  const beforeMenuClick = guard();
  if (Result.isError(beforeMenuClick)) return Result.err(beforeMenuClick.error);
  const beforeMenuDialog = observeDialog(document);
  if (Result.isError(beforeMenuDialog)) return beforeMenuDialog;
  if (
    beforeMenuDialog.value ||
    uniqueVisible(document.querySelectorAll<HTMLElement>(menuSelector)) !== menu
  )
    return Result.err({ code: "dialog_unavailable" });
  options.onDispatch?.();
  const menuClick = safeClick(menu);
  if (Result.isError(menuClick)) return menuClick;
  const afterMenuClick = guard();
  if (Result.isError(afterMenuClick)) return Result.err(afterMenuClick.error);
  const afterMenuDialog = observeDialog(document);
  if (Result.isError(afterMenuDialog)) return afterMenuDialog;
  if (afterMenuDialog.value) return Result.err({ code: "dialog_unavailable" });

  const choiceResult = await waitForChoice(document, guard, timeout, menu, originalChoice);
  if (Result.isError(choiceResult)) return choiceResult;
  const { toolbar, choice } = choiceResult.value;
  // Only the original hidden -> visible choice acknowledges this menu click.
  // A current same-label replacement or a helper Err is not completion evidence.
  if (choiceWasHidden && choice === originalChoice) options.onMenuObserved?.();
  const beforeChoiceClick = guard();
  if (Result.isError(beforeChoiceClick)) return Result.err(beforeChoiceClick.error);
  const beforeChoiceDialog = observeDialog(document);
  if (Result.isError(beforeChoiceDialog)) return beforeChoiceDialog;
  if (
    beforeChoiceDialog.value ||
    uniqueVisible(document.querySelectorAll<HTMLElement>(menuSelector)) !== toolbar ||
    uniqueVisible(toolbar.querySelectorAll<HTMLElement>(libraryChoiceSelector), (element) =>
      hasExactText(element, "从图片库选择"),
    ) !== choice
  )
    return Result.err({ code: "dialog_unavailable" });
  options.onDispatch?.();
  const choiceClick = safeClick(choice);
  if (Result.isError(choiceClick))
    return Result.err({ ...choiceClick.error, code: "library_open_unknown" });

  return waitForDialog(document, guard, timeout, true);
}

export async function closeMaterialLibrary(
  document: Document,
  dialog: HTMLElement,
  guard: MaterialLibraryGuard,
  options: { timeoutMs?: number; onDispatch?: () => void } = {},
): Promise<import("better-result").Result<void, MaterialLibraryError>> {
  const current = observeDialog(document);
  if (Result.isError(current)) return Result.err({ ...current.error, code: "cleanup_failed" });
  if (current.value !== dialog || !isBodyDialog(dialog))
    return Result.err({ code: "cleanup_failed", causeCode: "dialog_changed" });
  const cancel = uniqueVisible(dialog.querySelectorAll<HTMLElement>("button"), (button) =>
    hasExactText(button, "取消"),
  );
  if (!cancel) return Result.err({ code: "cleanup_failed", causeCode: "cancel_unavailable" });
  const beforeClick = guard();
  if (Result.isError(beforeClick))
    return Result.err({ code: "cleanup_failed", causeCode: beforeClick.error.code });
  const beforeObservation = observeDialog(document);
  if (Result.isError(beforeObservation))
    return Result.err({ ...beforeObservation.error, code: "cleanup_failed" });
  if (
    beforeObservation.value !== dialog ||
    !isBodyDialog(dialog) ||
    uniqueVisible(dialog.querySelectorAll<HTMLElement>("button"), (button) =>
      hasExactText(button, "取消"),
    ) !== cancel
  )
    return Result.err({ code: "cleanup_failed" });
  options.onDispatch?.();
  const clicked = safeClick(cancel);
  if (Result.isError(clicked))
    return Result.err({
      ...clicked.error,
      code: "cleanup_failed",
      causeCode: "cancel_dispatch_failed",
    });
  const timeout = boundedTimeout(options.timeoutMs);
  const deadline = Date.now() + timeout;
  while (true) {
    const currentGuard = guard();
    if (Result.isError(currentGuard))
      return Result.err({ code: "cleanup_failed", causeCode: currentGuard.error.code });
    const observed = observeDialog(document);
    if (Result.isError(observed)) return Result.err({ ...observed.error, code: "cleanup_failed" });
    if (observed.value && observed.value !== dialog)
      return Result.err({ code: "cleanup_failed", causeCode: "dialog_changed" });
    if (!isVisible(dialog)) return Result.ok(undefined);
    if (Date.now() >= deadline)
      return Result.err({ code: "cleanup_failed", causeCode: "cancel_timeout" });
    await delay(Math.min(pollIntervalMs, deadline - Date.now()));
  }
}

function waitForDialog(
  document: Document,
  guard: MaterialLibraryGuard,
  timeout: number,
  dispatched: boolean,
): Promise<MaterialLibraryResult> {
  return (async () => {
    const deadline = Date.now() + timeout;
    while (true) {
      const currentGuard = guard();
      if (Result.isError(currentGuard))
        return Result.err(
          dispatched
            ? { code: "library_open_unknown", causeCode: currentGuard.error.code }
            : currentGuard.error,
        );
      const observed = observeDialog(document);
      if (Result.isError(observed))
        return Result.err(
          dispatched
            ? { ...observed.error, code: "library_open_unknown", causeCode: observed.error.code }
            : observed.error,
        );
      if (observed.value)
        return isBodyDialog(observed.value)
          ? Result.ok({ dialog: observed.value, opened: true })
          : Result.err({ code: "library_open_unknown" });
      if (Date.now() >= deadline)
        return Result.err({ code: "library_open_unknown", causeCode: "library_open_timeout" });
      await delay(Math.min(pollIntervalMs, deadline - Date.now()));
    }
  })();
}

function waitForChoice(
  document: Document,
  guard: MaterialLibraryGuard,
  timeout: number,
  originalToolbar: HTMLElement,
  originalChoice: HTMLElement | undefined,
): Promise<
  import("better-result").Result<
    { toolbar: HTMLElement; choice: HTMLElement },
    MaterialLibraryError
  >
> {
  return (async () => {
    const deadline = Date.now() + timeout;
    while (true) {
      const currentGuard = guard();
      if (Result.isError(currentGuard)) return Result.err(currentGuard.error);
      const dialog = observeDialog(document);
      if (Result.isError(dialog)) return dialog;
      if (dialog.value) return Result.err({ code: "dialog_unavailable" });
      const toolbar = uniqueVisible(document.querySelectorAll<HTMLElement>(menuSelector));
      if (toolbar !== originalToolbar) return Result.err({ code: "dialog_unavailable" });
      const choice = toolbar
        ? uniqueVisible(toolbar.querySelectorAll<HTMLElement>(libraryChoiceSelector), (element) =>
            hasExactText(element, "从图片库选择"),
          )
        : undefined;
      if (choice && originalChoice && choice !== originalChoice)
        return Result.err({ code: "dialog_unavailable" });
      if (toolbar && choice) return Result.ok({ toolbar, choice });
      if (Date.now() >= deadline) return Result.err({ code: "dialog_unavailable" });
      await delay(Math.min(pollIntervalMs, deadline - Date.now()));
    }
  })();
}

function observeDialog(
  document: Document,
): import("better-result").Result<HTMLElement | undefined, MaterialLibraryError> {
  return Result.try({
    try: () => {
      const visible = [...document.querySelectorAll<HTMLElement>(dialogSelector)].filter(isVisible);
      return visible.length <= 1
        ? Result.ok(visible[0])
        : Result.err({ code: "page_failed" as const });
    },
    catch: () => ({
      code: "page_failed" as const,
      observedFailure: { kind: "runtime" as const, causeCode: "dialog_observe_exception" },
    }),
  }).andThen((result) => result);
}

function isBodyDialog(dialog: HTMLElement): boolean {
  if (!hasExactTextNode(dialog, "选择图片")) return false;
  const buttons = [...dialog.querySelectorAll<HTMLElement>("button")].filter(isVisible);
  const closeButtons = buttons.filter(isNativeDialogCloseButton);
  const footerButtons = buttons.filter((button) => !isNativeDialogCloseButton(button));
  return (
    closeButtons.length === 1 &&
    footerButtons.filter((button) => hasExactText(button, "确定")).length === 1 &&
    footerButtons.filter((button) => hasExactText(button, "取消")).length === 1 &&
    footerButtons.length === 2
  );
}

function isNativeDialogCloseButton(button: HTMLElement): boolean {
  return button.tagName === "BUTTON" && button.classList.contains("weui-desktop-dialog__close-btn");
}

function hasExactTextNode(element: HTMLElement, expected: string): boolean {
  const document = element.ownerDocument;
  if (!document.createTreeWalker) return false;
  const walker = document.createTreeWalker(element, 4);
  while (walker.nextNode()) {
    if (normalizeText(walker.currentNode.textContent) === expected) return true;
  }
  return false;
}

function hasExactText(element: HTMLElement, expected: string): boolean {
  return normalizeText(element.textContent) === expected;
}

function normalizeText(value: string | null): string {
  return (value ?? "").replace(/\s+/g, "").trim();
}

function isLibraryThumbnail(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "mmbiz.qpic.cn" &&
      !url.username &&
      !url.password &&
      (url.pathname.startsWith("/mmbiz_") || url.pathname.startsWith("/sz_mmbiz_"))
    );
  } catch {
    return false;
  }
}

function uniqueVisible<T extends HTMLElement>(
  elements: ArrayLike<T>,
  predicate: (element: T) => boolean = () => true,
): T | undefined {
  const candidates = Array.from(elements).filter(
    (element) => element.isConnected && isVisible(element) && predicate(element),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function isVisible(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view || !element.isConnected || element.hidden) return false;
  const style = view.getComputedStyle(element);
  return (
    style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0
  );
}

function safeClick(
  element: HTMLElement,
): import("better-result").Result<void, MaterialLibraryError> {
  return Result.try({
    try: () => element.click(),
    catch: () => ({
      code: "page_failed" as const,
      observedFailure: { kind: "runtime" as const, causeCode: "click_exception" },
    }),
  }).map(() => undefined);
}

function boundedTimeout(timeoutMs?: number): number {
  return Math.min(Math.max(timeoutMs ?? defaultTimeoutMs, 0), 2_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
