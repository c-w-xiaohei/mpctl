import { Result } from "better-result";
import type { Failure } from "@mpctl/contracts";
import { hashArticleCover, readArticleCover } from "./article-cover";

export type CoverInputCandidate = { filename: string; thumbnailUrl: string };
export type CoverInputError = {
  code:
    | "cover_input_unavailable"
    | "page_failed"
    | "cover_unavailable"
    | "hash_failed"
    | "not_logged_in"
    | "target_unavailable"
    | "route_changed"
    | "cover_update_unknown";
  baselineHash?: string;
  cleanupFailed?: boolean;
};
export type CoverInputOptions = {
  timeoutMs?: number;
  publish?(observation: CoverInputObservation): void;
};
export type CoverInputObservation = Pick<
  import("../background-contracts").CoverReceipt,
  "effect" | "result" | "ended"
>;
type Guard = () => import("better-result").Result<void, { code: string }>;

const dialogSelector = ".weui-desktop-dialog";
const cardSelector = ".weui-desktop-img-picker__item";
const timeoutDefault = 3000;
const timeoutMaximum = 5000;

/** Drives only an already-open native cover-library dialog and preserves its platform-default crop. */
export async function selectArticleCoverFromLibrary(
  document: Document,
  candidate: CoverInputCandidate,
  guard: Guard,
  options: CoverInputOptions = {},
): Promise<CoverInputObservation> {
  let observation: CoverInputObservation = {
    effect: { cover: true, outcome: "not_dispatched" },
    ended: false,
  };
  const publish = (next: CoverInputObservation) => {
    observation = next;
    options.publish?.(next);
  };
  let cause: NonNullable<Failure["cause"]> | undefined;
  let nativeEnded = false;
  let owner: HTMLElement | undefined;
  let ownerKind: "crop" | "library" | undefined;
  let flowOwnsDialog = false;
  let cleanupFailed = false;
  let confirmed = false;
  let baselineHash = "";
  let baselineKnown = false;
  let selectionClicked = false;
  let nextClicked = false;
  // A dispatched selection/Next may still complete after this helper times out.
  let transitionPending = false;
  let confirmationClosed = false;
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const pending = await (async (): Promise<
    import("better-result").Result<{ coverHash: string }, CoverInputError>
  > => {
    try {
      const initialGuard = guard();
      if (Result.isError(initialGuard))
        return Result.err({ code: guardError(initialGuard.error.code) });
      const initial = await readAndHash(document);
      if (Result.isError(initial)) return initial;
      const initialAfterReadGuard = guard();
      if (Result.isError(initialAfterReadGuard))
        return Result.err({ code: guardError(initialAfterReadGuard.error.code) });
      baselineHash = initial.value.hash;
      baselineKnown = true;
      const library = uniqueDialog(document, "选择图片");
      if (!library) {
        return Result.err({ code: "cover_input_unavailable" });
      }
      owner = library;
      const buttons = visibleButtons(library);
      const next = uniqueButton(buttons, "下一步");
      const cancel = uniqueButton(buttons, "取消");
      if (!next || !cancel || uniqueButton(buttons, "确定")) {
        return Result.err({ code: "cover_input_unavailable" });
      }
      const cards = [...library.querySelectorAll<HTMLElement>(cardSelector)].filter(isVisible);
      const matches = cards.filter((card) => cardMatches(card, candidate));
      if (matches.length !== 1) return Result.err({ code: "cover_input_unavailable" });
      const selected = matches[0]!;
      const beforeClick = guard();
      if (Result.isError(beforeClick))
        return Result.err({ code: guardError(beforeClick.error.code) });
      const beforeSelectionSnapshot = await readAndHash(document);
      const afterSelectionSnapshotGuard = guard();
      if (Result.isError(afterSelectionSnapshotGuard))
        return Result.err({ code: guardError(afterSelectionSnapshotGuard.error.code) });
      if (
        Result.isError(beforeSelectionSnapshot) ||
        beforeSelectionSnapshot.value.hash !== baselineHash ||
        !isVisible(selected)
      )
        return Result.err({ code: "cover_input_unavailable" });
      selectionClicked = true;
      flowOwnsDialog = true;
      ownerKind = "library";
      owner = library;
      transitionPending = true;
      selected.click();
      const afterSelectionGuard = guard();
      if (Result.isError(afterSelectionGuard))
        return Result.err({ code: guardError(afterSelectionGuard.error.code) });
      const selectedCards = [...library.querySelectorAll<HTMLElement>(cardSelector)].filter(
        (card) => card.classList.contains("selected"),
      );
      if (selectedCards.length !== 1 || selectedCards[0] !== selected)
        return Result.err({ code: "cover_input_unavailable" });
      transitionPending = false;
      const nextButton = uniqueButton(visibleButtons(library), "下一步");
      if (nextButton !== next || next.disabled)
        return Result.err({ code: "cover_input_unavailable" });
      const beforeNextGuard = guard();
      if (Result.isError(beforeNextGuard))
        return Result.err({ code: guardError(beforeNextGuard.error.code) });
      nextClicked = true;
      owner = library;
      transitionPending = true;
      next.click();
      const afterNextGuard = guard();
      if (Result.isError(afterNextGuard))
        return Result.err({ code: guardError(afterNextGuard.error.code) });
      const crop = await waitFor(() => uniqueDialog(document, "编辑封面"), timeoutMs, guard);
      if (Result.isError(crop)) return Result.err({ code: guardError(crop.error.code) });
      if (!crop.value || library.isConnected)
        return Result.err({ code: "cover_input_unavailable" });
      transitionPending = false;
      flowOwnsDialog = true;
      owner = crop.value;
      ownerKind = "crop";
      const image = uniqueVisible([
        ...crop.value.querySelectorAll<HTMLImageElement>(".crop-img"),
      ]) as HTMLImageElement | undefined;
      const confirm = uniqueButton(visibleButtons(crop.value), "确认");
      const close = uniqueClose(crop.value);
      if (!image || !validCropImage(image) || !confirm || !close)
        return await preConfirmFailure(
          document,
          owner,
          baselineHash,
          "cover_input_unavailable",
          guard,
        );
      const confirmGuard = guard();
      if (Result.isError(confirmGuard))
        return await preConfirmFailure(
          document,
          owner,
          baselineHash,
          guardError(confirmGuard.error.code),
          guard,
        );
      const freshBeforeConfirm = await readAndHash(document);
      const afterBaselineGuard = guard();
      if (Result.isError(afterBaselineGuard))
        return await preConfirmFailure(
          document,
          owner,
          baselineHash,
          guardError(afterBaselineGuard.error.code),
          guard,
        );
      if (Result.isError(freshBeforeConfirm) || freshBeforeConfirm.value.hash !== baselineHash)
        return await preConfirmFailure(
          document,
          owner,
          baselineHash,
          "cover_input_unavailable",
          guard,
        );
      if (!owner.isConnected || !isVisible(confirm) || uniqueDialog(document, "编辑封面") !== owner)
        return await preConfirmFailure(
          document,
          owner,
          baselineHash,
          "cover_input_unavailable",
          guard,
        );
      // Confirmation is the native cover-write boundary. Any uncertainty beyond this point is not retryable.
      confirmed = true;
      publish({ effect: { cover: true, outcome: "unknown", baselineHash }, ended: false });
      confirm.click();
      const postClickGuard = guard();
      if (Result.isError(postClickGuard))
        return Result.err({
          code: guardError(postClickGuard.error.code),
          baselineHash,
          cleanupFailed: false,
        });
      const closed = await waitFor(
        () => {
          const visibleDialogs = [...document.querySelectorAll<HTMLElement>(dialogSelector)].filter(
            isVisible,
          );
          return !crop.value.isConnected || (!isVisible(crop.value) && visibleDialogs.length === 0)
            ? true
            : undefined;
        },
        timeoutMs,
        guard,
      );
      if (Result.isError(closed))
        return Result.err({
          code: guardError(closed.error.code),
          baselineHash,
          cleanupFailed: false,
        });
      if (!closed.value)
        return Result.err({ code: "cover_update_unknown", baselineHash, cleanupFailed: false });
      confirmationClosed = true;
      nativeEnded = true;
      const afterGuard = guard();
      if (Result.isError(afterGuard))
        return Result.err({
          code: guardError(afterGuard.error.code),
          baselineHash,
          cleanupFailed: false,
        });
      const freshResult = await waitForFreshCover(
        document,
        baselineHash,
        timeoutMs,
        guard,
        (coverHash) =>
          publish({ effect: { cover: true, outcome: "confirmed", coverHash }, ended: false }),
      );
      const afterFreshReadGuard = guard();
      if (Result.isError(afterFreshReadGuard))
        return Result.err({
          code: guardError(afterFreshReadGuard.error.code),
          baselineHash,
          cleanupFailed: false,
        });
      if (Result.isError(freshResult))
        return Result.err({ ...freshResult.error, baselineHash, cleanupFailed: false });
      return Result.ok({ coverHash: freshResult.value.hash });
    } catch {
      cause ??= {
        at: confirmed ? "content.cover_confirm" : "content.cover_select",
        kind: "runtime",
        code: "unexpected_exception",
      };
      if (confirmed) return unknownResult(baselineHash, false);
      if (!baselineKnown) return Result.err({ code: "page_failed" });
      if (!selectionClicked && !nextClicked) return Result.err({ code: "page_failed" });
      const current = await safeReadAndHash(document);
      if (Result.isOk(current) && current.value.hash === baselineHash)
        return Result.err({ code: "page_failed" });
      return Result.err({ code: "cover_update_unknown", baselineHash, cleanupFailed: false });
    }
  })();

  if (pending.isErr())
    cause ??= {
      at: confirmed ? "content.cover_confirm" : "content.cover_select",
      kind: "domain",
      code: pending.error.code,
    };

  if (!confirmed && (!nextClicked || !transitionPending) && flowOwnsDialog && owner && ownerKind) {
    cleanupFailed = cleanupOwnedIfCurrent(document, owner, ownerKind, guard);
  }
  if (Result.isError(pending) && cleanupFailed) {
    pending.error.cleanupFailed = true;
  }
  if (!confirmed && (selectionClicked || nextClicked) && Result.isError(pending)) {
    const current = await safeReadAndHash(document);
    const currentGuard = safeGuard(guard);
    if (
      Result.isError(current) ||
      current.value.hash !== baselineHash ||
      Result.isError(currentGuard)
    )
      pending.error.code = "cover_update_unknown";
  }
  if (
    !transitionPending &&
    ((!confirmed && flowOwnsDialog && !cleanupFailed) || confirmationClosed)
  )
    nativeEnded = true;
  const code = pending.isErr()
    ? cause?.kind === "domain"
      ? guardErrorOrCover(cause.code)
      : pending.error.code
    : "page_failed";
  publish({
    ...observation,
    ...(pending.isOk()
      ? {
          effect: {
            cover: true as const,
            outcome: "confirmed" as const,
            coverHash: pending.value.coverHash,
          },
        }
      : {}),
    ended: nativeEnded,
    result: pending.isOk()
      ? { status: "ok", value: {} }
      : {
          status: "error",
          error: {
            code,
            cause: cause ?? { at: "content.cover_select", kind: "domain", code },
            ...(pending.error.cleanupFailed
              ? { cleanup: { at: "content.cover_cleanup", kind: "domain", code: "cleanup_failed" } }
              : {}),
          },
        },
  });
  return observation;
}

