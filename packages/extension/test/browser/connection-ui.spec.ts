import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createBroker } from "../../../broker/src/server";

// This test owns an isolated extension context rather than the runner's browser fixture.
// oxlint-disable-next-line eslint/no-empty-pattern
test("production UI hides developer controls, follows system theme, and closes before the socket handshake", async ({}, testInfo) => {
  test.setTimeout(40_000);
  const temp = await mkdtemp("/tmp/opencode/mpctl-connection-ui-");
  const extension =
    process.env.MPCTL_BROWSER_EXTENSION_PATH ??
    path.resolve(import.meta.dirname, "../../.output/chrome-mv3");
  const sockets = new Set<Socket>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const created = await createBroker({
    ipcAddress: { kind: "path", path: path.join(temp, "broker.sock") },
    websocketPort: 0,
    pairingCredential: "isolated-ui-test-credential",
  });
  if (created.isErr()) throw new Error(created.error.code);
  const broker = created.value;
  const address = broker.address().unwrap();
  const proxy = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    void gate.then(() => {
      if (client.destroyed) return;
      const upstream = connect(address.port, "127.0.0.1");
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
  });
  let context: BrowserContext | undefined;
  try {
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("missing proxy address");
    context = await chromium.launchPersistentContext(path.join(temp, "profile"), {
      channel: "chromium",
      headless: true,
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      ignoreDefaultArgs: ["--disable-extensions"],
      viewport: { width: 340, height: 520 },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "--headless=new",
        "--no-sandbox",
        "--no-first-run",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
    });
    const status = async (): Promise<boolean> => {
      const result = await promisify(execFile)("bun", ["packages/cli/src/main.ts", "status"], {
        cwd: path.resolve(import.meta.dirname, "../../../.."),
        env: { ...process.env, MPCTL_BROKER_SOCKET: path.join(temp, "broker.sock") },
        timeout: 5_000,
      });
      return JSON.parse(result.stdout).connected;
    };
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.emulateMedia({ colorScheme: "light" });
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.getByRole("button", { name: "发起连接" })).toBeEnabled();
    await expect(popup.getByRole("textbox")).toHaveCount(0);
    await expect(popup.getByText("开发调试")).toHaveCount(0);
    await expect(popup.getByRole("button")).toHaveCount(1);
    // Check the installed manifest and real packaged PNGs, not just the source config.
    const icons = await popup.evaluate(async () => {
      const manifest = chrome.runtime.getManifest();
      const actionIcons = manifest.action?.default_icon;
      if (!actionIcons || typeof actionIcons === "string")
        throw new Error("Missing toolbar icon sizes");
      return Promise.all(
        Object.entries(manifest.icons ?? {}).map(async ([size, resource]) => {
          if (actionIcons[size] !== resource) throw new Error("Toolbar and extension icons differ");
          const response = await fetch(chrome.runtime.getURL(resource));
          if (!response.ok) throw new Error("Packaged icon unavailable");
          const bitmap = await createImageBitmap(await response.blob());
          const dimensions = [Number(size), bitmap.width, bitmap.height];
          bitmap.close();
          return dimensions;
        }),
      );
    });
    expect(icons).toEqual([
      [16, 16, 16],
      [32, 32, 32],
      [48, 48, 48],
      [128, 128, 128],
    ]);
    const light = await popup
      .locator("body")
      .evaluate((body) => getComputedStyle(body.parentElement!).backgroundColor);
    await popup.keyboard.press("Tab");
    await expect(popup.getByRole("button")).toBeFocused();
    await popup.screenshot({ path: testInfo.outputPath("popup-light.png") });
    await popup.emulateMedia({ colorScheme: "dark" });
    const dark = await popup
      .locator("body")
      .evaluate((body) => getComputedStyle(body.parentElement!).backgroundColor);
    expect(dark).not.toBe(light);
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await popup.screenshot({ path: testInfo.outputPath("popup-dark.png") });
    await popup.evaluate(async (port) => {
      await chrome.storage.local.set({
        websocketUrl: `ws://127.0.0.1:${port}/bridge`,
        pairingCredential: "isolated-ui-test-credential",
      });
    }, proxyAddress.port);

    // The proxy deliberately withholds every handshake byte until AFTER the page closes.
    const handoff = await context.newPage();
    const closed = handoff.waitForEvent("close");
    await Promise.all([
      closed,
      handoff.goto(`chrome-extension://${id}/connect.html`).catch((error) => {
        if (!handoff.isClosed()) throw error;
      }),
    ]);
    await expect.poll(() => sockets.size).toBe(1);
    expect(await status()).toBe(false);
    release();
    await expect.poll(status).toBe(true);
    await popup.reload();
    await expect(popup.getByRole("status")).toContainText("已连接");
    expect(await popup.locator("body").innerText()).not.toContain("isolated-ui-test-credential");
    // An unavailable BG leaves a recoverable, non-technical page instead of closing it.
    const unavailable = await context.newPage();
    await unavailable.addInitScript(() => {
      chrome.runtime.connect = () => {
        throw new Error("private-control-failure");
      };
    });
    await unavailable.goto(`chrome-extension://${id}/connect.html`);
    await expect(unavailable.getByRole("button", { name: "重试连接" })).toBeVisible();
    expect(unavailable.isClosed()).toBe(false);
    expect(await unavailable.locator("body").innerText()).not.toContain("private-control-failure");
    await unavailable.emulateMedia({ colorScheme: "light" });
    await unavailable.screenshot({ path: testInfo.outputPath("connect-light.png") });
    await unavailable.emulateMedia({ colorScheme: "dark" });
    await unavailable.setViewportSize({ width: 320, height: 520 });
    expect(
      await unavailable.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await unavailable.screenshot({ path: testInfo.outputPath("connect-dark.png") });
  } finally {
    release();
    await context?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await broker.close();
    await rm(temp, { recursive: true, force: true });
  }
});
