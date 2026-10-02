import { chromium, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const fixtureExtension = path.join(
  root,
  "packages/extension/.output/browser-bridge-fixture/chrome-mv3",
);
const fixtureRoot = path.join(root, "packages/extension/test/browser/fixtures/bridge");
const fixtureUrl = "https://mp.weixin.qq.com/cgi-bin/appmsg?t=fixture";

test("production page endpoints preserve binary offsets and ordering across MAIN/ISOLATED worlds", async () => {
  test.setTimeout(30_000);
  const temp = await mkdtemp(path.join(os.tmpdir(), "mpctl-bridge-browser-"));
  const context = await chromium.launchPersistentContext(path.join(temp, "profile"), {
    channel: "chromium",
    headless: true,
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${fixtureExtension}`,
      `--load-extension=${fixtureExtension}`,
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--host-resolver-rules=MAP mp.weixin.qq.com ~NOTFOUND, EXCLUDE localhost",
    ],
  });
  try {
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "mp.weixin.qq.com" && url.pathname === "/cgi-bin/appmsg") {
        await route.fulfill({
          path: path.join(fixtureRoot, "index.html"),
          contentType: "text/html",
        });
        return;
      }
      if (url.hostname === "mp.weixin.qq.com" && url.pathname === "/cgi-bin/jsapi.js") {
        await route.fulfill({
          path: path.join(fixtureRoot, "jsapi.js"),
          contentType: "text/javascript",
        });
        return;
      }
      if (url.protocol === "chrome-extension:" || url.protocol === "devtools:")
        return route.continue();
      return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (route) =>
      route.close({ code: 1008, reason: "Offline fixture" }),
    );
    const page = await context.newPage();
    await page.goto(fixtureUrl);
    await expect
      .poll(() => page.locator("html").getAttribute("data-mpctl-fixture-ready"))
      .toBe("yes");
    await expect
      .poll(() => page.locator("html").getAttribute("data-mpctl-main-connected"))
      .toBe("yes");

    const bridgeRun = await page.evaluate(async () => {
      const received: unknown[] = [];
      const listener = (event: Event) =>
        received.push(JSON.parse((event as CustomEvent<string>).detail));
      document.addEventListener("mpctl-fixture-message", listener);
      document.dispatchEvent(
        new CustomEvent("mpctl-fixture-command", {
          detail: JSON.stringify({
            messages: [
              { sequence: 1, bytes: [3, 4, 5] },
              { sequence: 2, bytes: [4, 5], view: "dataview" },
            ],
            envelopes: [
              { status: "ok", value: { article: "synthetic-article", bodyHash: "abc123" } },
              { status: "error", error: { code: "page_failed" } },
            ],
          }),
        }),
      );
      await new Promise((resolve) => {
        const check = () => (received.length === 5 ? resolve(undefined) : setTimeout(check, 5));
        check();
      });
      document.removeEventListener("mpctl-fixture-message", listener);
      return received;
    });
    // MAIN queues ack(1), ack(2), then both envelopes. The isolated ack(1)
    // handler enqueues binary sequence 3 after that already queued work.
    expect(bridgeRun).toEqual([
      { kind: "ack", sequence: 1, bytes: { type: "Uint8Array", values: [3, 4, 5] } },
      { kind: "ack", sequence: 2, bytes: { type: "DataView", values: [4, 5] } },
      { status: "ok", value: { article: "synthetic-article", bodyHash: "abc123" } },
      { status: "error", error: { code: "page_failed" } },
      { kind: "ack", sequence: 3, bytes: { type: "Uint8Array", values: [8, 9] } },
    ]);
    expect(
      await page
        .locator("html")
        .getAttribute("data-mpctl-main-received")
        .then((value) =>
          JSON.parse(value ?? "[]")
            .map((message: { sequence?: number }) => message.sequence ?? null)
            .filter((sequence: number | null): sequence is number => sequence !== null),
        ),
    ).toEqual([1, 2, 3]);
    await expect
      .poll(() => page.locator("html").getAttribute("data-mpctl-main-plain-envelopes"))
      .toBe("[true,true]");
    await expect
      .poll(() => page.locator("html").getAttribute("data-mpctl-isolated-plain-envelopes"))
      .toBe("[true,true]");

    await page.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent("mpctl-fixture-main-command", { detail: JSON.stringify({ close: true }) }),
      );
    });
    await expect
      .poll(() => page.locator("html").getAttribute("data-mpctl-main-closed"))
      .toBe("yes");
    await expect
      .poll(() => page.locator("html").getAttribute("data-mpctl-fixture-peer-closed"))
      .toBe("yes");
    await page.reload();
    await expect
      .poll(() => page.locator("html").getAttribute("data-mpctl-fixture-ready"))
      .toBe("yes");
    await expect
      .poll(() => page.locator("html").getAttribute("data-mpctl-main-connected"))
      .toBe("yes");
  } finally {
    await context.close();
    await rm(temp, { recursive: true, force: true });
  }
});
