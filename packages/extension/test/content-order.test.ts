import { describe, expect, test } from "bun:test";
import { Nexus } from "@nexus-js/core";
import { Result } from "better-result";
import type { SerializedResult } from "better-result";
import { createPageEndpoint } from "../src/transport/page-bridge";
import { captureNativeNewEditorUrl } from "../src/pages";
import { hashBody } from "../src/mp/body-hash";
import { detectLoginTimeout } from "../src/mp/editor";
import {
  pageEditorReadyResultCodec,
  pageEditorContentResultCodec,
  pageEditorWriteResultCodec,
  pageEditorToken,
} from "../src/page-contracts";
import {
  listDraftsResultCodec,
  openDraftResultCodec,
  validateDraftResultCodec,
  currentItemCountResultCodec,
  hasUniqueCurrentItemResultCodec,
  homeIsReadyResultCodec,
  openDraftListResultCodec,
  openNewEditorResultCodec,
} from "../src/background-contracts";

async function wire<T, E extends { code: string }>(
  encoded: Promise<Result<SerializedResult<T, E>, E>>,
) {
  const result = await encoded;
  return Result.isOk(result) ? result.value : { status: "error" as const, error: result.error };
}
import {
  createDraftPageService,
  createHomePageService,
  initializeContentServices,
  runContentStartup,
} from "../entrypoints/mp.content";

const token = pageEditorToken;

async function hashForTest(html: string): Promise<string> {
  const result = await hashBody(html);
  expect(Result.isOk(result)).toBe(true);
  return Result.isOk(result) ? result.value : "";
}

