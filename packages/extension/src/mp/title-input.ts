import { Result } from "better-result";

export type TitleInputError =
  | {
      code:
        | "fields_unavailable"
        | "page_failed"
        | "unsupported"
        | "invalid_title"
        | "invalid_timeout";
    }
  | { code: "not_logged_in" | "target_unavailable" | "route_changed" }
  | { code: "title_update_unknown"; causeCode?: string; ended: false };

export type TitleInputResult = import("better-result").Result<
  { title: string; dispatched: boolean },
  TitleInputError
>;
export type TitleInputTarget = { element: HTMLElement; mirror: HTMLElement | undefined };
export type TitleInputOptions = {
  timeoutMs?: number;
  onDispatched?(target: TitleInputTarget): void;
};

type TitleGuard = () => import("better-result").Result<
  void,
  { code: "not_logged_in" | "target_unavailable" | "route_changed" | "page_failed" }
>;

const titleSelector = 'div[contenteditable="true"]';
const titlePlaceholder = "请在这里输入标题";

export function canWriteTitleInput(
  document: Document,
): "fields_unavailable" | "unsupported" | "page_failed" | undefined {
  try {
    const target = resolveTitle(document);
    if (!target) return "fields_unavailable";
    const view = document.defaultView;
    if (
      !view ||
      typeof view.getSelection !== "function" ||
      typeof document.createRange !== "function" ||
      typeof document.queryCommandSupported !== "function" ||
      typeof document.execCommand !== "function" ||
      !document.queryCommandSupported("insertText") ||
      typeof target.focus !== "function"
    )
      return "unsupported";
    const selection = view.getSelection();
    const range = document.createRange();
    if (
      !selection ||
      typeof selection.removeAllRanges !== "function" ||
      typeof selection.addRange !== "function" ||
      typeof range.selectNodeContents !== "function"
    )
      return "unsupported";
    if (!readTitleMirror(document).valid) return "fields_unavailable";
    return undefined;
  } catch {
    return "page_failed";
  }
}

export function titleInputAlreadyMatches(
  document: Document,
  value: string,
  original?: TitleInputTarget,
): boolean {
  try {
    const target = resolveTitle(document);
    if (!target) return false;
    if (original && target !== original.element) return false;
    const mirror = readTitleMirror(document);
    if (!mirror.valid) return false;
    if (original && mirror.element !== original.mirror) return false;
    if (value === "")
      return matchesVisibleTitle(target, "") && (mirror.value === undefined || mirror.value === "");
    return target.innerText === value && (mirror.value === undefined || mirror.value === value);
  } catch {
    return false;
  }
}

/** Candidate native editing path. It does not save or infer framework synchronization. */
export async function writeTitleInput(
  document: Document,
  value: string,
  guard: TitleGuard = () => Result.ok(),
  options: TitleInputOptions = {},
): Promise<TitleInputResult> {
  if (value.length > 64 || /[\r\n\0]/.test(value)) return Result.err({ code: "invalid_title" });
  const timeoutMs = options.timeoutMs ?? 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 1_000)
    return Result.err({ code: "invalid_timeout" });

  let dispatched = false;
  try {
    const initial = resolveTitle(document);
    if (!initial) return Result.err({ code: "fields_unavailable" as const });
    const view = document.defaultView;
    const selection = view?.getSelection;
    const rangeFactory = document.createRange;
    const supported = document.queryCommandSupported;
    const exec = document.execCommand;
    if (
      !view ||
      typeof selection !== "function" ||
      typeof rangeFactory !== "function" ||
      typeof supported !== "function" ||
      typeof exec !== "function"
    )
      return Result.err({ code: "unsupported" as const });
    if (!supported.call(document, "insertText"))
      return Result.err({ code: "unsupported" as const });

    const guarded = guard();
    if (Result.isError(guarded)) return Result.err({ code: guarded.error.code });
    const target = resolveTitle(document);
    if (!target || target !== initial) return Result.err({ code: "fields_unavailable" as const });
    const currentSelection = selection.call(view);
    if (
      !currentSelection ||
      typeof currentSelection.removeAllRanges !== "function" ||
      typeof currentSelection.addRange !== "function" ||
      typeof target.focus !== "function"
    )
      return Result.err({ code: "unsupported" as const });

    target.focus();
    const focusedGuard = guard();
    if (Result.isError(focusedGuard)) return Result.err({ code: focusedGuard.error.code });
    if (resolveTitle(document) !== target)
      return Result.err({ code: "fields_unavailable" as const });
    if (document.activeElement !== target) return Result.err({ code: "page_failed" as const });

    const range = rangeFactory.call(document);
    if (typeof range.selectNodeContents !== "function")
      return Result.err({ code: "unsupported" as const });
    range.selectNodeContents(target);
    currentSelection.removeAllRanges();
    currentSelection.addRange(range);

    const immediatelyGuarded = guard();
    if (Result.isError(immediatelyGuarded))
      return Result.err({ code: immediatelyGuarded.error.code });
    if (resolveTitle(document) !== target)
      return Result.err({ code: "fields_unavailable" as const });
    if (!selectionIsScopedToTitle(document, target, currentSelection))
      return Result.err({ code: "page_failed" as const });

    const mirrorBefore = readTitleMirror(document);
    if (!mirrorBefore.valid) return Result.err({ code: "fields_unavailable" as const });
    dispatched = true;
    options.onDispatched?.({ element: target, mirror: mirrorBefore.element });
    const commandResult = exec.call(document, "insertText", false, value);
    if (commandResult !== true) return Result.err({ code: "title_update_unknown", ended: false });

    const deadline = Date.now() + timeoutMs;
    while (true) {
      const afterEditGuard = safeGuard(guard);
      const after = safeResolveTitle(document);
      if (Result.isError(afterEditGuard))
        return Result.err({
          code: "title_update_unknown",
          causeCode: afterEditGuard.error.code,
          ended: false,
        });
      if (after !== target || !after || !matchesVisibleTitle(after, value))
        return Result.err({ code: "title_update_unknown", ended: false });
      const mirror = safeReadTitleMirror(document);
      if (!mirror.valid) return Result.err({ code: "title_update_unknown", ended: false });
      if (mirror.element !== mirrorBefore.element)
        return Result.err({ code: "title_update_unknown", ended: false });
      if (mirror.value === undefined) return Result.ok({ title: after.innerText, dispatched });
      if (mirror.value === value) return Result.ok({ title: after.innerText, dispatched });
      if (mirror.value !== mirrorBefore.value)
        return Result.err({ code: "title_update_unknown", ended: false });
      if (Date.now() >= deadline)
        return Result.err({
          code: "title_update_unknown",
          causeCode: "title_mirror_timeout",
          ended: false,
        });
      await delay(Math.min(40, deadline - Date.now()));
    }
  } catch {
    // An exited helper/guard says nothing about pending original mirror work.
    return dispatched
      ? Result.err({ code: "title_update_unknown", ended: false })
      : Result.err({ code: "page_failed" });
  }
}

