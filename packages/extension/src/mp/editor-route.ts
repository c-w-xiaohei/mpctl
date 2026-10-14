import { appmsgRouteIdentity, classifyAppmsgUrl } from "./routes";
import { hasUniqueObservedCurrentItem } from "./drafts";

/** An editor may acquire its first saved identity without replacing its document. */
export function createEditorRouteValidator(document: Document): () => boolean {
  const originalUrl = document.location.href;
  let identity = appmsgRouteIdentity(originalUrl);
  const wasNew = classifyAppmsgUrl(originalUrl).kind === "new";
  let saved = false;
  let item: Element | null = null;
  return () => {
    const current = appmsgRouteIdentity(document.location.href);
    if (current === identity && identity) {
      if (wasNew && !saved) {
        // Capturing a possible first-save anchor must not turn an ordinary
        // same-route read into a failing native DOM probe.
        try {
          if (hasUniqueObservedCurrentItem(document))
            item ??= document.querySelector(".js_appmsg_item.current");
        } catch {
          /* The transition remains unavailable without an anchor. */
        }
      }
      return true;
    }
    if (
      wasNew &&
      !saved &&
      item?.isConnected &&
      document.querySelector(".js_appmsg_item.current") === item &&
      hasUniqueObservedCurrentItem(document) &&
      classifyAppmsgUrl(document.location.href).kind === "saved-editor" &&
      new URL(originalUrl).searchParams.get("token") ===
        new URL(document.location.href).searchParams.get("token")
    ) {
      identity = current;
      saved = true;
      return true;
    }
    return false;
  };
}