describe("content-script readiness ordering", () => {
  test("returns document timeout as Err and cleans login watcher and bridge without throwing", async () => {
    let watcherStopped = 0;
    let bridgeDisposed = 0;
    let prepared = 0;
    const startup = await runContentStartup({
      document: markerFreeDocument(),
      ctx: { onInvalidated() {} },
      route: { kind: "new" } as never,
      stopWatchingLogin: () => {
        watcherStopped++;
      },
      cleanupEditor: async () => {
        bridgeDisposed++;
        return Result.ok();
      },
      waitForDocument: async () => false,
      waitForDraftDecision: async () => "ready",
      prepareEditor: async () => {
        prepared++;
        return Result.ok();
      },
    });

    expect(startup).toEqual(Result.err({ code: "document_not_ready" }));
    expect([watcherStopped, bridgeDisposed, prepared]).toEqual([1, 1, 0]);
  });

  test("returns unsupported route and ambiguous draft readiness as Err without rejection", async () => {
    let watcherStopped = 0;
    const base = {
      document: markerFreeDocument(),
      ctx: { onInvalidated() {} },
      stopWatchingLogin: () => {
        watcherStopped++;
      },
      async cleanupEditor() {
        return Result.ok();
      },
      waitForDocument: async () => true,
      waitForDraftDecision: async () => "loading" as const,
      prepareEditor: async () => Result.ok(),
    };

    expect(await runContentStartup({ ...base, route: { kind: "unsupported" } as never })).toEqual(
      Result.err({ code: "route_unsupported" }),
    );
    expect(await runContentStartup({ ...base, route: { kind: "draft-list" } as never })).toEqual(
      Result.err({ code: "setup_failed" }),
    );
    expect(watcherStopped).toBe(2);
  });

  test("returns invalidation registration failure and cleans login watcher on each route", async () => {
    let watcherStopped = 0;
    const startup = await runContentStartup({
      document: markerFreeDocument(),
      ctx: {
        onInvalidated() {
          throw new Error("context invalidated");
        },
      },
      route: { kind: "home" } as never,
      stopWatchingLogin: () => {
        watcherStopped++;
      },
      waitForDocument: async () => true,
      waitForDraftDecision: async () => "ready",
      prepareEditor: async () => Result.ok(),
    });
    expect(startup).toEqual(Result.err({ code: "setup_failed" }));
    expect(watcherStopped).toBe(1);
  });

  test("cleans the editor bridge when expected editor setup returns Err", async () => {
    let watcherStopped = 0;
    let bridgeDisposed = 0;
    const startup = await runContentStartup({
      document: markerFreeDocument(),
      ctx: { onInvalidated() {} },
      route: { kind: "saved-editor" } as never,
      stopWatchingLogin: () => {
        watcherStopped++;
      },
      cleanupEditor: async () => {
        bridgeDisposed++;
        return Result.ok();
      },
      waitForDocument: async () => true,
      waitForDraftDecision: async () => "ready",
      prepareEditor: async () => Result.err({ code: "page_failed" }),
    });

    expect(startup).toEqual(Result.err({ code: "setup_failed" }));
    expect([watcherStopped, bridgeDisposed]).toEqual([1, 1]);
  });

  test("awaits bridge cleanup Err and still stops login observation", async () => {
    let watcherStopped = 0;
    let cleanupCount = 0;
    const registered: Array<() => void> = [];
    const startup = await runContentStartup({
      document: markerFreeDocument(),
      ctx: {
        onInvalidated(callback) {
          registered.push(callback);
        },
      },
      route: { kind: "saved-editor" } as never,
      stopWatchingLogin: () => {
        watcherStopped++;
      },
      cleanupEditor: async () => {
        cleanupCount++;
        return Result.err({ code: "cleanup_failed", cause: "disposal_failed" });
      },
      waitForDocument: async () => true,
      waitForDraftDecision: async () => "ready",
      prepareEditor: async () => Result.ok(),
    });
    expect(startup).toEqual(Result.ok());
    registered[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect([watcherStopped, cleanupCount]).toEqual([1, 1]);
  });

  test("rejects draft list reads after the same document drifts to another route or page", async () => {
    for (const nextUrl of [
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=group",
      "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=10&count=10",
      "https://mp.weixin.qq.com/cgi-bin/appmsg?action=unknown&type=77",
    ]) {
      let href =
        "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10";
      let cardReads = 0;
      const fixtureDocument = {
        location: {
          get href() {
            return href;
          },
        },
        querySelectorAll() {
          cardReads++;
          return [draftCard("group")];
        },
      } as unknown as Document;
      const service = createDraftPageService(fixtureDocument);
      href = nextUrl;

      expect(await listDraftsResultCodec.deserialize(await service.listDrafts())).toEqual(
        Result.err({ code: "route_changed" }),
      );
      expect(cardReads).toBe(0);
    }
  });

  test("rejects draft open after route drift without clicking Edit", async () => {
    let href = "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10";
    let clicks = 0;
    const fixtureDocument = {
      location: {
        get href() {
          return href;
        },
      },
      body: { classList: [] },
      querySelector: () => null,
      querySelectorAll(selector: string) {
        if (selector === ".weui-desktop-card[data-appid]")
          return [draftCard("group", () => clicks++)];
        return [];
      },
    } as unknown as Document;
    const service = createDraftPageService(fixtureDocument);

    href =
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=group";
    expect(await openDraftResultCodec.deserialize(await service.openDraft("group"))).toEqual(
      Result.err({ code: "route_changed" }),
    );
    expect(clicks).toBe(0);
  });

  test("rechecks route identity immediately before clicking Edit", async () => {
    let href = "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10";
    let cardReads = 0;
    let clicks = 0;
    const fixtureDocument = {
      location: {
        get href() {
          return href;
        },
      },
      querySelectorAll(selector: string) {
        if (selector !== ".weui-desktop-card[data-appid]") return [];
        cardReads++;
        if (cardReads === 2)
          href =
            "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=10&count=10";
        return [draftCard("group", () => clicks++)];
      },
    } as unknown as Document;
    const service = createDraftPageService(fixtureDocument);

    expect(await openDraftResultCodec.deserialize(await service.openDraft("group"))).toEqual(
      Result.err({ code: "draft_unavailable" }),
    );
    expect(clicks).toBe(0);
  });

  test("does not click Edit when the complete login-timeout page appears during visibility lookup", async () => {
    let timedOut = false;
    let clicks = 0;
    const edit = {
      hidden: false,
      getAttribute: () => null,
      getClientRects: () => [1],
      ownerDocument: {
        defaultView: {
          getComputedStyle() {
            timedOut = true;
            return { display: "block", visibility: "visible" };
          },
        },
      },
      click() {
        clicks++;
      },
    };
    const card = {
      getAttribute: (name: string) => (name === "data-appid" ? "group" : null),
      querySelector: (selector: string) =>
        selector === ".weui-desktop-publish__cover__title" ? { textContent: "title" } : edit,
    };
    const fixtureDocument = {
      location: {
        href: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10",
      },
      body: {
        get classList() {
          return timedOut ? ["page_error", "page_timeout"] : [];
        },
      },
      querySelectorAll: (selector: string) =>
        selector === ".weui-desktop-card[data-appid]" ? [card] : [],
      querySelector(selector: string) {
        if (selector === "#info") return { textContent: timedOut ? "登录超时" : "" };
        if (selector === "#jumpUrl")
          return { href: timedOut ? "https://mp.weixin.qq.com/cgi-bin/loginpage" : "" };
        return null;
      },
    } as unknown as Document;
    const service = createDraftPageService(fixtureDocument);

    expect(await openDraftResultCodec.deserialize(await service.openDraft("group"))).toEqual(
      Result.err({ code: "draft_unavailable" }),
    );
    expect(clicks).toBe(0);
  });

  test("blocks a timeout already present before openDraft begins", async () => {
    let clicks = 0;
    const fixtureDocument = loginTimeoutDraftDocument(() => clicks++);

    expect(
      await openDraftResultCodec.deserialize(
        await createDraftPageService(fixtureDocument).openDraft("group"),
      ),
    ).toEqual(Result.err({ code: "draft_unavailable" }));
    expect(clicks).toBe(0);
  });

  test("does not treat incomplete timeout markers as a login timeout", async () => {
    let clicks = 0;
    const fixtureDocument = loginTimeoutDraftDocument(() => clicks++, {
      bodyClasses: ["page_error", "page_timeout"],
      infoText: "登录超时",
      jumpUrl: "https://mp.weixin.qq.com/cgi-bin/other",
    });

    expect(
      await openDraftResultCodec.deserialize(
        await createDraftPageService(fixtureDocument).openDraft("group"),
      ),
    ).toEqual(Result.err({ code: "draft_unavailable" }));
    expect(clicks).toBe(0);
  });

  test("allows accepted context-only list URL changes and keeps saved-draft validation", async () => {
    let href = "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10";
    const fixtureDocument = {
      location: {
        get href() {
          return href;
        },
      },
      body: { classList: [] },
      querySelector: () => null,
      querySelectorAll(selector: string) {
        if (selector === ".weui-desktop-card[data-appid]")
          return [
            draftCard(
              "group",
              () => {},
              "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=group",
            ),
          ];
        if (selector === ".js_appmsg_item") return [documentItem("0", true, true)];
        return [];
      },
    } as unknown as Document;
    const service = createDraftPageService(fixtureDocument);
    href += "&lang=en_US&token=synthetic-context-token";
    expect(await listDraftsResultCodec.deserialize(await service.listDrafts())).toEqual(
      Result.ok([{ candidate: "group", title: "title" }]),
    );
    expect(await openDraftResultCodec.deserialize(await service.openDraft("group"))).toEqual(
      Result.ok(
        "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=group",
      ),
    );

    href =
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=group";
    expect(
      await validateDraftResultCodec.deserialize(await service.validateDraft("group")),
    ).toEqual(Result.ok({ valid: true, title: "" }));
    expect(await currentItemCountResultCodec.deserialize(await service.currentItemCount())).toEqual(
      Result.ok(1),
    );
  });

  test("counts every visible appmsg item through the draft page service", async () => {
    const current = documentItem("0", true, true);
    const nonCurrent = documentItem("1", true, false);
    const hidden = documentItem("2", false, false);
    const fixtureDocument = {
      location: {
        href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=group",
      },
      querySelectorAll(selector: string) {
        return selector === ".js_appmsg_item" ? [current, nonCurrent, hidden] : [];
      },
    } as unknown as Document;
    expect(
      await currentItemCountResultCodec.deserialize(
        await createDraftPageService(fixtureDocument).currentItemCount(),
      ),
    ).toEqual(Result.ok(2));
    expect(
      await validateDraftResultCodec.deserialize(
        await createDraftPageService(fixtureDocument).validateDraft("group"),
      ),
    ).toEqual(
      Result.ok({
        valid: false,
        title: "",
      }),
    );
  });

  test("reports whether the sole visible appmsg item is the observed current item", async () => {
    let items = [documentItem("0", true, false)];
    const fixtureDocument = {
      location: {
        href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
      },
      querySelectorAll(selector: string) {
        return selector === ".js_appmsg_item" ? items : [];
      },
    } as unknown as Document;
    const service = createDraftPageService(fixtureDocument);

    expect(
      await hasUniqueCurrentItemResultCodec.deserialize(await service.hasUniqueCurrentItem()),
    ).toEqual(Result.ok(false));
    items = [documentItem("0", true, true)];
    expect(
      await hasUniqueCurrentItemResultCodec.deserialize(await service.hasUniqueCurrentItem()),
    ).toEqual(Result.ok(true));
  });

  test("opens only uniquely visible observed native home controls", async () => {
    let draftClicks = 0;
    let articleClicks = 0;
    const visibleDraftLink = (click: () => void) =>
      ({
        textContent: "草稿箱",
        classList: {
          contains: (name: string) => name === "weui-desktop-menu__link" || name === "menu_report",
        },
        href: "https://mp.weixin.qq.com/cgi-bin/appmsg?begin=synthetic&count=synthetic&type=synthetic&action=synthetic&token=synthetic&lang=synthetic",
        hidden: false,
        getAttribute: () => null,
        getClientRects: () => [1],
        ownerDocument: {
          defaultView: {
            getComputedStyle: () => ({ display: "block", visibility: "visible" }),
          },
        },
        click,
      }) as unknown as HTMLElement;
    const visibleArticleItem = (click: () => void) =>
      ({
        tagName: "DIV",
        textContent: "文章",
        classList: { contains: (name: string) => name === "new-creation__menu-item" },
        hidden: false,
        getAttribute: () => null,
        getClientRects: () => [1],
        ownerDocument: {
          defaultView: {
            getComputedStyle: () => ({ display: "block", visibility: "visible" }),
          },
        },
        click,
      }) as unknown as HTMLElement;
    const fixtureDocument = {
      location: {
        href: "https://mp.weixin.qq.com/cgi-bin/home?t=synthetic&lang=synthetic&token=synthetic",
      },
      querySelectorAll(selector: string) {
        if (selector === "a.weui-desktop-menu__link.menu_report")
          return [visibleDraftLink(() => draftClicks++)];
        if (selector === "div.new-creation__menu-item")
          return [visibleArticleItem(() => articleClicks++)];
        return [];
      },
    };
    const home = createHomePageService(fixtureDocument as unknown as Document);

    expect(await homeIsReadyResultCodec.deserialize(await home.isReady())).toEqual(Result.ok(true));
    expect(await openDraftListResultCodec.deserialize(await home.openDraftList())).toEqual(
      Result.ok(
        "https://mp.weixin.qq.com/cgi-bin/appmsg?begin=synthetic&count=synthetic&type=synthetic&action=synthetic&token=synthetic&lang=synthetic",
      ),
    );
    expect(await openNewEditorResultCodec.deserialize(await home.openNewEditor())).toEqual(
      Result.ok(true),
    );
    expect([draftClicks, articleClicks]).toEqual([0, 1]);

    fixtureDocument.querySelectorAll = (selector: string) =>
      selector === "a.weui-desktop-menu__link.menu_report"
        ? [visibleDraftLink(() => draftClicks++), visibleDraftLink(() => draftClicks++)]
        : [];
    expect(await openDraftListResultCodec.deserialize(await home.openDraftList())).toEqual(
      Result.err({ code: "control_unavailable" }),
    );
    expect(await homeIsReadyResultCodec.deserialize(await home.isReady())).toEqual(
      Result.ok(false),
    );
    expect(draftClicks).toBe(0);
  });

  test("captures only the URL produced by the native Article handler despite popup blocking", async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const expected =
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=synthetic";
    const pageWindow: { open: (...args: string[]) => null } = {
      open() {
        throw new Error("popup should be intercepted before browser popup policy");
      },
    };
    const control = {
      textContent: "文章",
      hidden: false,
      classList: { contains: (name: string) => name === "new-creation__menu-item" },
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      },
      getClientRects: () => [1],
      click() {
        pageWindow.open(expected, "_blank");
      },
    };
    Object.assign(globalThis, {
      window: pageWindow,
      document: {
        location: { href: "https://mp.weixin.qq.com/cgi-bin/home?t=a&lang=b&token=c" },
        querySelectorAll: () => [control],
      },
    });
    try {
      await expect(captureNativeNewEditorUrl()).resolves.toEqual({
        kind: "captured",
        url: expected,
      });
      expect(pageWindow.open).toBeDefined();
    } finally {
      Object.assign(globalThis, { window: originalWindow, document: originalDocument });
    }
  });

  test("captures a native Article URL produced in the handler microtask", async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const expected =
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=async-context";
    let capturedByHook = false;
    const pageWindow: { open: (...args: string[]) => null } = {
      open() {
        return null;
      },
    };
    const control = {
      textContent: "文章",
      hidden: false,
      classList: { contains: (name: string) => name === "new-creation__menu-item" },
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      },
      getClientRects: () => [1],
      click() {
        queueMicrotask(() => {
          const activeOpen = pageWindow.open;
          activeOpen(expected, "_blank");
          capturedByHook = activeOpen !== originalOpen;
        });
      },
    };
    const originalOpen = pageWindow.open;
    Object.assign(globalThis, {
      window: pageWindow,
      document: {
        location: { href: "https://mp.weixin.qq.com/cgi-bin/home?t=a&lang=b&token=c" },
        querySelectorAll: () => [control],
      },
    });
    try {
      await expect(captureNativeNewEditorUrl()).resolves.toEqual({
        kind: "captured",
        url: expected,
      });
      expect(capturedByHook).toBe(true);
      expect(pageWindow.open).toBe(originalOpen);
    } finally {
      Object.assign(globalThis, { window: originalWindow, document: originalDocument });
    }
  });

  test("waits for a timer-scheduled native Article popup and restores the hook afterward", async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const expected =
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=timer-context";
    const pageWindow: { open: (...args: string[]) => null } = { open: () => null };
    const originalOpen = pageWindow.open;
    const control = {
      textContent: "文章",
      hidden: false,
      classList: { contains: (name: string) => name === "new-creation__menu-item" },
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      },
      getClientRects: () => [1],
      click() {
        setTimeout(() => pageWindow.open(expected, "_blank"), 35);
      },
    };
    Object.assign(globalThis, {
      window: pageWindow,
      document: {
        location: { href: "https://mp.weixin.qq.com/cgi-bin/home?t=a&lang=b&token=c" },
        querySelectorAll: () => [control],
      },
    });
    try {
      await expect(captureNativeNewEditorUrl()).resolves.toEqual({
        kind: "captured",
        url: expected,
      });
      expect(pageWindow.open).toBe(originalOpen);
    } finally {
      Object.assign(globalThis, { window: originalWindow, document: originalDocument });
    }
  });

  test("forwards unrelated window.open calls while capturing only the native editor target", async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const expected =
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=native";
    const unrelated = "https://support.example.test/help";
    const forwarded: string[] = [];
    const pageWindow: { open: (...args: string[]) => null } = {
      open: (url) => {
        forwarded.push(url ?? "");
        return null;
      },
    };
    const originalOpen = pageWindow.open;
    const control = {
      textContent: "文章",
      hidden: false,
      classList: { contains: (name: string) => name === "new-creation__menu-item" },
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      },
      getClientRects: () => [1],
      click() {
        pageWindow.open(unrelated, "_blank");
        pageWindow.open(expected, "_blank");
      },
    };
    Object.assign(globalThis, {
      window: pageWindow,
      document: {
        location: { href: "https://mp.weixin.qq.com/cgi-bin/home?t=home&token=private" },
        querySelectorAll: () => [control],
      },
    });
    try {
      await expect(captureNativeNewEditorUrl()).resolves.toEqual({
        kind: "captured",
        url: expected,
      });
      expect(forwarded).toEqual([unrelated]);
      expect(pageWindow.open).toBe(originalOpen);
    } finally {
      Object.assign(globalThis, { window: originalWindow, document: originalDocument });
    }
  });

  test("rejects multiple native Article popup targets as ambiguous", async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const first =
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=first";
    const second = first.replace("token=first", "token=second");
    const pageWindow: { open: (...args: string[]) => null } = { open: () => null };
    const originalOpen = pageWindow.open;
    const control = {
      textContent: "文章",
      hidden: false,
      classList: { contains: (name: string) => name === "new-creation__menu-item" },
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      },
      getClientRects: () => [1],
      click() {
        setTimeout(() => {
          pageWindow.open(first, "_blank");
          pageWindow.open(second, "_blank");
        }, 20);
      },
    };
    Object.assign(globalThis, {
      window: pageWindow,
      document: {
        location: { href: "https://mp.weixin.qq.com/cgi-bin/home?t=a&lang=b&token=c" },
        querySelectorAll: () => [control],
      },
    });
    try {
      await expect(captureNativeNewEditorUrl()).resolves.toEqual({ kind: "ambiguous" });
      expect(pageWindow.open).toBe(originalOpen);
    } finally {
      Object.assign(globalThis, { window: originalWindow, document: originalDocument });
    }
  });

  test("classifies a native same-origin editor target with an unsupported route", async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const pageWindow: { open: (...args: string[]) => null } = { open: () => null };
    const control = {
      textContent: "文章",
      hidden: false,
      classList: { contains: (name: string) => name === "new-creation__menu-item" },
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      },
      getClientRects: () => [1],
      click() {
        queueMicrotask(() =>
          pageWindow.open(
            "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&type=77&appmsgid=unexpected",
            "_blank",
          ),
        );
      },
    };
    Object.assign(globalThis, {
      window: pageWindow,
      document: {
        location: { href: "https://mp.weixin.qq.com/cgi-bin/home?t=home&token=private" },
        querySelectorAll: () => [control],
      },
    });
    try {
      await expect(captureNativeNewEditorUrl()).resolves.toEqual({ kind: "unsupported" });
    } finally {
      Object.assign(globalThis, { window: originalWindow, document: originalDocument });
    }
  });

  test("does not expose MAIN or background editor readiness on a login-timeout page", async () => {
    let connects = 0;
    const result = await initializeContentServices({
      document: markerFreeDocument(),
      pageRuntime: { connect: async () => (connects++, {}) } as never,
      chromeRuntime: {} as never,
      pageState: async () => ({
        state: "not_logged_in",
        route: "saved-route",
        documentReady: true,
      }),
      validateTarget: () => true,
    });
    expect(result).toEqual(Result.err({ code: "not_logged_in" }));
    expect(connects).toBe(0);
  });

  test("fails closed for an unsupported editor version over a real page endpoint", async () => {
    const target = new EventTarget();
    const eventNames = { fromIsolated: "test:isolated:legacy", fromMain: "test:main:legacy" };
    const isolated = createPageEndpoint({
      target,
      channelId: "legacy",
      side: "isolated",
      eventNames,
    });
    const main = createPageEndpoint({ target, channelId: "legacy", side: "main", eventNames });
    const mainRuntime = new Nexus()
      .provide(token, {
        ready: async () =>
          wire(
            pageEditorReadyResultCodec.serialize(
              Result.ok({ isReady: true as const, isNew: false as const }),
            ),
          ),
        getContent: async () =>
          wire(pageEditorContentResultCodec.serialize(Result.ok("must not read"))),
        setContent: async () => {
          throw new Error("must not write");
        },
      } as never)
      .configure({ endpoint: { implementation: main, meta: {} } });
    const pageRuntime = new Nexus().configure({ endpoint: { implementation: isolated, meta: {} } });
    await Promise.all([mainRuntime.ready(), pageRuntime.ready()]);
    try {
      const result = await initializeContentServices(
        {
          document: markerFreeDocument(),
          pageRuntime,
          chromeRuntime: {} as never,
          validateTarget: () => true,
          pageState: async () => ({ state: "ready", route: "saved", documentReady: true }),
        },
        token,
      );
      expect(result).toEqual(Result.err({ code: "unsupported_editor" }));
    } finally {
      await Promise.all([isolated.close?.(), main.close?.()]);
    }
  });

  test("disconnects the acquired page connection when invalidation disposer registration throws", async () => {
    let disconnected = 0;
    const target = new EventTarget();
    const eventNames = {
      fromIsolated: "test:isolated:dispose-fail",
      fromMain: "test:main:dispose-fail",
    };
    const isolated = createPageEndpoint({
      target,
      channelId: "dispose-fail",
      side: "isolated",
      eventNames,
    });
    const mainEndpoint = createPageEndpoint({
      target,
      channelId: "dispose-fail",
      side: "main",
      eventNames,
    });
    const main = new Nexus()
      .provide(token, {
        ready: async () =>
          wire(
            pageEditorReadyResultCodec.serialize(
              Result.ok({ isReady: true as const, isNew: true }),
            ),
          ),
        getContent: async () => wire(pageEditorContentResultCodec.serialize(Result.ok("body"))),
        setContent: async () =>
          wire(pageEditorWriteResultCodec.serialize(Result.ok({ bodyHash: "0".repeat(64) }))),
      } as never)
      .configure({ endpoint: { implementation: mainEndpoint, meta: {} } });
    const page = new Nexus().configure({ endpoint: { implementation: isolated, meta: {} } });
    const chrome = localNexusPeer("dispose-fail-chrome");
    await Promise.all([main.ready(), page.ready(), chrome.server.ready(), chrome.client.ready()]);
    try {
      const result = await initializeContentServices({
        document: markerFreeDocument(),
        pageRuntime: {
          async connect(options: unknown) {
            const connection = await page.connect(options as never);
            return {
              ...connection,
              disconnect() {
                disconnected++;
                connection.disconnect();
              },
            };
          },
        } as never,
        chromeRuntime: chrome.server as never,
        validateTarget: () => true,
        pageState: async () => ({ state: "ready" as const, route: "fixture", documentReady: true }),
        onDispose() {
          throw new Error("WXT invalidation registration failed");
        },
      });
      expect(Result.isError(result)).toBe(true);
      expect(disconnected).toBe(1);
      await Promise.all([isolated.close?.(), mainEndpoint.close?.(), chrome.close()]);
    } finally {
      await Promise.all([isolated.close?.(), mainEndpoint.close?.(), chrome.close()]);
    }
  });

  test("disconnects acquired page connection when Relay creation fails", async () => {
    let disconnected = 0;
    const pageRuntime = {
      async connect() {
        return {
          get() {
            return {
              ready: async () =>
                wire(
                  pageEditorReadyResultCodec.serialize(
                    Result.ok({ isReady: true as const, isNew: true }),
                  ),
                ),
            };
          },
          disconnect() {
            disconnected++;
            throw new Error("page disconnect failed");
          },
        };
      },
    };
    const result = await initializeContentServices({
      document: markerFreeDocument(),
      pageRuntime: pageRuntime as never,
      chromeRuntime: {} as never,
      validateTarget: () => true,
      pageState: async () => ({ state: "ready" as const, route: "fixture", documentReady: true }),
    });
    expect(result).toEqual(Result.err({ code: "page_failed" }));
    expect(disconnected).toBe(1);
  });

  test("reports page disconnect cleanup Err while preserving Relay creation Err", async () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args[1]);
    let disconnected = 0;
    try {
      const pageRuntime = {
        async connect() {
          return {
            get() {
              return {
                ready: async () =>
                  wire(
                    pageEditorReadyResultCodec.serialize(
                      Result.ok({ isReady: true as const, isNew: true }),
                    ),
                  ),
              };
            },
            disconnect() {
              disconnected++;
              throw new Error("disconnect failed");
            },
          };
        },
      };
      const result = await initializeContentServices({
        document: markerFreeDocument(),
        pageRuntime: pageRuntime as never,
        chromeRuntime: {} as never,
        validateTarget: () => true,
        pageState: async () => ({ state: "ready" as const, route: "fixture", documentReady: true }),
      });
      expect(result).toEqual(Result.err({ code: "page_failed" }));
      expect(disconnected).toBe(1);
      expect(errors).toEqual([{ code: "page_failed" }]);
    } finally {
      console.error = originalError;
    }
  });

  test("does not publish a page or background service when MAIN handshake fails", async () => {
    const pageRuntime = {
      connect: async () => {
        throw new Error("MAIN handshake failed");
      },
    };
    const chrome = localNexusPeer("handshake-failure");
    const result = await initializeContentServices(
      {
        document: markerFreeDocument(),
        pageRuntime: pageRuntime as never,
        chromeRuntime: chrome.server as never,
        validateTarget: () => true,
        pageState: async () => ({
          state: "ready" as const,
          route: "fixture",
          documentReady: true,
        }),
      },
      token,
    );
    expect(result).toEqual(Result.err({ code: "page_failed" }));
    const clientConnection = await chrome.client.connect({ target: {} });
    let editorReady = false;
    clientConnection.subscribeIdentity((meta) => {
      editorReady = (meta as { app?: { editorReady?: boolean } }).app?.editorReady === true;
    });
    expect(editorReady).toBe(false);
    await chrome.close();
  });

  test("fails closed and disconnects when MAIN has no JSAPI", async () => {
    let disconnected = false;
    const chrome = localNexusPeer("missing-jsapi");
    const pageRuntime = {
      async connect() {
        return {
          disconnect() {
            disconnected = true;
          },
          get() {
            return {
              ready: async () => {
                return wire(
                  pageEditorReadyResultCodec.serialize(Result.err({ code: "jsapi_unavailable" })),
                );
              },
            };
          },
        };
      },
    };

    const result = await initializeContentServices(
      {
        document: markerFreeDocument(),
        pageRuntime: pageRuntime as never,
        chromeRuntime: chrome.server as never,
        validateTarget: () => true,
        pageState: async () => ({ state: "ready" as const, route: "fixture", documentReady: true }),
      },
      token,
    );

    expect(result).toEqual(Result.err({ code: "jsapi_unavailable" }));
    expect(disconnected).toBe(true);
    const clientConnection = await chrome.client.connect({ target: {} });
    let editorReady = false;
    clientConnection.subscribeIdentity((meta) => {
      editorReady = (meta as { app?: { editorReady?: boolean } }).app?.editorReady === true;
    });
    expect(editorReady).toBe(false);
    await chrome.close();
  });

  test("allows editor service calls after trusted user interaction", async () => {
    const target = new EventTarget();
    const eventNames = { fromIsolated: "test:isolated:guard", fromMain: "test:main:guard" };
    const isolated = createPageEndpoint({
      target,
      channelId: "guard",
      side: "isolated",
      eventNames,
    });
    const main = createPageEndpoint({ target, channelId: "guard", side: "main", eventNames });
    let mainWrites = 0;
    const mainRuntime = new Nexus()
      .provide(token, {
        ready: async () =>
          wire(
            pageEditorReadyResultCodec.serialize(
              Result.ok({ isReady: true as const, isNew: true as const }),
            ),
          ),
        getContent: async () => wire(pageEditorContentResultCodec.serialize(Result.ok(""))),
        setContent: async () => {
          mainWrites++;
          return wire(
            pageEditorWriteResultCodec.serialize(Result.ok({ bodyHash: "0".repeat(64) })),
          );
        },
      })
      .configure({ endpoint: { implementation: main, meta: {} } });
    const pageRuntime = new Nexus().configure({ endpoint: { implementation: isolated, meta: {} } });
    await Promise.all([mainRuntime.ready(), pageRuntime.ready()]);
    const chrome = localNexusPeer("trusted");
    await initializeContentServices(
      {
        document: markerFreeDocument(),
        pageRuntime,
        chromeRuntime: chrome.server as never,
        validateTarget: () => true,
        pageState: async () => ({ state: "ready" as const, route: "fixture", documentReady: true }),
      },
      token,
    );
    const writesBeforeCall = mainWrites;
    const remote = await chrome.client.connect({ target: {} });
    const service = await remote.get(token);
    await service.setContent("<p>offline file edit</p>", await hashForTest(""));
    expect(mainWrites).toBeGreaterThan(writesBeforeCall);
    await Promise.all([isolated.close?.(), main.close?.(), chrome.close()]);
  });

  test("rechecks complete login-timeout markers before forwarding body calls to MAIN", async () => {
    const target = new EventTarget();
    const eventNames = { fromIsolated: "test:isolated:timeout", fromMain: "test:main:timeout" };
    const isolated = createPageEndpoint({
      target,
      channelId: "timeout",
      side: "isolated",
      eventNames,
    });
    const main = createPageEndpoint({ target, channelId: "timeout", side: "main", eventNames });
    let mainReads = 0;
    let mainWrites = 0;
    const mainRuntime = new Nexus()
      .provide(token, {
        ready: async () =>
          wire(
            pageEditorReadyResultCodec.serialize(
              Result.ok({ isReady: true as const, isNew: true as const }),
            ),
          ),
        getContent: async () => {
          mainReads++;
          return wire(pageEditorContentResultCodec.serialize(Result.ok("MAIN body")));
        },
        setContent: async () => {
          mainWrites++;
          return wire(
            pageEditorWriteResultCodec.serialize(Result.ok({ bodyHash: "0".repeat(64) })),
          );
        },
      })
      .configure({ endpoint: { implementation: main, meta: {} } });
    const pageRuntime = new Nexus().configure({ endpoint: { implementation: isolated, meta: {} } });
    await Promise.all([mainRuntime.ready(), pageRuntime.ready()]);

    let markers: { bodyClasses: string[]; infoText: string; jumpUrl: string } = {
      bodyClasses: [],
      infoText: "",
      jumpUrl: "",
    };
    const document = {
      body: {
        get classList() {
          return markers.bodyClasses;
        },
      },
      querySelector(selector: string) {
        if (selector === "#info") return { textContent: markers.infoText };
        if (selector === "#jumpUrl") return { href: markers.jumpUrl };
        return null;
      },
    } as unknown as Document;
    const chrome = localNexusPeer(
      "login-timeout",
      () => detectLoginTimeout(document).state !== "not_logged_in",
    );

    await initializeContentServices(
      {
        document,
        pageRuntime,
        chromeRuntime: chrome.server as never,
        validateTarget: () => true,
        pageState: async () => ({ state: "ready" as const, route: "fixture", documentReady: true }),
      },
      token,
    );
    const readsAtInitialization = mainReads;
    const writesAtInitialization = mainWrites;

    const remote = await chrome.client.connect({ target: {} });
    const service = await remote.get(token);
    expect(await pageEditorContentResultCodec.deserialize(await service.getContent())).toEqual(
      Result.ok("MAIN body"),
    );
    await service.setContent("stable body", await hashForTest("MAIN body"));
    expect(mainReads).toBeGreaterThan(readsAtInitialization);
    expect(mainWrites).toBeGreaterThan(writesAtInitialization);

    for (const incompleteMarkers of [
      {
        bodyClasses: ["page_error", "page_timeout"],
        infoText: "登录超时",
        jumpUrl: "https://mp.weixin.qq.com/cgi-bin/other",
      },
      {
        bodyClasses: ["page_error"],
        infoText: "登录超时",
        jumpUrl: "https://mp.weixin.qq.com/cgi-bin/loginpage",
      },
      {
        bodyClasses: ["page_error", "page_timeout"],
        infoText: "",
        jumpUrl: "https://mp.weixin.qq.com/cgi-bin/loginpage",
      },
    ]) {
      markers = incompleteMarkers;
      expect(await pageEditorContentResultCodec.deserialize(await service.getContent())).toEqual(
        Result.ok("MAIN body"),
      );
      await service.setContent("partial markers do not block", await hashForTest("MAIN body"));
    }
    expect(mainReads).toBeGreaterThan(readsAtInitialization);
    expect(mainWrites).toBeGreaterThan(writesAtInitialization);
    const forwardedReads = mainReads;
    const forwardedWrites = mainWrites;

    // Change the same document synchronously; no MutationObserver callback or status query runs.
    markers = {
      bodyClasses: ["page_error", "page_timeout"],
      infoText: "登录超时",
      jumpUrl: "https://mp.weixin.qq.com/cgi-bin/loginpage",
    };
    const blockedCalls = await Promise.allSettled([
      service.getContent(),
      service.setContent("must not reach MAIN", await hashForTest("MAIN body")),
    ]);
    expect(blockedCalls.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect([mainReads, mainWrites]).toEqual([forwardedReads, forwardedWrites]);

    await Promise.all([isolated.close?.(), main.close?.(), chrome.close()]);
  });
});

