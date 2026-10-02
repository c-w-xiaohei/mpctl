import { describe, expect, test } from "bun:test";
import {
  classifyEditorReadiness,
  classifyLoginTimeoutMarkers,
  classifyContentPageState,
  waitForEditorPageDecision,
  waitForLoginTimeoutState,
  createEditorTargetValidator,
} from "../src/mp/editor";

describe("editor readiness classification", () => {
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

  test("observes timeout markers that appear after document_start", async () => {
    const listeners = new Map<string, () => void>();
    const classes = new Set<string>();
    let info = "";
    let href = "";
    let observerCallback: (() => void) | undefined;
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
      disconnect() {}
    } as unknown as typeof MutationObserver;
    try {
      const pending = waitForLoginTimeoutState(document as unknown as Document, 1_000);
      classes.add("page_error");
      classes.add("page_timeout");
      info = "登录超时，请重新登录";
      href = "https://mp.weixin.qq.com/cgi-bin/loginpage?url=secret";
      observerCallback?.();
      expect(await pending).toEqual({ state: "not_logged_in" });
      expect(listeners.has("DOMContentLoaded")).toBe(false);
    } finally {
      globalThis.MutationObserver = original;
    }
  });

  test("does not treat a DOM-ready empty list as usable, and reclassifies late timeout evidence", () => {
    const route = "appmsg|list_card|type=77|begin=0|count=10";
    const emptyList = {
      routeKind: "draft-list" as const,
      documentReady: true,
      visibleDraftCards: 0,
      editorReady: false,
      loginTimeout: false,
    };
    expect(classifyContentPageState(emptyList)).toBe("loading");
    expect(classifyContentPageState({ ...emptyList, visibleDraftCards: 1 })).toBe("ready");
    expect(
      classifyContentPageState({ ...emptyList, loginTimeout: true, visibleDraftCards: 1 }),
    ).toBe("not_logged_in");
    // Status is re-read from the same document on every query; late timeout markers override a previous loading observation.
    const observations = [
      classifyContentPageState(emptyList),
      classifyContentPageState({ ...emptyList, loginTimeout: true }),
    ];
    expect(observations).toEqual(["loading", "not_logged_in"]);
    expect(route).toContain("begin=0");
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
