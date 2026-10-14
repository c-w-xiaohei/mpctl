import { Result } from "better-result";

export type ArticleCover = {
  primary: { visible: boolean; url: string | null };
  square: { visible: boolean; url: string | null };
};
export type ArticleCoverReadError = { code: "cover_unavailable" | "page_failed" };
export type ArticleCoverHashError = { code: "hash_failed" };

export type ArticleCoverResult = import("better-result").Result<
  ArticleCover,
  ArticleCoverReadError
>;

const areaSelector = "#js_cover_area";
const primarySelector = ".js_cover_preview_new";
const squareSelector = ".js_cover_preview_square";

/** Reads configured preview state only; this is not canonical crop or source-asset identity. */
export function readArticleCover(document: Document): ArticleCoverResult {
  return Result.try({
    try: () => {
      const areas = [...document.querySelectorAll<HTMLElement>(areaSelector)].filter(
        (area) => area.isConnected,
      );
      if (areas.length !== 1) return undefined;
      const area = areas[0]!;
      const primary = uniqueConnectedDiv(area, primarySelector);
      const square = uniqueConnectedDiv(area, squareSelector);
      if (!primary || !square) return undefined;
      const primaryVisible = isVisible(primary, area);
      const squareVisible = isVisible(square, area);
      const primaryUrl = readPreviewUrl(primary);
      const squareUrl = readPreviewUrl(square);
      if (primaryUrl === undefined || squareUrl === undefined) return undefined;
      if ((primaryVisible && primaryUrl === null) || (squareVisible && squareUrl === null))
        return undefined;
      return {
        primary: { visible: primaryVisible, url: primaryUrl },
        square: { visible: squareVisible, url: squareUrl },
      };
    },
    catch: () => ({ code: "page_failed" as const }),
  }).andThen((cover) =>
    cover ? Result.ok(cover) : Result.err({ code: "cover_unavailable" as const }),
  );
}

function uniqueConnectedDiv(area: HTMLElement, selector: string): HTMLElement | undefined {
  const elements = [...area.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => element.isConnected,
  );
  if (elements.length !== 1 || elements[0]?.tagName !== "DIV") return undefined;
  return elements[0];
}

function isVisible(element: HTMLElement, area: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  let withinArea = false;
  while (current) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (!style || style.display === "none") return false;
    if (current === area) withinArea = true;
    current = current.parentElement;
  }
  if (!withinArea) return false;
  const targetVisibility = element.ownerDocument.defaultView?.getComputedStyle(element).visibility;
  return (
    targetVisibility !== undefined &&
    targetVisibility !== "hidden" &&
    targetVisibility !== "collapse" &&
    element.getClientRects().length > 0
  );
}

function readPreviewUrl(element: HTMLElement): string | null | undefined {
  const inline = element.style.backgroundImage;
  const backgroundImage =
    inline && inline !== "none"
      ? inline
      : element.ownerDocument.defaultView?.getComputedStyle(element).backgroundImage;
  if (!backgroundImage || backgroundImage === "none") return null;
  const match = /^url\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s'"(),]+))\s*\)$/i.exec(
    backgroundImage,
  );
  if (!match) return undefined;
  const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, element.ownerDocument.baseURI);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "mmbiz.qpic.cn" ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/(?:mmbiz_|sz_mmbiz_)/.test(url.pathname)
  )
    return undefined;
  return url.href;
}

export async function hashArticleCover(
  cover: ArticleCover,
): Promise<import("better-result").Result<string, ArticleCoverHashError>> {
  const digest = await Result.tryPromise({
    try: () =>
      crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            cover.primary.visible,
            cover.primary.url,
            cover.square.visible,
            cover.square.url,
          ]),
        ),
      ),
    catch: () => ({ code: "hash_failed" as const }),
  });
  if (Result.isError(digest)) return digest;
  return Result.ok(
    [...new Uint8Array(digest.value)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}