function guardErrorOrCover(code: string): CoverInputError["code"] {
  switch (code) {
    case "cover_unavailable":
    case "hash_failed":
    case "cover_update_unknown":
    case "cover_input_unavailable":
      return code;
    default:
      return guardError(code);
  }
}

export function readCoverOwner(document: Document) {
  const areas = [...document.querySelectorAll<HTMLElement>("#js_cover_area")].filter(
    (node) => node.isConnected,
  );
  const area = areas.length === 1 ? areas[0] : undefined;
  const primaries = area
    ? [...area.querySelectorAll<HTMLElement>(".js_cover_preview_new")].filter(
        (node) => node.isConnected && node.tagName === "DIV",
      )
    : [];
  const primary = primaries.length === 1 ? primaries[0] : undefined;
  const launchers = primary
    ? [...primary.querySelectorAll<HTMLElement>(".js_chooseCover")].filter(
        (node) =>
          node.isConnected &&
          node.closest(".js_cover_preview_new") === primary &&
          !node.closest(".js_cover_preview_square"),
      )
    : [];
  const launcher = launchers.length === 1 ? launchers[0] : undefined;
  const wrappers =
    primary && launcher
      ? [...primary.querySelectorAll<HTMLElement>(".js_chooseCoverWrap")].filter(
          (node) =>
            node.isConnected &&
            node.contains(launcher) &&
            node.closest(".js_cover_preview_new") === primary &&
            !node.closest(".js_cover_preview_square"),
        )
      : [];
  const wrapper = wrappers.length === 1 ? wrappers[0] : undefined;
  return area && primary && launcher && wrapper ? { area, primary, launcher, wrapper } : undefined;
}

