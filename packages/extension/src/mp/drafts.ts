export type DraftGroup = { groupId: string; title: string };
const cardSelector = ".weui-desktop-card[data-appid]";
const titleSelector = ".weui-desktop-publish__cover__title";

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
