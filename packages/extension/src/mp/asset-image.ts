import { Result } from "better-result";
import type { AssetImage, Failure } from "@mpctl/contracts";
import {
  openMaterialLibrary,
  closeMaterialLibrary,
  readMaterialCards,
  type MaterialLibraryGuard,
} from "./material-library";

/** Read the native selection's converted CDN URL; never derive it from a thumbnail. */
export async function resolveAssetImage(
  document: Document,
  candidate: { filename: string; thumbnailUrl: string },
  guard: MaterialLibraryGuard,
  ended: () => void = () => {},
): Promise<Result<AssetImage, Failure>> {
  const opened = await openMaterialLibrary(document, guard);
  if (opened.isErr()) {
    if (opened.error.code !== "library_open_unknown") ended();
    return Result.err({ code: opened.error.code });
  }
  const { dialog } = opened.value;
  if (!opened.value.opened) {
    ended();
    return Result.err({ code: "dialog_unavailable" });
  }
  const resolved = await Result.tryPromise({
    try: async (): Promise<Result<AssetImage, Failure>> => {
      let cards = readMaterialCards(dialog);
      const loadedBy = Date.now() + 5_000;
      while (cards.isOk() && cards.value.length === 0 && Date.now() < loadedBy) {
        if (guard().isErr() || !dialog.isConnected)
          return Result.err({ code: "target_unavailable" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        cards = readMaterialCards(dialog);
      }
      if (cards.isErr()) return Result.err({ code: "asset_list_failed" });
      const matches = cards.value.flatMap((card, index) =>
        card.filename === candidate.filename && card.thumbnailUrl === candidate.thumbnailUrl
          ? [index]
          : [],
      );
      if (matches.length !== 1) return Result.err({ code: "asset_ambiguous" });
      const elements = [...dialog.querySelectorAll<HTMLElement>(".weui-desktop-img-picker__item")];
      const card = elements[matches[0]!]!;
      type ImageDialog = {
        $options?: { name?: string };
        $parent?: ImageDialog;
        selectedImgs?: {
          name: string;
          url: string;
          fileId: number;
          format: string;
          aiStatus?: number;
        }[];
      };
      const upload = dialog.querySelector(".weui-desktop-upload_global-media") as
        | (Element & { __vue__?: ImageDialog })
        | null;
      let model = upload?.__vue__;
      while (model && model.$options?.name !== "mp-image-dialog") model = model.$parent;
      if (!model) return Result.err({ code: "unsupported" });
      // A user-owned selection is not ours to change or clear.
      if (model.selectedImgs?.length) return Result.err({ code: "dialog_unavailable" });
      if (guard().isErr()) return Result.err({ code: "target_unavailable" });
      card.click();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (guard().isErr() || !dialog.isConnected || !card.isConnected)
          return Result.err({ code: "target_unavailable" });
        const selected = model.selectedImgs;
        if (
          selected?.length === 1 &&
          selected[0]?.name === candidate.filename &&
          selected[0].url !== candidate.thumbnailUrl
        ) {
          const image = selected[0];
          if (
            !Number.isSafeInteger(image.fileId) ||
            image.fileId <= 0 ||
            !["png", "jpeg", "jpg", "gif", "webp"].includes(image.format)
          )
            return Result.err({ code: "invalid_asset" });
          const url = new URL(image.url);
          if (
            url.protocol !== "https:" ||
            url.hostname !== "mmbiz.qpic.cn" ||
            !/^\/(?:sz_)?mmbiz_/.test(url.pathname)
          )
            return Result.err({ code: "invalid_asset" });
          const img = document.createElement("img");
          img.src = image.url;
          img.className = "rich_pages wxw-img";
          img.setAttribute("data-s", "300,640");
          img.setAttribute("data-type", image.format);
          img.setAttribute("data-filename", image.name);
          img.setAttribute("data-imgfileid", String(image.fileId));
          img.setAttribute("data-aistatus", String(image.aiStatus ?? 0));
          img.setAttribute("data-fromlib", "1");
          return Result.ok({ filename: image.name, src: image.url, html: img.outerHTML });
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return Result.err({ code: "target_unavailable" });
    },
    catch: (): Failure => ({ code: "page_failed" }),
  });
  const closed = await closeMaterialLibrary(document, dialog, guard);
  if (closed.isErr()) return Result.err({ code: "cleanup_failed" });
  ended();
  return resolved.isErr() ? resolved : resolved.value;
}