export async function setArticleCover(
  document: Document,
  candidate: CoverInputCandidate,
  expectedHash: string,
  guard: Guard,
  publish: (observation: CoverInputObservation) => void,
): Promise<CoverInputObservation> {
  let uiDispatched = false;
  const refuse = (code: Failure["code"]): CoverInputObservation => {
    const observation = {
      effect: { cover: true as const, outcome: "not_dispatched" as const },
      ended: !uiDispatched,
      result: {
        status: "error" as const,
        error: {
          code,
          cause: { at: "content.cover_select" as const, kind: "domain" as const, code },
        },
      },
    };
    publish(observation);
    return observation;
  };
  const read = async () => {
    const before = guard();
    if (before.isErr()) return Result.err({ code: guardError(before.error.code) });
    const cover = await readAndHash(document);
    const after = guard();
    return after.isErr() ? Result.err({ code: guardError(after.error.code) }) : cover;
  };
  const before = await read();
  if (before.isErr())
    return refuse(
      before.error.code === "hash_failed" ||
        before.error.code === "not_logged_in" ||
        before.error.code === "target_unavailable"
        ? before.error.code
        : "page_failed",
    );
  if (before.value.hash !== expectedHash) return refuse("content_conflict");
  const configured = readArticleCover(document);
  if (configured.isErr()) return refuse("cover_unavailable");
  const configuredHash = await hashArticleCover(configured.value);
  const afterRead = guard();
  if (afterRead.isErr()) return refuse(guardError(afterRead.error.code));
  if (configuredHash.isErr()) return refuse(configuredHash.error.code);
  if (configuredHash.value !== expectedHash) return refuse("content_conflict");
  if (!configured.value.primary.visible || !configured.value.primary.url)
    return refuse("cover_unavailable");
  const owner = readCoverOwner(document);
  if (
    !owner ||
    [...document.querySelectorAll<HTMLElement>(dialogSelector)].some(coverPreviewVisible) ||
    !coverPreviewVisible(owner.primary)
  )
    return refuse("cover_input_unavailable");
  const disabled = () =>
    owner.launcher.hasAttribute("disabled") ||
    owner.launcher.getAttribute("aria-disabled")?.trim().toLowerCase() === "true" ||
    ("disabled" in owner.launcher && owner.launcher.disabled === true);
  const current = () => {
    const fresh = readCoverOwner(document);
    return (
      fresh &&
      fresh.area === owner.area &&
      fresh.primary === owner.primary &&
      fresh.launcher === owner.launcher &&
      fresh.wrapper === owner.wrapper &&
      coverPreviewVisible(owner.primary) &&
      !disabled()
    );
  };
  if (disabled()) return refuse("cover_input_unavailable");
  const preClick = guard();
  if (preClick.isErr()) return refuse(guardError(preClick.error.code));
  if (!current()) return refuse("cover_input_unavailable");
  for (const node of [owner.launcher, owner.wrapper]) {
    const deadline = Date.now() + 3_000;
    while (true) {
      if (guard().isErr() || !current()) return refuse("target_unavailable");
      if (coverEffectivelyVisible(node, owner.area)) break;
      if (Date.now() >= deadline) return refuse("cover_input_unavailable");
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
    }
    if (!current()) return refuse("cover_input_unavailable");
  }
  const menu = () =>
    [
      ...owner.wrapper.querySelectorAll<HTMLAnchorElement>("a.pop-opr__button.js_imagedialog"),
    ].filter(
      (node) =>
        node.textContent?.trim() === "从图片库选择" && coverEffectivelyVisible(node, owner.area),
    );
  const deadline = Date.now() + 3_000;
  let visibleMenu: HTMLAnchorElement[] = [];
  while (true) {
    if (guard().isErr()) return refuse("target_unavailable");
    if (
      !current() ||
      !coverEffectivelyVisible(owner.launcher, owner.area) ||
      !coverEffectivelyVisible(owner.wrapper, owner.area)
    )
      return refuse("cover_input_unavailable");
    visibleMenu = menu();
    if (visibleMenu.length || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
    if (guard().isErr()) return refuse("target_unavailable");
  }
  if (visibleMenu.length !== 1) return refuse("cover_input_unavailable");
  if (guard().isErr()) return refuse("target_unavailable");
  const finalMenu = menu();
  if (!current() || finalMenu.length !== 1 || finalMenu[0] !== visibleMenu[0])
    return refuse("cover_input_unavailable");
  const clicked = Result.try({
    try: () => {
      uiDispatched = true;
      finalMenu[0]!.click();
    },
    catch: () => ({ code: "page_failed" as const }),
  });
  if (clicked.isErr()) return refuse("page_failed");
  if (guard().isErr()) return refuse("cover_update_unknown");
  let dialog: HTMLElement | undefined;
  const dialogDeadline = Date.now() + 2_000;
  while (Date.now() < dialogDeadline) {
    if (guard().isErr()) return refuse("cover_update_unknown");
    const matches = [...document.querySelectorAll<HTMLElement>(dialogSelector)]
      .filter(coverPreviewVisible)
      .filter((node) => node.textContent?.includes("选择图片"));
    if (matches.length === 1) {
      dialog = matches[0];
      break;
    }
    if (matches.length > 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!dialog) return refuse("cover_input_unavailable");
  const immediatelyBefore = await read();
  if (
    immediatelyBefore.isErr() ||
    immediatelyBefore.value.hash !== expectedHash ||
    !dialog.isConnected ||
    !coverPreviewVisible(dialog) ||
    ![...document.querySelectorAll<HTMLElement>(dialogSelector)]
      .filter(coverPreviewVisible)
      .includes(dialog)
  )
    return refuse("content_conflict");
  return selectArticleCoverFromLibrary(document, candidate, guard, { publish });
}

export function coverPreviewVisible(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    style?.display !== "none" &&
    style?.visibility !== "hidden" &&
    element.getClientRects().length > 0
  );
}

export function coverEffectivelyVisible(element: HTMLElement, owner: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    if (!current.isConnected || current.hidden || current.getAttribute("aria-hidden") === "true")
      return false;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse"
    )
      return false;
    if (current === owner) return current.getClientRects().length > 0;
    current = current.parentElement;
  }
  return false;
}

