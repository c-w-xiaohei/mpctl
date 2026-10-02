import { Result } from "better-result";

export type DraftGroup = { groupId: string; title: string };
export type DraftOpenError = { code: "draft_unavailable" | "page_failed" };
export type DraftOpenResult = import("better-result").Result<string, DraftOpenError>;
const cardSelector = ".weui-desktop-card[data-appid]";
const titleSelector = ".weui-desktop-publish__cover__title";
const editSelector = ".weui-desktop-tooltip__wrp.weui-desktop-link a";

/** Uses only the single observed list-card structure; group IDs remain opaque candidates. */
export function listDraftGroups(document: Document): DraftGroup[] {
  const cards = [...document.querySelectorAll(cardSelector)];
  const counts = new Map<string, number>();
  for (const card of cards) {
    const id = card.getAttribute("data-appid")?.trim();
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return cards.flatMap((card) => {
    const groupId = card.getAttribute("data-appid")?.trim();
    const title = card.querySelector(titleSelector)?.textContent?.trim();
    if (!groupId || !title || counts.get(groupId) !== 1) return [];
    return [{ groupId, title }];
  });
}

export function openDraftGroup(
  document: Document,
  groupId: string,
  stillUnique: () => boolean = () => true,
): DraftOpenResult {
  return Result.try({
    try: () => {
      const cards = [...document.querySelectorAll(cardSelector)].filter(
        (card) => card.getAttribute("data-appid") === groupId,
      );
      if (cards.length !== 1) return undefined;
      const edit = cards[0]?.querySelector<HTMLAnchorElement>(editSelector);
      if (!edit || !isVisible(edit) || !stillUnique()) return undefined;
      return edit.href || undefined;
    },
    catch: () => ({ code: "page_failed" as const }),
  }).andThen((href) =>
    href ? Result.ok(href) : Result.err({ code: "draft_unavailable" as const }),
  );
}

/** Counts every visible appmsg item before validating the observed current first item. */
export function countVisibleAppmsgItems(document: Document): number {
  return [...document.querySelectorAll<HTMLElement>(".js_appmsg_item")].filter(isVisible).length;
}

/** Index 0 is only an observed shape, not a stable article ID. */
export function hasUniqueObservedCurrentItem(document: Document): boolean {
  const items = [...document.querySelectorAll<HTMLElement>(".js_appmsg_item")];
  const visible = items.filter(isVisible);
  return (
    items.length > 0 &&
    visible.length === 1 &&
    visible[0]?.classList.contains("current") === true &&
    visible[0]?.getAttribute("data-msgindex") === "0"
  );
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