function titleCandidates(document: Document): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(titleSelector)].filter(
    (element) =>
      element.tagName === "DIV" &&
      element.getAttribute("data-placeholder") === titlePlaceholder &&
      element.getAttribute("contenteditable") === "true",
  );
}

/** Structural read target; effective editability belongs to the write path. */
export function resolveTitleControl(document: Document): HTMLElement | undefined {
  const matches = titleCandidates(document).filter(isVisible);
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveTitle(document: Document): HTMLElement | undefined {
  const matches = titleCandidates(document).filter(
    (element) => element.isContentEditable && isVisible(element),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true")
    return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    style !== undefined &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    element.getClientRects().length > 0
  );
}

function readTitleMirror(
  document: Document,
): { valid: true; element: HTMLElement | undefined; value: string | undefined } | { valid: false } {
  const mirrors = [...document.querySelectorAll<HTMLElement>("#title")];
  if (mirrors.length === 0) return { valid: true, element: undefined, value: undefined };
  if (mirrors.length !== 1) return { valid: false };
  const mirror = mirrors[0];
  if (!mirror || mirror.getAttribute("id") !== "title") return { valid: false };
  const view = document.defaultView;
  if (mirror.tagName === "TEXTAREA")
    return typeof view?.HTMLTextAreaElement === "function" &&
      mirror instanceof view.HTMLTextAreaElement
      ? { valid: true, element: mirror, value: mirror.value }
      : { valid: false };
  return mirror.tagName === "INPUT" &&
    typeof view?.HTMLInputElement === "function" &&
    mirror instanceof view.HTMLInputElement &&
    mirror.type === "hidden"
    ? { valid: true, element: mirror, value: mirror.value }
    : { valid: false };
}

function safeReadTitleMirror(document: Document): ReturnType<typeof readTitleMirror> {
  try {
    return readTitleMirror(document);
  } catch {
    return { valid: false };
  }
}

function safeResolveTitle(document: Document): HTMLElement | undefined {
  try {
    return resolveTitle(document);
  } catch {
    return undefined;
  }
}

function safeGuard(guard: TitleGuard) {
  try {
    return guard();
  } catch {
    return Result.err({ code: "page_failed" as const });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function selectionIsScopedToTitle(
  document: Document,
  title: HTMLElement,
  selection: Selection,
): boolean {
  if (document.activeElement !== title || selection.rangeCount !== 1) return false;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  const range = selection.getRangeAt(0);
  return (
    !!anchor &&
    !!focus &&
    !!range &&
    nodeIsInside(title, anchor) &&
    nodeIsInside(title, focus) &&
    nodeIsInside(title, range.commonAncestorContainer)
  );
}

function nodeIsInside(element: HTMLElement, node: Node): boolean {
  return node === element || element.contains(node);
}

function matchesVisibleTitle(element: HTMLElement, value: string): boolean {
  if (value !== "") return element.innerText === value;
  return (
    (element.innerText === "" || element.innerText === "\n") &&
    (element.textContent === "" || element.textContent === "\n")
  );
}