async function preConfirmFailure(
  document: Document,
  crop: HTMLElement,
  baselineHash: string,
  code: CoverInputError["code"],
  guard: Guard,
): Promise<import("better-result").Result<never, CoverInputError>> {
  const cleanupFailed = false;
  const current = await readAndHash(document);
  const afterCleanupGuard = safeGuard(guard);
  if (Result.isError(afterCleanupGuard))
    return Result.err({
      code: guardError(afterCleanupGuard.error.code),
      baselineHash,
      cleanupFailed: true,
    });
  if (Result.isError(current) || current.value.hash !== baselineHash)
    return Result.err({ code: "cover_update_unknown", baselineHash, cleanupFailed });
  return Result.err({ code, cleanupFailed });
}

function safeGuard(guard: Guard) {
  try {
    return guard();
  } catch {
    return Result.err({ code: "page_failed" as const });
  }
}

async function safeReadAndHash(
  document: Document,
): Promise<
  import("better-result").Result<
    { cover: import("./article-cover").ArticleCover; hash: string },
    CoverInputError
  >
> {
  try {
    return await readAndHash(document);
  } catch {
    return Result.err({ code: "page_failed" });
  }
}

function safeCleanupOwned(dialog: HTMLElement, kind: "crop" | "library"): boolean {
  try {
    return cleanupOwned(dialog, kind);
  } catch {
    return false;
  }
}

