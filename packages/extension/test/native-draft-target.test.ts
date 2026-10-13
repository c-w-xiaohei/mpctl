import { expect, test } from "bun:test";
import { captureNativeDraftEditorUrl } from "../src/pages";

const target =
  "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=synthetic-draft&token=fixture&lang=zh_CN";

async function withNativeLink(
  href: string,
  handler: (page: Window, link: HTMLAnchorElement) => void,
  toolbarVisible = true,
) {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const page = { open: () => null } as unknown as Window;
  const originalOpen = page.open;
  const listeners = new Set<unknown>();
  const link = {
    href,
    hidden: false,
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({
          display: toolbarVisible ? "block" : "none",
          visibility: "visible",
        }),
      },
    },
    getClientRects: () => (toolbarVisible ? [1] : []),
    addEventListener: (_event: string, listener: unknown) => listeners.add(listener),
    removeEventListener: (_event: string, listener: unknown) => listeners.delete(listener),
    click: () => handler(page, link as unknown as HTMLAnchorElement),
  };
  const card = {
    getAttribute: (name: string) => (name === "data-appid" ? "synthetic-draft" : null),
    querySelectorAll: () => [link],
    hidden: false,
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    },
    getClientRects: () => [1],
  };
  Object.assign(globalThis, {
    window: page,
    document: {
      location: {
        href: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10",
      },
      querySelectorAll: () => [card],
    },
  });
  try {
    const result = await captureNativeDraftEditorUrl("synthetic-draft");
    expect(page.open).toBe(originalOpen);
    expect(listeners.size).toBe(0);
    return result;
  } finally {
    Object.assign(globalThis, { window: priorWindow, document: priorDocument });
  }
}

test("opens a supported native saved Edit href without requiring a click handler", async () => {
  let clicks = 0;
  expect(
    await withNativeLink(target, () => {
      clicks++;
    }),
  ).toEqual({ kind: "captured", url: target, notDispatched: true, ended: true });
  expect(clicks).toBe(0);
});

test("unreviewed asynchronous placeholder DOM handler is refused without invoking it", async () => {
  expect(
    await withNativeLink("javascript:;", (page) => {
      setTimeout(() => page.open(target), 20);
    }),
  ).toEqual({ kind: "control_unavailable", ended: true });
});

test("reads the native href on a visible card with a hidden hover toolbar", async () => {
  expect(
    await withNativeLink(
      target,
      () => {
        throw new Error("must not click hidden toolbar");
      },
      false,
    ),
  ).toEqual({ kind: "captured", url: target, notDispatched: true, ended: true });
});

test("rejects multiple native saved targets and restores the temporary hook", async () => {
  expect(
    await withNativeLink("javascript:;", (page) => {
      page.open(target);
      page.open(target.replace("token=fixture", "token=other"));
    }),
  ).toEqual({ kind: "control_unavailable", ended: true });
});
