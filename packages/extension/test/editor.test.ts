import { describe, expect, test } from "bun:test";
import {
  classifyEditorReadiness,
  classifyLoginTimeoutMarkers,
  waitForEditorPageDecision,
  observeLoginTimeout,
  createEditorTargetValidator,
  waitForDocumentReady,
} from "../src/mp/editor";

describe("editor readiness classification", () => {
  test.each(["interactive", "complete"] as const)(
    "accepts parsed %s documents without waiting for external resources",
    async (readyState) => {
      const events = new EventTarget();
      const document = {
        readyState,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      } as unknown as Document;
      expect(await waitForDocumentReady(document, 0)).toBe(true);
    },
  );

  test("settles on DOMContentLoaded and removes readiness listeners", async () => {
    const documentEvents = new EventTarget();
    const windowEvents = new EventTarget();
    const removed: string[] = [];
    let readyState = "loading";
    const document = {
      get readyState() {
        return readyState;
      },
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener(type: string, listener: EventListener) {
        removed.push(type);
        documentEvents.removeEventListener(type, listener);
      },
      defaultView: {
        addEventListener: windowEvents.addEventListener.bind(windowEvents),
        removeEventListener(type: string, listener: EventListener) {
          removed.push(type);
          windowEvents.removeEventListener(type, listener);
        },
      },
    } as unknown as Document;
    const pending = waitForDocumentReady(document, 1_000);
    readyState = "interactive";
    documentEvents.dispatchEvent(new Event("DOMContentLoaded"));
    expect(await pending).toBe(true);
    expect(removed).toEqual(["DOMContentLoaded", "load"]);
  });

  test("a document that remains unparsed times out instead of becoming ready", async () => {
    const events = new EventTarget();
    const document = {
      readyState: "loading",
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } as unknown as Document;
    expect(await waitForDocumentReady(document, 0)).toBe(false);
  });

  test("parsed DOM still requires positive draft or editor evidence", async () => {
    const events = new EventTarget();
    let cards: { isConnected: boolean }[] = [];
    const document = {
      readyState: "interactive",
      URL: "https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card",
      body: { classList: [] },
      querySelector: () => null,
      querySelectorAll: () => cards,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } as unknown as Document;
    const original = globalThis.MutationObserver;
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof MutationObserver;
    try {
      const decision = waitForEditorPageDecision(document, () => false, 1_000);
      expect(decision.current()).toBe("loading");
      cards = [{ isConnected: true }];
      decision.notify();
      expect(await decision.result).toBe("ready");
      Object.defineProperty(document, "URL", {
        value: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&type=77",
      });
      const editor = waitForEditorPageDecision(document, () => false, 0);
      expect(await editor.result).toBe("loading");
    } finally {
      globalThis.MutationObserver = original;
    }
  });

  test("distinguishes a logged-out page from an editor still loading", () => {
    expect(classifyEditorReadiness({ loginTimeout: true, jsapiAvailable: false })).toBe(
      "not_logged_in",
    );
    expect(classifyEditorReadiness({ loginTimeout: false, jsapiAvailable: false })).toBe("loading");
    expect(classifyEditorReadiness({ loginTimeout: false, jsapiAvailable: true })).toBe("ready");
  });

  test("requires the observed complete timeout marker combination and never returns jump URL", () => {
    const markers = {
      bodyClasses: ["page_error", "page_timeout"],
      infoText: "登录超时，请重新登录",
      jumpUrl: "https://mp.weixin.qq.com/cgi-bin/loginpage?url=secret-token",
    };
    expect(classifyLoginTimeoutMarkers(markers)).toEqual({ state: "not_logged_in" });
    expect(classifyLoginTimeoutMarkers({ ...markers, bodyClasses: ["page_error"] })).toEqual({
      state: "loading",
    });
    expect(classifyLoginTimeoutMarkers({ ...markers, infoText: "请重新登录" })).toEqual({
      state: "loading",
    });
    expect(
      classifyLoginTimeoutMarkers({
        ...markers,
        jumpUrl: "https://evil.example/cgi-bin/loginpage",
      }),
    ).toEqual({ state: "loading" });
    expect(
      classifyLoginTimeoutMarkers({ ...markers, jumpUrl: "https://mp.weixin.qq.com/other" }),
    ).toEqual({ state: "loading" });
    expect(classifyLoginTimeoutMarkers({ bodyClasses: [], infoText: "", jumpUrl: "" })).toEqual({
      state: "loading",
    });
  });

  test("recognizes the observed empty-info re-login page without accepting arbitrary login text", () => {
    const markers = {
      bodyClasses: ["page_error", "page_timeout"],
      infoText: "",
      headingText: " \n 请重新 登录 ",
      jumpUrl: "https://mp.weixin.qq.com/cgi-bin/loginpage?url=private",
    };
    expect(classifyLoginTimeoutMarkers(markers)).toEqual({ state: "not_logged_in" });
    for (const changed of [
      { bodyClasses: [] },
      { headingText: "登录" },
      { headingText: undefined },
      { jumpUrl: "https://other.example/cgi-bin/loginpage" },
      { infoText: "未知错误" },
    ])
      expect(classifyLoginTimeoutMarkers({ ...markers, ...changed })).toEqual({ state: "loading" });
  });

  test("observes late login timeout markers until the runtime watcher is disposed", () => {
    const listeners = new Map<string, () => void>();
    const classes = new Set<string>();
    let info = "";
    let href = "";
    let observerCallback: (() => void) | undefined;
    let disconnected = 0;
    const document = {
      readyState: "loading",
      body: { classList: { [Symbol.iterator]: () => classes.values() } },
      querySelector(selector: string) {
        if (selector === "#info") return { textContent: info };
        if (selector === "#jumpUrl") return { href };
        return null;
      },
      addEventListener(name: string, callback: () => void) {
        listeners.set(name, callback);
      },
      removeEventListener(name: string) {
        listeners.delete(name);
      },
      documentElement: {},
    };
    const original = globalThis.MutationObserver;
    globalThis.MutationObserver = class {
      constructor(callback: () => void) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {
        disconnected++;
      }
    } as unknown as typeof MutationObserver;
    try {
      const states: string[] = [];
      const stop = observeLoginTimeout(document as unknown as Document, (state) =>
        states.push(state),
      );
      expect(states).toEqual(["loading"]);
      classes.add("page_error");
      classes.add("page_timeout");
      info = "登录超时，请重新登录";
      href = "https://mp.weixin.qq.com/cgi-bin/loginpage?url=secret";
      observerCallback?.();
      expect(states).toEqual(["loading", "not_logged_in"]);
      expect(disconnected).toBe(0);
      stop();
      expect(disconnected).toBe(1);
    } finally {
      globalThis.MutationObserver = original;
    }
  });

  test("continues observing a DOM-ready ambiguous page past the old window and catches late timeout markers", async () => {
    let bodyClasses = new Set<string>();
    let info = "";
    let href = "";
    let observerCallback: (() => void) | undefined;
    const document = {
      readyState: "complete",
      URL: "https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card",
      get body() {
        return { classList: { [Symbol.iterator]: () => bodyClasses.values() } };
      },
      querySelector(selector: string) {
        if (selector === "#info") return { textContent: info };
        if (selector === "#jumpUrl") return { href };
        return null;
      },
      documentElement: {},
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll() {
        return [];
      },
    };
    const original = globalThis.MutationObserver;
    globalThis.MutationObserver = class {
      constructor(callback: () => void) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof MutationObserver;
    try {
      const decision = waitForEditorPageDecision(
        document as unknown as Document,
        () => false,
        3_000,
      );
      expect(decision.current()).toBe("loading");
      bodyClasses = new Set(["page_error", "page_timeout"]);
      info = "登录超时，请重新登录";
      href = "https://mp.weixin.qq.com/cgi-bin/loginpage?url=late-secret";
      observerCallback?.();
      await expect(decision.result).resolves.toBe("not_logged_in");
    } finally {
      globalThis.MutationObserver = original;
    }
  });
});

test("shared content/MAIN validator rechecks original route, saved current item and synchronous timeout markers", () => {
  let href =
    "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=g1";
  let timeout = false;
  let visibleCount = 1;
  let current = true;
  const document = {
    location: {
      get href() {
        return href;
      },
    },
    body: {
      get classList() {
        return timeout ? ["page_error", "page_timeout"] : [];
      },
    },
    querySelector(selector: string) {
      if (selector === "#info") return { textContent: timeout ? "登录超时" : "" };
      if (selector === "#jumpUrl")
        return { href: timeout ? "https://mp.weixin.qq.com/cgi-bin/loginpage" : "" };
      return null;
    },
    querySelectorAll() {
      return Array.from({ length: visibleCount }, (_, index) => ({
        hidden: false,
        getAttribute: () => String(index),
        classList: { contains: () => current && index === 0 },
        getClientRects: () => [1],
        ownerDocument: {
          defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
        },
      }));
    },
  } as unknown as Document;
  const valid = createEditorTargetValidator(document);
  expect(valid()).toBe(true);
  visibleCount = 2;
  expect(valid()).toBe(false);
  visibleCount = 1;
  current = false;
  expect(valid()).toBe(false);
  current = true;
  href = href.replace("g1", "g2");
  expect(valid()).toBe(false);
  href = href.replace("g2", "g1");
  timeout = true;
  expect(valid()).toBe(false);
  timeout = false;
  expect(valid()).toBe(true);
});