function cleanupOwnedIfCurrent(
  document: Document,
  dialog: HTMLElement,
  kind: "crop" | "library",
  guard: Guard,
): boolean {
  try {
    const currentGuard = guard();
    if (Result.isError(currentGuard)) return true;
    if (!dialog.isConnected) return true;
    const title = kind === "crop" ? "编辑封面" : "选择图片";
    if (uniqueDialog(document, title) !== dialog) return true;
    return !safeCleanupOwned(dialog, kind);
  } catch {
    return true;
  }
}

function unknownResult(baselineHash: string, cleanupFailed: boolean) {
  return Result.err({ code: "cover_update_unknown" as const, baselineHash, cleanupFailed });
}

async function readAndHash(
  document: Document,
): Promise<
  import("better-result").Result<
    { cover: import("./article-cover").ArticleCover; hash: string },
    CoverInputError
  >
> {
  const cover = readArticleCover(document);
  if (Result.isError(cover)) return Result.err({ code: cover.error.code });
  const hash = await hashArticleCover(cover.value);
  if (Result.isError(hash)) return Result.err({ code: hash.error.code });
  return Result.ok({ cover: cover.value, hash: hash.value });
}

function boundedTimeout(value: number | undefined) {
  return Number.isFinite(value) && value! > 0 ? Math.min(value!, timeoutMaximum) : timeoutDefault;
}

