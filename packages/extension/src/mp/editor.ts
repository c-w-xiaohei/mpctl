import { classifyAppmsgUrl } from "./routes";
import { hasUniqueObservedCurrentItem } from "./drafts";

export type EditorState = "not_logged_in" | "loading" | "ready";

export function createEditorTargetValidator(document: Document): () => boolean {
  const original = classifyAppmsgUrl(document.location.href);
  return () => {
    if (detectLoginTimeout(document).state === "not_logged_in") return false;
    const current = classifyAppmsgUrl(document.location.href);
    if (original.kind === "new") return current.kind === "new";
    return (
      original.kind === "saved-editor" &&
      current.kind === "saved-editor" &&
      current.groupId === original.groupId &&
      hasUniqueObservedCurrentItem(document)
    );
  };
}

export type LoginTimeoutMarkers = { bodyClasses: string[]; infoText: string; jumpUrl: string };

export function classifyLoginTimeoutMarkers(markers: LoginTimeoutMarkers): { state: EditorState } {
  let jump: URL;
  try {
    jump = new URL(markers.jumpUrl);
  } catch {
    return { state: "loading" };
  }
  const positive =
    markers.bodyClasses.includes("page_error") &&
    markers.bodyClasses.includes("page_timeout") &&
    markers.infoText.includes("登录超时") &&
    jump.origin === "https://mp.weixin.qq.com" &&
    jump.pathname === "/cgi-bin/loginpage";
  return { state: positive ? "not_logged_in" : "loading" };
}

export function detectLoginTimeout(document: Document): { state: EditorState } {
  const jumpUrl = document.querySelector<HTMLAnchorElement>("#jumpUrl")?.href ?? "";
  return classifyLoginTimeoutMarkers({
    bodyClasses: [...(document.body?.classList ?? [])],
    infoText: document.querySelector("#info")?.textContent ?? "",
    jumpUrl,
  });
}

export function observeLoginTimeout(
  document: Document,
  listener: (state: EditorState) => void,
): () => void {
  const report = () => listener(detectLoginTimeout(document).state);
  const observer = new MutationObserver(report);
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "href"],
  });
  report();
  return () => observer.disconnect();
}

export function waitForEditorPageDecision(
  document: Document,
  editorReady: () => boolean,
  timeoutMs = 10_000,
): { current(): EditorState; notify(): void; result: Promise<EditorState>; dispose(): void } {
  let settled = false;
  let resolveResult!: (state: EditorState) => void;
  const result = new Promise<EditorState>((resolve) => {
    resolveResult = resolve;
  });
  const evaluate = (): EditorState => {
    if (detectLoginTimeout(document).state === "not_logged_in") return "not_logged_in";
    if (document.readyState === "loading") return "loading";
    const route = classifyObservedRoute(document.URL);
    if (route === "draft-list") {
      const cards = [
        ...document.querySelectorAll<HTMLElement>(".weui-desktop-card[data-appid]"),
      ].filter((card) => card.isConnected);
      return cards.length > 0 ? "ready" : "loading";
    }
    if (route === "editor") return editorReady() ? "ready" : "loading";
    return "loading";
  };
  const finish = (state: EditorState) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    observer.disconnect();
    document.removeEventListener("DOMContentLoaded", checkReady);
    document.removeEventListener("load", checkReady, true);
    document.defaultView?.removeEventListener("load", checkReady);
    resolveResult(state);
  };
  const checkReady = () => {
    const state = evaluate();
    if (state !== "loading") finish(state);
  };
  const observer = new MutationObserver(checkReady);
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "href"],
  });
  document.addEventListener("DOMContentLoaded", checkReady);
  document.addEventListener("load", checkReady, true);
  document.defaultView?.addEventListener("load", checkReady);
  const timer = setTimeout(() => finish("loading"), timeoutMs);
  const initial = evaluate();
  if (initial !== "loading") finish(initial);
  return { current: evaluate, notify: checkReady, result, dispose: () => finish("loading") };
}

export function waitForDocumentReady(document: Document, timeoutMs = 10_000): Promise<boolean> {
  // DOM availability is separate from editor/JSAPI readiness. Images and other
  // subresources must not prevent an already parsed editor from bootstrapping.
  if (document.readyState !== "loading") return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      document.removeEventListener("DOMContentLoaded", check);
      document.defaultView?.removeEventListener("load", check);
      resolve(ready || document.readyState !== "loading");
    };
    const check = () => {
      if (document.readyState !== "loading") finish(true);
    };
    document.addEventListener("DOMContentLoaded", check);
    document.defaultView?.addEventListener("load", check);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function classifyObservedRoute(documentUrl: string): "draft-list" | "editor" | "unsupported" {
  try {
    const url = new URL(documentUrl);
    if (url.origin !== "https://mp.weixin.qq.com" || url.pathname !== "/cgi-bin/appmsg")
      return "unsupported";
    if (url.searchParams.get("action") === "list_card" && url.searchParams.get("type") === "77")
      return "draft-list";
    if (url.searchParams.get("action") === "edit" && url.searchParams.get("type") === "77")
      return "editor";
    return "unsupported";
  } catch {
    return "unsupported";
  }
}

export function classifyEditorReadiness(input: {
  loginTimeout: boolean;
  jsapiAvailable: boolean;
}): EditorState {
  if (input.loginTimeout) return "not_logged_in";
  if (!input.jsapiAvailable) return "loading";
  return "ready";
}

export function detectEditorState(): EditorState {
  const page = window as Window & { __MP_Editor_JSAPI__?: { invoke?: unknown } };
  const login = detectLoginTimeout(document);
  if (login.state === "not_logged_in") return login.state;
  return classifyEditorReadiness({
    loginTimeout: false,
    jsapiAvailable: typeof page.__MP_Editor_JSAPI__?.invoke === "function",
  });
}