function documentItem(index: string, visible: boolean, current: boolean): HTMLElement {
  return {
    hidden: !visible,
    classList: { contains: (name: string) => name === "current" && current },
    getAttribute(name: string) {
      return name === "data-msgindex" ? index : null;
    },
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({ display: visible ? "block" : "none", visibility: "visible" }),
      },
    },
    getClientRects: () => (visible ? [1] : []),
  } as unknown as HTMLElement;
}

function markerFreeDocument(): Document {
  return {
    body: { classList: [] },
    querySelector: () => null,
  } as unknown as Document;
}

function localNexusPeer(channelId: string, allowsCalls: () => boolean = () => true) {
  const target = new EventTarget();
  const eventNames = {
    fromIsolated: `${channelId}:isolated`,
    fromMain: `${channelId}:main`,
  };
  const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
  const serverEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
  const client = new Nexus().configure({ endpoint: { implementation: clientEndpoint, meta: {} } });
  const server = new Nexus().configure({
    endpoint: { implementation: serverEndpoint, meta: {} },
    policy: { canCall: () => allowsCalls() },
  });
  return {
    client,
    server,
    async close() {
      await Promise.all([clientEndpoint.close?.(), serverEndpoint.close?.()]);
    },
  };
}

function draftCard(groupId: string, onClick: () => void = () => {}, href?: string): Element {
  return {
    getAttribute: (name: string) => (name === "data-appid" ? groupId : null),
    querySelector: (selector: string) =>
      selector === ".weui-desktop-publish__cover__title"
        ? { textContent: "title" }
        : {
            hidden: false,
            href,
            getAttribute: () => null,
            getClientRects: () => [1],
            ownerDocument: {
              defaultView: {
                getComputedStyle: () => ({ display: "block", visibility: "visible" }),
              },
            },
            click: onClick,
          },
  } as unknown as Element;
}

function loginTimeoutDraftDocument(
  onClick: () => void,
  markers = {
    bodyClasses: ["page_error", "page_timeout"],
    infoText: "登录超时",
    jumpUrl: "https://mp.weixin.qq.com/cgi-bin/loginpage",
  },
): Document {
  const edit = {
    hidden: false,
    getAttribute: () => null,
    getClientRects: () => [1],
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    },
    click: onClick,
  };
  const card = {
    getAttribute: (name: string) => (name === "data-appid" ? "group" : null),
    querySelector: (selector: string) =>
      selector === ".weui-desktop-publish__cover__title" ? { textContent: "title" } : edit,
  };
  return {
    location: {
      href: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10",
    },
    body: { classList: markers.bodyClasses },
    querySelectorAll: (selector: string) =>
      selector === ".weui-desktop-card[data-appid]" ? [card] : [],
    querySelector(selector: string) {
      if (selector === "#info") return { textContent: markers.infoText };
      if (selector === "#jumpUrl") return { href: markers.jumpUrl };
      return null;
    },
  } as unknown as Document;
}