function guardError(code: string): CoverInputError["code"] {
  return code === "not_logged_in" || code === "target_unavailable" || code === "route_changed"
    ? code
    : "page_failed";
}

function uniqueDialog(document: Document, title: string): HTMLElement | undefined {
  const dialogs = [...document.querySelectorAll<HTMLElement>(dialogSelector)].filter(isVisible);
  const matches = dialogs.filter((dialog) => dialog.textContent?.includes(title));
  return dialogs.length === 1 && matches.length === 1 ? matches[0] : undefined;
}

function visibleButtons(dialog: HTMLElement): HTMLButtonElement[] {
  return [...dialog.querySelectorAll<HTMLButtonElement>("button")].filter(isVisible);
}

function uniqueButton(buttons: HTMLButtonElement[], label: string): HTMLButtonElement | undefined {
  const matches = buttons.filter((button) => button.textContent?.trim() === label);
  return matches.length === 1 ? matches[0] : undefined;
}

function uniqueClose(dialog: HTMLElement): HTMLElement | undefined {
  const buttons = [
    ...dialog.querySelectorAll<HTMLElement>(".weui-desktop-dialog__close-btn"),
  ].filter(isVisible);
  return buttons.length === 1 ? buttons[0] : undefined;
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    !!style &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    element.getClientRects().length > 0
  );
}

function uniqueVisible<T extends HTMLElement>(elements: T[]): T | undefined {
  const visible = elements.filter(isVisible);
  return visible.length === 1 ? visible[0] : undefined;
}

function cardMatches(card: HTMLElement, candidate: CoverInputCandidate): boolean {
  const title = card.querySelector<HTMLElement>(".weui-desktop-img-picker__img-title");
  const thumb = card.querySelector<HTMLElement>(".weui-desktop-img-picker__img-thumb");
  if (title?.textContent?.trim() !== candidate.filename || !thumb) return false;
  const style =
    thumb.style.backgroundImage ||
    thumb.ownerDocument.defaultView?.getComputedStyle(thumb).backgroundImage;
  const match = /^url\(["']?(.*?)["']?\)$/.exec(style ?? "");
  if (!match?.[1]) return false;
  try {
    return (
      new URL(match[1], thumb.ownerDocument.baseURI).href === new URL(candidate.thumbnailUrl).href
    );
  } catch {
    return false;
  }
}

function validCropImage(image: HTMLImageElement): boolean {
  try {
    const url = new URL(image.src, image.ownerDocument.baseURI);
    return (
      url.protocol === "https:" &&
      url.hostname === "mmbiz.qpic.cn" &&
      image.naturalWidth > 0 &&
      image.naturalHeight > 0
    );
  } catch {
    return false;
  }
}

async function waitFor<T>(read: () => T | undefined, timeout: number, guard: Guard) {
  const end = Date.now() + timeout;
  while (Date.now() <= end) {
    const before = guard();
    if (Result.isError(before)) return Result.err({ code: guardError(before.error.code) });
    const value = read();
    if (value !== undefined) return Result.ok(value);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const after = guard();
    if (Result.isError(after)) return Result.err({ code: guardError(after.error.code) });
  }
  return Result.ok(undefined);
}

async function waitForFreshCover(
  document: Document,
  baselineHash: string,
  timeout: number,
  guard: Guard,
  onConfirmed?: (hash: string) => void,
) {
  const end = Date.now() + timeout;
  let sameHash: Awaited<ReturnType<typeof readAndHash>> | undefined;
  while (Date.now() <= end) {
    const before = guard();
    if (Result.isError(before)) return Result.err({ code: guardError(before.error.code) });
    const cover = await readAndHash(document);
    if (cover.isOk() && cover.value.hash !== baselineHash) onConfirmed?.(cover.value.hash);
    const after = guard();
    if (Result.isError(after)) return Result.err({ code: guardError(after.error.code) });
    if (Result.isOk(cover)) {
      if (cover.value.hash !== baselineHash) return cover;
      sameHash = cover;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return sameHash ?? Result.err({ code: "cover_unavailable" as const });
}

function cleanupOwned(dialog: HTMLElement, kind: "crop" | "library"): boolean {
  if (!dialog.isConnected || !isVisible(dialog)) return false;
  const control =
    kind === "crop" ? uniqueClose(dialog) : uniqueButton(visibleButtons(dialog), "取消");
  if (!control) return false;
  control.click();
  return !dialog.isConnected;
}
