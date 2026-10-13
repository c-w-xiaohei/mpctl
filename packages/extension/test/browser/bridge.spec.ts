import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { Transform } from "node:stream";
import {
  createServer as createTcpServer,
  connect as connectTcp,
  type Server as TcpServer,
} from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { protocolVersion } from "@mpctl/contracts";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const extension =
  process.env.MPCTL_BROWSER_EXTENSION_PATH ??
  path.join(root, "packages/extension/.output/chrome-mv3");
const fixtureRoot = path.join(root, "packages/extension/test/browser/fixtures/bridge");
const credential = "browser-e2e-pairing-credential";
const cliTimeoutMs = 140_000;
const execFileAsync = promisify(execFile);
const editorUrl =
  "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=synthetic-context&lang=en_US";
const bareEditorUrl =
  "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77";
const homeUrl =
  "https://mp.weixin.qq.com/cgi-bin/home?t=synthetic-home&token=synthetic-token&lang=synthetic-language";

test.setTimeout(300_000);

// The standalone extension context is owned below, not by runner fixtures.
// oxlint-disable-next-line eslint/no-empty-pattern
test("real CLI, broker, extension and page bridge pull/push UTF-8 HTML on exact ephemeral article refs", async ({}, testInfo) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mpctl-browser-"));
  const socketPath = path.join(temp, "broker.sock");
  const bodyFile = path.join(temp, "unicode body.html");
  const wsPort = await reservePort();
  const httpsPort = await reservePort();
  const wsUrl = `ws://127.0.0.1:${wsPort}/bridge`;
  const allowedWebSocketPorts = new Set([String(wsPort)]);
  const imageRequests: string[] = [];
  const imageFailures: string[] = [];
  const imageResponses: Array<{
    url: string;
    status: number;
    contentType?: string;
    bytes: number;
    sha256: string;
  }> = [];
  const cropPng = createPngFixture(640 * 360 * 4, 640, 360);
  const cropPngHash = createHash("sha256").update(cropPng).digest("hex");
  let broker: ChildProcess | undefined;
  let brokerStderr = "";
  let context: BrowserContext | undefined;
  let fixtureServer: Server | undefined;
  let handshakeProxy: TcpServer | undefined;
  let directProxy: DirectStatusProxy | undefined;
  let handshakeTerminal = false;
  const handshakeClients = new Set<import("node:net").Socket>();
  const handshakeUpstreams = new Set<import("node:net").Socket>();
  let releaseHandshake!: () => void;
  const handshakeGate = new Promise<void>((resolve) => (releaseHandshake = resolve));
  let proxyReachedBroker!: () => void;
  const proxyReachedBrokerPromise = new Promise<void>((resolve) => (proxyReachedBroker = resolve));
  const mpRequests: string[] = [];
  const mpResponses: Array<{ path: string; status: number }> = [];
  let loginTimeoutMode = false;
  let holdEditorImage = false;
  let releaseEditorImage!: () => void;
  const editorImageGate = new Promise<void>((resolve) => {
    releaseEditorImage = resolve;
  });
  try {
    const certPath = path.join(temp, "fixture-cert.pem");
    const keyPath = path.join(temp, "fixture-key.pem");
    await execFileAsync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=mp.weixin.qq.com",
        "-addext",
        "subjectAltName=DNS:mp.weixin.qq.com",
      ],
      { timeout: 15_000 },
    );
    const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
    fixtureServer = createServer({ cert, key }, async (request, response) => {
      const url = new URL(
        request.url ?? "/",
        `https://${request.headers.host ?? "mp.weixin.qq.com"}`,
      );
      mpRequests.push(url.href);
      if (url.pathname === "/fixture-pending-editor-image") {
        await editorImageGate;
        response.writeHead(200, { "content-type": "image/png" });
        response.end(cropPng);
        return;
      }
      if (url.pathname === "/cgi-bin/appmsg") {
        if (url.searchParams.get("action") === "list_card" && !url.searchParams.has("lang")) {
          url.searchParams.set("lang", "synthetic-list-language");
          url.searchParams.set("token", "synthetic-token");
          response.writeHead(302, { location: `${url.pathname}${url.search}` }).end();
          return;
        }
        mpResponses.push({ path: url.pathname, status: 200 });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (
          url.searchParams.get("action") === "edit" &&
          !url.searchParams.has("token") &&
          !url.searchParams.has("lang")
        ) {
          response.end(await readFile(path.join(fixtureRoot, "missing-jsapi.html")));
          return;
        }
        const sourceHtml = await readFile(
          path.join(fixtureRoot, loginTimeoutMode ? "login-timeout.html" : "index.html"),
          "utf8",
        );
        const html = sourceHtml.replaceAll(
          "&amp;replaceScene=synthetic-scene&amp;isSend=synthetic-send&amp;isFreePublish=synthetic-free-publish&amp;reprint_confirm=synthetic-reprint-confirm",
          "&amp;isMul=1&amp;replaceScene=0&amp;isSend=0&amp;isFreePublish=0",
        );
        response.end(
          holdEditorImage && url.searchParams.get("action") === "edit"
            ? html.replace(
                "</body>",
                '<img hidden src="/fixture-pending-editor-image" alt="">\n</body>',
              )
            : html,
        );
        return;
      }
      if (url.pathname === "/cgi-bin/home") {
        mpResponses.push({ path: url.pathname, status: 200 });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (!url.search) {
          response.end("<!doctype html><title>mpctl synthetic managed home shell</title>");
          return;
        }
        response.end(nativeHomeHtml(await readFile(path.join(fixtureRoot, "home.html"), "utf8")));
        return;
      }
      if (url.pathname === "/cgi-bin/jsapi.js") {
        mpResponses.push({ path: url.pathname, status: 200 });
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        // This scenario's native draft link carries the actual observed finite
        // tuple; do not mutate the shared sanitized native-handler fixture.
        const script = await readFile(path.join(fixtureRoot, "jsapi.js"), "utf8");
        response.end(
          script.replace(
            "&replaceScene=synthetic-scene&isSend=synthetic-send&isFreePublish=synthetic-free-publish&reprint_confirm=synthetic-reprint-confirm",
            "&isMul=1&replaceScene=0&isSend=0&isFreePublish=0",
          ),
        );
        return;
      }
      if (url.hostname === "mmbiz.qpic.cn") {
        response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        response.end(cropPng);
        return;
      }
      if (url.pathname === "/") {
        mpResponses.push({ path: url.pathname, status: 200 });
        response.writeHead(302, {
          location:
            "/cgi-bin/home?t=site-redirected-home&lang=synthetic-language&token=synthetic-token",
        });
        response.end();
        return;
      }
      mpResponses.push({ path: url.pathname, status: 404 });
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      fixtureServer!.once("error", reject);
      fixtureServer!.listen(httpsPort, "127.0.0.1", resolve);
    });
    const args = [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--headless=new",
      "--enable-unsafe-extension-debugging",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-proxy-server",
      "--ignore-certificate-errors",
      `--host-resolver-rules=MAP mp.weixin.qq.com:443 127.0.0.1:${httpsPort}, MAP mmbiz.qpic.cn:443 127.0.0.1:${httpsPort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
    ];
    context = await chromium.launchPersistentContext(path.join(temp, "profile"), {
      channel: "chromium",
      headless: true,
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      ignoreDefaultArgs: ["--disable-extensions"],
      ignoreHTTPSErrors: true,
      args,
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === "chrome-extension:" || url.protocol === "devtools:")
        return route.continue();
      if (url.protocol === "https:" && url.hostname === "mmbiz.qpic.cn") {
        imageRequests.push(url.href);
        return route.continue();
      }
      if (
        url.protocol === "ws:" &&
        url.hostname === "127.0.0.1" &&
        allowedWebSocketPorts.has(url.port)
      )
        return route.continue();
      if (url.protocol === "https:" && url.hostname === "mp.weixin.qq.com") return route.continue();
      return route.abort("blockedbyclient");
    });
    context.on("requestfailed", (request) => {
      if (request.url().includes("mmbiz.qpic.cn"))
        imageFailures.push(`${request.url()}:${request.failure()?.errorText}`);
    });
    context.on("response", async (response) => {
      if (!response.url().includes("mmbiz.qpic.cn")) return;
      const body = await response.body().catch(() => Buffer.alloc(0));
      imageResponses.push({
        url: response.url(),
        status: response.status(),
        contentType: response.headers()["content-type"],
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      });
    });
    const imageProbe = await context.newPage();
    await imageProbe.setContent(
      '<img id="crop-probe" src="https://mmbiz.qpic.cn/mmbiz_png/fixture-probe/0">',
    );
    await expect(imageProbe.locator("#crop-probe")).toHaveJSProperty("complete", true);
    await expect
      .poll(() =>
        imageProbe.locator("#crop-probe").evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(640);
    expect(
      await imageProbe
        .locator("#crop-probe")
        .evaluate((image: HTMLImageElement) => image.naturalHeight),
    ).toBe(360);
    await imageProbe.close();
    broker = spawn("bun", ["run", "packages/broker/src/main.ts"], {
      cwd: root,
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: temp,
        MPCTL_PAIRING_CREDENTIAL: credential,
        MPCTL_BROKER_SOCKET: socketPath,
        MPCTL_BROKER_WS_PORT: String(wsPort),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    broker.stderr?.setEncoding("utf8").on("data", (chunk) => {
      brokerStderr += chunk;
    });
    await waitForSocket(socketPath, broker, () => brokerStderr);
    directProxy = await startDirectStatusProxy(wsPort);
    allowedWebSocketPorts.add(String(directProxy.port));

    handshakeProxy = createTcpServer((client) => {
      if (handshakeTerminal) {
        client.destroy();
        return;
      }
      handshakeClients.add(client);
      void handshakeGate.then(() => {
        if (handshakeTerminal || client.destroyed) return;
        const upstream = connectTcp(wsPort, "127.0.0.1", () => {
          if (handshakeTerminal || client.destroyed) {
            upstream.destroy();
            return;
          }
          handshakeUpstreams.add(upstream);
          proxyReachedBroker();
          client.pipe(upstream);
          upstream.pipe(client);
        });
        handshakeUpstreams.add(upstream);
        const disposePair = () => {
          handshakeClients.delete(client);
          handshakeUpstreams.delete(upstream);
          if (!client.destroyed) client.destroy();
          if (!upstream.destroyed) upstream.destroy();
        };
        client.on("error", disposePair);
        upstream.on("error", disposePair);
        client.on("close", disposePair);
        upstream.on("close", disposePair);
      });
    });
    await new Promise<void>((resolve) => handshakeProxy!.listen(0, "127.0.0.1", resolve));
    const proxyAddress = handshakeProxy.address();
    if (!proxyAddress || typeof proxyAddress === "string")
      throw new Error("Handshake proxy did not bind");
    allowedWebSocketPorts.add(String(proxyAddress.port));

    const barePage = await context.newPage();
    const barePageErrors: string[] = [];
    barePage.on("pageerror", (error) => barePageErrors.push(error.message));
    await barePage.goto(bareEditorUrl);
    await barePage.waitForTimeout(500);
    expect(barePageErrors).toEqual([]);
    await barePage.close();

    const page = await context.newPage();
    await page.goto(editorUrl);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.mpctlReady))
      .toBe("yes");
    const authenticatedHome = await context.newPage();
    await authenticatedHome.goto(homeUrl);
    await expect(authenticatedHome.locator("a.weui-desktop-menu__link.menu_report")).toHaveText(
      "草稿箱",
    );
    await expect(authenticatedHome.locator("div.new-creation__menu-item")).toHaveText("文章");
    const extensionId = await extensionIdFromContext(context);
    const popup = await context.newPage();
    await popup.addInitScript(() => {
      const chromeApi = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const nativeConnect = chromeApi.runtime.connect.bind(chromeApi.runtime);
      const state: PopupConnectFault = {
        installed: false,
        intercepted: 0,
        restored: false,
        arm: () => {},
      };
      const installFailure = () => {
        chromeApi.runtime.connect = ((...args: Parameters<typeof chrome.runtime.connect>) => {
          const connectArgs = args as unknown as Array<string | { name?: string }>;
          const connectionName =
            typeof connectArgs[0] === "string" ? connectArgs[0] : connectArgs[0]?.name;
          if (connectionName === "nexus.chrome/1/background") {
            state.intercepted++;
            chromeApi.runtime.connect = nativeConnect;
            state.restored = chromeApi.runtime.connect === nativeConnect;
            throw new Error("synthetic-private-credential popup target failure");
          }
          return nativeConnect(...args);
        }) as typeof chrome.runtime.connect;
      };
      state.arm = installFailure;
      Object.defineProperty(globalThis, "__mpctlPopupConnectFault", {
        configurable: false,
        value: state,
      });
      chromeApi.runtime.connect = ((...args: Parameters<typeof chrome.runtime.connect>) => {
        const connectArgs = args as unknown as Array<string | { name?: string }>;
        const connectionName =
          typeof connectArgs[0] === "string" ? connectArgs[0] : connectArgs[0]?.name;
        if (!state.intercepted && connectionName === "nexus.chrome/1/background") {
          state.intercepted++;
          chromeApi.runtime.connect = nativeConnect;
          state.restored = chromeApi.runtime.connect === nativeConnect;
          throw new Error("synthetic-private-credential popup target failure");
        }
        return nativeConnect(...args);
      }) as typeof chrome.runtime.connect;
      state.installed = true;
    });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const mountFault = await popup.evaluate(
      () =>
        (globalThis as unknown as { __mpctlPopupConnectFault?: PopupConnectFault })
          .__mpctlPopupConnectFault,
    );
    expect(mountFault?.installed).toBe(true);
    await expect
      .poll(() =>
        popup.evaluate(() => {
          const fault = (globalThis as unknown as { __mpctlPopupConnectFault?: PopupConnectFault })
            .__mpctlPopupConnectFault;
          return { intercepted: fault?.intercepted, restored: fault?.restored };
        }),
      )
      .toEqual({ intercepted: 1, restored: true });
    await expect(popup.getByRole("status")).toContainText("未连接");
    await expect(popup.getByRole("status")).toContainText("请点击重试");
    await expect
      .poll(() =>
        popup.evaluate(
          () =>
            (globalThis as unknown as { __mpctlPopupConnectFault?: PopupConnectFault })
              .__mpctlPopupConnectFault?.intercepted,
        ),
      )
      .toBe(1);
    await popup
      .getByLabel("Broker WebSocket 地址")
      .fill(`ws://127.0.0.1:${proxyAddress.port}/bridge`);
    await popup.getByLabel("配对凭证").fill("wrong-credential");
    await popup.evaluate(() => {
      const fault = (globalThis as unknown as { __mpctlPopupConnectFault?: PopupConnectFault })
        .__mpctlPopupConnectFault;
      fault?.arm();
    });
    await popup.getByRole("button", { name: "显式连接" }).click();
    await expect(popup.getByRole("status")).toContainText("点击重试");
    expect(await popup.locator("body").innerText()).not.toContain("synthetic-private-credential");
    expect(await popup.locator("body").innerText()).not.toContain("wrong-credential");
    const clickFault = await popup.evaluate(
      () =>
        (globalThis as unknown as { __mpctlPopupConnectFault?: PopupConnectFault })
          .__mpctlPopupConnectFault,
    );
    expect(clickFault?.intercepted).toBe(2);
    expect(clickFault?.restored).toBe(true);
    expect(await popup.locator("body").innerText()).not.toContain("synthetic-private-credential");

    await popup
      .getByLabel("Broker WebSocket 地址")
      .fill(`ws://127.0.0.1:${directProxy.port}/bridge`);
    await popup.getByLabel("配对凭证").fill("wrong-credential");
    directProxy.resetAttempt();
    const failedAttempt = directProxy.waitForFailedAttempt();
    await popup.getByRole("button", { name: "显式连接" }).click();
    const failedAttemptEvidence = await failedAttempt;
    expect(failedAttemptEvidence.clientCount).toBe(1);
    expect(failedAttemptEvidence.upstreamConnectionCount).toBe(1);
    expect(failedAttemptEvidence.forwardedRequestBytes).toBeGreaterThan(0);
    expect(
      failedAttemptEvidence.upstreamEndCount + failedAttemptEvidence.upstreamCloseCount,
    ).toBeGreaterThan(0);
    expect(failedAttemptEvidence.upstreamCloseCount).toBe(1);
    await expect(popup.getByRole("status")).toContainText("请重试");
    expect(await popup.locator("body").innerText()).not.toContain("wrong-credential");
    const rejectedStatus = await cli(temp, socketPath, "status");
    expect(rejectedStatus.code).toBe(0);
    expect(JSON.parse(rejectedStatus.stdout).connected).toBe(false);
    expect(directProxy.attempt).toEqual(failedAttemptEvidence);

    await popup.getByLabel("配对凭证").fill(credential);
    await popup.getByRole("button", { name: "显式连接" }).click();
    await expect(popup.getByRole("status")).toContainText("已连接", { timeout: 15_000 });
    const acceptedStatus = await cli(temp, socketPath, "status");
    expect(acceptedStatus.code).toBe(0);
    expect(JSON.parse(acceptedStatus.stdout).connected).toBe(true);

    const pagesBeforeNativePrepare = new Set(context.pages());
    const completedNative = await cli(temp, socketPath, "article", "new");
    const nativeEditor = await newEditorPage(context, pagesBeforeNativePrepare);
    await expect
      .poll(() => nativeEditor.evaluate(() => document.documentElement.dataset.mpctlReady))
      .toBe("yes");
    expect(
      await nativeEditor.evaluate(() => {
        const visible = [...document.querySelectorAll<HTMLElement>(".js_appmsg_item")].filter(
          (item) => item.getClientRects().length > 0,
        );
        return (
          visible.length === 1 &&
          visible[0]?.classList.contains("current") === true &&
          visible[0]?.getAttribute("data-msgindex") === "0"
        );
      }),
    ).toBe(true);
    expect(completedNative.code, `${completedNative.stdout}\n${completedNative.stderr}`).toBe(0);
    expect(JSON.parse(completedNative.stdout).snapshot.effect.pageCreated).toBe(true);
    const nativeCurrent = await cli(temp, socketPath, "article", "current", "--new");
    expect(nativeCurrent.code, nativeCurrent.stderr).toBe(0);
    const nativeResult = JSON.parse(nativeCurrent.stdout) as {
      article: string;
      bodyHash: string;
    };
    const nativeArticle = nativeResult.article;
    const nativeBodyPath = path.join(temp, "native-click-body.html");
    expect(
      (await cli(temp, socketPath, "article", "pull", nativeArticle, "--body", nativeBodyPath))
        .code,
    ).toBe(0);
    expect(await readFile(nativeBodyPath, "utf8")).toBe("");
    await writeFile(bodyFile, "<p>native click handoff</p>", "utf8");
    expect(
      (
        await cli(
          temp,
          socketPath,
          "article",
          "push",
          nativeArticle,
          "--body",
          bodyFile,
          "--expected-hash",
          nativeResult.bodyHash,
        )
      ).code,
    ).toBe(0);
    await expect
      .poll(() => nativeEditor.evaluate(() => document.documentElement.dataset.mpctlBody ?? ""))
      .toBe("<p>native click handoff</p>");
    expect(completedNative.stdout).not.toContain("synthetic-new-token");
    expect(completedNative.stderr).not.toContain("synthetic-new-token");

    const assetFile = path.join(temp, "bridge-pipeline-fixture.png");
    const assetBytes = createPngFixture(14 * 1024);
    await writeFile(assetFile, assetBytes);
    const assetDigest = createHash("sha256").update(assetBytes).digest("hex");
    const beforeAssetBody = path.join(temp, "before-asset.html");
    const afterAssetBody = path.join(temp, "after-asset.html");
    const beforeAssetFields = await cli(temp, socketPath, "article", "inspect", nativeArticle);
    expect(beforeAssetFields.code, beforeAssetFields.stderr).toBe(0);
    expect(
      (await cli(temp, socketPath, "article", "pull", nativeArticle, "--body", beforeAssetBody))
        .code,
    ).toBe(0);

    const beforeAssets = await cli(temp, socketPath, "asset", "list", nativeArticle);
    expect(beforeAssets.code, `${beforeAssets.stdout}\n${beforeAssets.stderr}`).toBe(0);
    expect(JSON.parse(beforeAssets.stdout)).toEqual({ scope: "visible-page", cards: [] });
    await nativeEditor.locator("li#js_editor_insertimage").click();
    await nativeEditor.locator("li#js_editor_insertimage .js_img_from_local").click();
    await expect(nativeEditor.locator("#synthetic-image-library")).toBeVisible();
    await nativeEditor.evaluate(() => {
      (
        window as unknown as { __mpctlFixtureAssets: { cardDelayMs: number } }
      ).__mpctlFixtureAssets.cardDelayMs = 6_000;
    });

    const assetUploaded = await cli(
      temp,
      socketPath,
      "asset",
      "upload",
      nativeArticle,
      "--file",
      assetFile,
    );
    expect(assetUploaded.code, `${assetUploaded.stdout}\n${assetUploaded.stderr}`).toBe(0);
    expect(JSON.parse(assetUploaded.stdout)).toMatchObject({
      snapshot: {
        operation: "upload",
        state: "settled",
        effect: {
          outcome: "confirmed",
          filename: "bridge-pipeline-fixture.png",
          thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/synthetic-library-card/300?wx_fmt=png",
        },
      },
    });
    expect(assetUploaded.code).toBe(0);
    await expect
      .poll(() => nativeEditor.locator("html").getAttribute("data-mpctl-asset-received"))
      .not.toBeNull();
    const receivedAsset = JSON.parse(
      (await nativeEditor.locator("html").getAttribute("data-mpctl-asset-received")) ?? "null",
    ) as {
      trusted: boolean;
      nativeFile: boolean;
      name: string;
      type: string;
      size: number;
      sha256: string;
    };
    expect(receivedAsset).toEqual({
      trusted: false,
      nativeFile: true,
      name: "bridge-pipeline-fixture.png",
      type: "image/png",
      size: assetBytes.length,
      sha256: assetDigest,
    });
    expect(
      await nativeEditor.locator("html").evaluate(() => {
        const state = (
          window as unknown as { __mpctlFixtureAssets: { changes: unknown[]; cardCount: number } }
        ).__mpctlFixtureAssets;
        return { changes: state.changes.length, cardCount: state.cardCount };
      }),
    ).toEqual({ changes: 1, cardCount: 1 });

    const afterAssets = await cli(temp, socketPath, "asset", "list", nativeArticle);
    expect(afterAssets.code, `${afterAssets.stdout}\n${afterAssets.stderr}`).toBe(0);
    expect(JSON.parse(afterAssets.stdout)).toMatchObject({
      scope: "visible-page",
      cards: [
        {
          asset: expect.stringMatching(/^ephemeral:/),
          filename: "bridge-pipeline-fixture.png",
          thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/synthetic-library-card/300?wx_fmt=png",
        },
      ],
    });
    expect(JSON.parse(afterAssets.stdout).cards[0].thumbnailUrl).not.toContain("/0?");
    const duplicateUpload = await cli(
      temp,
      socketPath,
      "asset",
      "upload",
      nativeArticle,
      "--file",
      assetFile,
    );
    expect(duplicateUpload.code).toBe(1);
    expect(cliErrorCode(duplicateUpload.stderr)).toBe("asset_ambiguous");
    expect(
      JSON.parse(duplicateUpload.stderr.trim().split("\n").at(-1)!).error.snapshot,
    ).toMatchObject({
      effect: { outcome: "not_dispatched" },
      result: {
        error: {
          cause: { at: "content.upload_preflight", kind: "domain", code: "filename_exists" },
        },
      },
    });
    expect(
      await nativeEditor
        .locator("html")
        .evaluate(
          () =>
            (window as unknown as { __mpctlFixtureAssets: { changes: unknown[] } })
              .__mpctlFixtureAssets.changes.length,
        ),
    ).toBe(1);

    await nativeEditor.locator('#synthetic-image-library [data-library-action="cancel"]').click();
    await expect(nativeEditor.locator("#synthetic-image-library")).toBeHidden();
    // The original blank-title / cleanup-fails CLI chain assertions now run in
    // idempotency.spec's isolated upload lifetimes: unknown native work must not
    // be force-unlocked just to continue this unrelated bridge scenario.
    const afterAssetFields = await cli(temp, socketPath, "article", "inspect", nativeArticle);
    expect(afterAssetFields.code, afterAssetFields.stderr).toBe(0);
    expect(JSON.parse(afterAssetFields.stdout)).toEqual(JSON.parse(beforeAssetFields.stdout));
    expect(
      (await cli(temp, socketPath, "article", "pull", nativeArticle, "--body", afterAssetBody))
        .code,
    ).toBe(0);
    expect(await readFile(afterAssetBody)).toEqual(await readFile(beforeAssetBody));

    // The native-new draft is intentionally unsupported for save and must be rejected
    // before the fixture's native save button is dispatched.
    const newDraftSave = await cli(
      temp,
      socketPath,
      "article",
      "save",
      nativeArticle,
      "--expected-body-hash",
      nativeResult.bodyHash,
      "--expected-fields-hash",
      JSON.parse(beforeAssetFields.stdout).fieldsHash,
      "--expected-cover-hash",
      "0".repeat(64),
    );
    expect(newDraftSave.code).toBe(1);
    expect(cliErrorCode(newDraftSave.stderr)).toBe("unsupported");
    expect(await nativeEditor.locator("html").getAttribute("data-mpctlNativeSaveCount")).toBeNull();

    // Open the exact saved group through the public CLI, then upload a page-owned asset
    // so the opaque handle belongs to this saved editor document.
    // Hold an unrelated image open: parsed DOM + a validated editor must work
    // while readyState is interactive, without waiting for the window load event.
    holdEditorImage = true;
    const savedOpenPages = new Set(context.pages());
    const savedOpen = await cli(temp, socketPath, "article", "open", "fixture-group-1");
    expect(savedOpen.code, `${savedOpen.stdout}\n${savedOpen.stderr}`).toBe(0);
    const savedEditor = await savedEditorPage(context, savedOpenPages, "fixture-group-1");
    expect(await savedEditor.evaluate(() => document.readyState)).toBe("interactive");
    await expect
      .poll(() => savedEditor.evaluate(() => document.documentElement.dataset.mpctlReady))
      .toBe("yes");
    await expect
      .poll(() => savedEditor.evaluate(() => document.documentElement.dataset.mpctlFixtureGroup))
      .toBe("fixture-group-1");
    expect(JSON.parse(savedOpen.stdout).snapshot.effect.pageCreated).toBe(true);
    const savedCurrent = await cli(
      temp,
      socketPath,
      "article",
      "current",
      "--candidate",
      "fixture-group-1",
    );
    expect(savedCurrent.code, savedCurrent.stderr).toBe(0);
    const savedCoverArticle = (JSON.parse(savedCurrent.stdout) as { article: string }).article;
    holdEditorImage = false;
    releaseEditorImage();
    const beforeRepeatedOpen = context.pages().length;
    const reusedSavedOpen = await cli(temp, socketPath, "article", "open", "fixture-group-1");
    expect(reusedSavedOpen.code, reusedSavedOpen.stderr).toBe(0);
    expect(context.pages().length).toBe(beforeRepeatedOpen);
    expect(JSON.parse(reusedSavedOpen.stdout).snapshot.effect.pageCreated).toBe(false);
    const reusedCurrent = await cli(
      temp,
      socketPath,
      "article",
      "current",
      "--candidate",
      "fixture-group-1",
    );
    expect(reusedCurrent.code, reusedCurrent.stderr).toBe(0);
    const reusedArticle = (JSON.parse(reusedCurrent.stdout) as { article: string }).article;
    expect((await cli(temp, socketPath, "article", "inspect", reusedArticle)).code).toBe(0);
    // New permission-free official JSAPI branch. This fixture is synthetic;
    // neither native UI/debugger nor SAVE is used by the cover operation.
    const bodyCoverFile = path.join(temp, "body-cover-source.html");
    const bodyCoverPull = path.join(temp, "body-cover-pull.html");
    const sourceImage =
      "https://mmbiz.qpic.cn/mmbiz_png/synthetic-body-cover/0?wx_fmt=png&from=fixture";
    const bodyCoverHtml = `<p>body cover synthetic</p><img class="rich_pages wxw-img" data-src="${sourceImage.replace(/&/g, "&amp;")}" data-imgfileid="123" data-type="png" data-ratio="0.5625" data-w="640">`;
    await writeFile(bodyCoverFile, bodyCoverHtml);
    const bodyCoverBefore = await cli(
      temp,
      socketPath,
      "article",
      "pull",
      savedCoverArticle,
      "--body",
      bodyCoverPull,
    );
    expect(bodyCoverBefore.code, bodyCoverBefore.stderr).toBe(0);
    const originalFixtureBody = await readFile(bodyCoverPull, "utf8");
    const originalFixtureCover = await savedEditor
      .locator(".js_cover_preview_new")
      .evaluate((node: HTMLElement) => node.style.backgroundImage);
    const bodyCoverPush = await cli(
      temp,
      socketPath,
      "article",
      "push",
      savedCoverArticle,
      "--body",
      bodyCoverFile,
      "--expected-hash",
      JSON.parse(bodyCoverBefore.stdout).bodyHash,
    );
    expect(bodyCoverPush.code, bodyCoverPush.stderr).toBe(0);
    const bodyCoverHash = JSON.parse(bodyCoverPush.stdout).snapshot.effect.bodyHash;
    const coverBeforeBodySet = JSON.parse(
      (await cli(temp, socketPath, "article", "cover", savedCoverArticle)).stdout,
    ).coverHash;
    const fieldsBeforeBodySet = (
      await cli(temp, socketPath, "article", "inspect", savedCoverArticle)
    ).stdout;
    const coverFromBody = await cli(
      temp,
      socketPath,
      "article",
      "cover",
      savedCoverArticle,
      "--from-body",
      "1",
      "--expected-body-hash",
      bodyCoverHash,
      "--expected-hash",
      coverBeforeBodySet,
    );
    expect(coverFromBody.code, `${coverFromBody.stdout}\n${coverFromBody.stderr}`).toBe(0);
    const coverFromBodyReply = JSON.parse(coverFromBody.stdout);
    expect(coverFromBodyReply.snapshot).toMatchObject({
      operation: "cover",
      state: "settled",
      effect: { cover: true, outcome: "confirmed" },
    });
    const coverStatus = await cli(
      temp,
      socketPath,
      "operation",
      "status",
      coverFromBodyReply.snapshot.operationId,
    );
    expect(coverStatus.code, coverStatus.stderr).toBe(0);
    expect(JSON.parse(coverStatus.stdout).snapshot).toEqual(coverFromBodyReply.snapshot);
    const duplicateBodyCover = await cli(
      temp,
      socketPath,
      "article",
      "cover",
      savedCoverArticle,
      "--from-body",
      "1",
      "--expected-body-hash",
      bodyCoverHash,
      "--expected-hash",
      coverBeforeBodySet,
      "--operation",
      coverFromBodyReply.snapshot.operationId,
    );
    expect(duplicateBodyCover.code, duplicateBodyCover.stderr).toBe(0);
    expect(JSON.parse(duplicateBodyCover.stdout).snapshot).toEqual(coverFromBodyReply.snapshot);
    expect((await cli(temp, socketPath, "article", "inspect", savedCoverArticle)).stdout).toBe(
      fieldsBeforeBodySet,
    );
    expect(
      (
        await cli(
          temp,
          socketPath,
          "article",
          "pull",
          savedCoverArticle,
          "--body",
          bodyCoverPull,
          "--overwrite",
        )
      ).code,
    ).toBe(0);
    expect(await readFile(bodyCoverPull, "utf8")).toBe(bodyCoverHtml);
    expect(
      await savedEditor.evaluate(() =>
        (window as any).__mpctlFixtureResults.filter(
          (x: any) => x.apiName === "mp_editor_change_cover",
        ),
      ),
    ).toEqual([{ apiName: "mp_editor_change_cover", apiParam: { oriImgUrl: sourceImage } }]);
    // Restore only synthetic fixture setup so the pre-existing asset/SAVE
    // controls below keep their original starting conditions.
    await writeFile(bodyCoverFile, originalFixtureBody);
    const restoreBody = await cli(
      temp,
      socketPath,
      "article",
      "push",
      savedCoverArticle,
      "--body",
      bodyCoverFile,
      "--expected-hash",
      bodyCoverHash,
    );
    expect(restoreBody.code, restoreBody.stderr).toBe(0);
    await savedEditor.locator(".js_cover_preview_new").evaluate((node: HTMLElement, original) => {
      node.style.backgroundImage = original;
    }, originalFixtureCover);
    const savedBodyPath = path.join(temp, "saved-cover-save-body.html");
    const savedBeforeBody = await cli(
      temp,
      socketPath,
      "article",
      "pull",
      savedCoverArticle,
      "--body",
      savedBodyPath,
    );
    expect(savedBeforeBody.code, savedBeforeBody.stderr).toBe(0);
    const savedBeforeFields = JSON.parse(
      (await cli(temp, socketPath, "article", "inspect", savedCoverArticle)).stdout,
    ) as {
      title: string;
      author: string;
      summary: string;
      fieldsHash: string;
    };
    const savedCoverBefore = await cli(temp, socketPath, "article", "cover", savedCoverArticle);
    expect(savedCoverBefore.code, savedCoverBefore.stderr).toBe(0);
    let originalCoverHash = JSON.parse(savedCoverBefore.stdout).coverHash as string;
    const savedAssets = await cli(temp, socketPath, "asset", "list", savedCoverArticle);
    expect(savedAssets.code, savedAssets.stderr).toBe(0);
    const coverAssetHandle = JSON.parse(savedAssets.stdout).cards[0].asset as string;
    expect(JSON.parse(savedAssets.stdout).cards[0].filename).toBe("saved-cover-candidate.png");

    const emptyCoverState = await savedEditor.evaluate(() => {
      const preview = document.querySelector<HTMLElement>(".js_cover_preview_new")!;
      const original = { hidden: preview.hidden, backgroundImage: preview.style.backgroundImage };
      preview.hidden = true;
      preview.style.backgroundImage = "none";
      return original;
    });
    const emptyCoverSet = await cli(
      temp,
      socketPath,
      "article",
      "cover",
      savedCoverArticle,
      "--asset",
      coverAssetHandle,
      "--expected-hash",
      originalCoverHash,
    );
    expect(emptyCoverSet.code).toBe(1);
    expect(cliErrorCode(emptyCoverSet.stderr)).toBe("cover_unavailable");
    expect(
      await savedEditor
        .locator("html")
        .evaluate(() => JSON.stringify((window as FixtureWindow).__mpctlFixtureAssets?.coverTrace)),
    ).toBe("[]");
    await savedEditor.locator(".js_cover_preview_new").evaluate((node, original) => {
      const preview = node as HTMLElement;
      preview.hidden = original.hidden;
      preview.style.backgroundImage = original.backgroundImage;
    }, emptyCoverState);

    const routeBeforeCoverSet = await savedEditor.evaluate(() => ({
      url: location.href,
      group: document.documentElement.dataset.mpctlFixtureGroup,
    }));
    const staleCoverSet = await cli(
      temp,
      socketPath,
      "article",
      "cover",
      savedCoverArticle,
      "--asset",
      coverAssetHandle,
      "--expected-hash",
      "0".repeat(64),
    );
    expect(staleCoverSet.code).toBe(1);
    expect(cliErrorCode(staleCoverSet.stderr)).toBe("content_conflict");
    expect(
      await savedEditor
        .locator("html")
        .evaluate(() => JSON.stringify((window as FixtureWindow).__mpctlFixtureAssets?.coverTrace)),
    ).toBe("[]");
    const primaryLauncher = savedEditor.locator(
      ".js_cover_preview_new .js_chooseCoverWrap:not(.preview-square) .js_chooseCover",
    );
    expect(
      await primaryLauncher.evaluate((node) => {
        const primary = node.closest(".js_cover_preview_new");
        const wrapper = node.closest(".js_chooseCoverWrap");
        const tooltip = node.closest(".weui-desktop-tooltip__wrp");
        const target = node.closest(".weui-desktop-popover__target");
        return Boolean(
          primary &&
          wrapper &&
          tooltip &&
          target &&
          primary.contains(wrapper) &&
          wrapper.contains(target) &&
          target.contains(tooltip) &&
          tooltip.contains(node),
        );
      }),
    ).toBe(true);
    await primaryLauncher.evaluate((node) => {
      const duplicate = node.cloneNode(true) as HTMLElement;
      duplicate.setAttribute("data-cover-test-duplicate", "");
      node.parentElement!.append(duplicate);
    });
    const duplicateLauncherResult = await cli(
      temp,
      socketPath,
      "article",
      "cover",
      savedCoverArticle,
      "--asset",
      coverAssetHandle,
      "--expected-hash",
      originalCoverHash,
    );
    expect(duplicateLauncherResult.code).toBe(1);
    expect(cliErrorCode(duplicateLauncherResult.stderr)).toBe("cover_input_unavailable");
    expect(
      await savedEditor
        .locator("html")
        .evaluate(() => JSON.stringify((window as FixtureWindow).__mpctlFixtureAssets?.coverTrace)),
    ).toBe("[]");
    await savedEditor.locator("[data-cover-test-duplicate]").evaluate((node) => node.remove());

    await primaryLauncher.evaluate((node) => {
      (window as FixtureWindow).__coverLauncher = node;
      (window as FixtureWindow).__coverLauncherParent = node.parentElement!;
      node.remove();
    });
    const missingLauncherResult = await cli(
      temp,
      socketPath,
      "article",
      "cover",
      savedCoverArticle,
      "--asset",
      coverAssetHandle,
      "--expected-hash",
      originalCoverHash,
    );
    expect(missingLauncherResult.code).toBe(1);
    expect(cliErrorCode(missingLauncherResult.stderr)).toBe("cover_input_unavailable");
    expect(
      await savedEditor
        .locator("html")
        .evaluate(() => JSON.stringify((window as FixtureWindow).__mpctlFixtureAssets?.coverTrace)),
    ).toBe("[]");
    await savedEditor.evaluate(() => {
      const launcher = (window as FixtureWindow).__coverLauncher;
      (window as FixtureWindow).__coverLauncherParent!.append(launcher!);
      delete (window as FixtureWindow).__coverLauncher;
      delete (window as FixtureWindow).__coverLauncherParent;
    });
    await savedEditor.locator(".js_cover_preview_new").evaluate((node) => {
      (window as FixtureWindow).__primaryCover = node;
      (window as FixtureWindow).__primaryCoverWrapper = node.parentElement!;
      node.remove();
    });
    const missingPrimaryResult = await cli(
      temp,
      socketPath,
      "article",
      "cover",
      savedCoverArticle,
      "--asset",
      coverAssetHandle,
      "--expected-hash",
      originalCoverHash,
    );
    expect(missingPrimaryResult.code).toBe(1);
    expect(cliErrorCode(missingPrimaryResult.stderr)).toBe("cover_unavailable");
    expect(
      await savedEditor
        .locator("html")
        .evaluate(() => JSON.stringify((window as FixtureWindow).__mpctlFixtureAssets?.coverTrace)),
    ).toBe("[]");
    await savedEditor.evaluate(() => {
      const primary = (window as FixtureWindow).__primaryCover;
      const wrapper = (window as FixtureWindow).__primaryCoverWrapper;
      wrapper!.append(primary!);
      delete (window as FixtureWindow).__primaryCover;
      delete (window as FixtureWindow).__primaryCoverWrapper;
    });
    for (const mode of [
      "wrong-label",
      "duplicate",
      "hidden",
      "visible-item-hidden-ancestor",
    ] as const) {
      await savedEditor.evaluate((nextMode) => {
        (window as FixtureWindow).__coverMenuTestMode = nextMode;
        window.dispatchEvent(
          new CustomEvent("mpctl-fixture-cover-negative-mode", { detail: nextMode }),
        );
      }, mode);
      const rejectedMenu = await cli(
        temp,
        socketPath,
        "article",
        "cover",
        savedCoverArticle,
        "--asset",
        coverAssetHandle,
        "--expected-hash",
        originalCoverHash,
      );
      expect(rejectedMenu.code, `${mode}: ${rejectedMenu.stderr}`).toBe(1);
      expect(cliErrorCode(rejectedMenu.stderr)).toBe("cover_input_unavailable");
      expect(
        await savedEditor
          .locator("html")
          .evaluate(() => (window as FixtureWindow).__mpctlFixtureAssets?.coverTrace),
      ).not.toContain("library-menu");
      const rejectedFixtureState = await savedEditor.locator("html").evaluate(() => {
        const primary = document.querySelector<HTMLElement>(".js_cover_preview_new")!;
        const wrapper = primary.querySelector<HTMLElement>(".js_chooseCoverWrap")!;
        const menu = wrapper.querySelector<HTMLElement>(".cover-dropdown")!;
        return {
          hover: (window as FixtureWindow).__mpctlFixtureAssets?.coverHoverEvents,
          wrapperDisplay: getComputedStyle(wrapper).display,
          menuDisplay: getComputedStyle(menu).display,
          confirms: (window as FixtureWindow).__mpctlFixtureAssets?.coverConfirms ?? 0,
        };
      });
      expect(rejectedFixtureState, `${mode}: ${rejectedMenu.stderr}`).toEqual({
        hover: { primaryPreview: 0, primaryWrapper: 0, square: 0 },
        wrapperDisplay: "none",
        menuDisplay: "none",
        confirms: 0,
      });
      await savedEditor.evaluate(() => {
        delete (window as FixtureWindow).__coverMenuTestMode;
        const primaryWrapper = document.querySelector<HTMLElement>(
          ".js_cover_preview_new .js_chooseCoverWrap:not(.preview-square)",
        )!;
        primaryWrapper.hidden = false;
        document.querySelector("[data-cover-menu-duplicate]")?.remove();
        const wrapper = document.querySelector<HTMLElement>(
          ".js_cover_preview_new .js_chooseCoverWrap:not(.preview-square)",
        )!;
        wrapper.classList.remove("presentation-visible");
        wrapper.classList.remove("menu-visible");
        wrapper.querySelector(".weui-desktop-tooltip__wrp")?.classList.remove("launcher-visible");
        const menu = wrapper.querySelector<HTMLElement>(".cover-dropdown")!;
        menu.classList.add("presentation-hidden");
        menu.classList.remove("presentation-visible");
        menu.querySelector(".js_imagedialog")!.textContent = "从图片库选择";
        document.querySelector<HTMLElement>(".js_cover_preview_new")!.style.backgroundImage =
          'url("https://mmbiz.qpic.cn/mmbiz_png/current/0")';
        (window as FixtureWindow).__mpctlFixtureAssets!.coverConfirms = 0;
        ((window as FixtureWindow).__mpctlFixtureAssets!.coverTrace ??= []).length = 0;
        (window as FixtureWindow).__mpctlFixtureAssets!.coverHoverEvents = {
          primaryPreview: 0,
          primaryWrapper: 0,
          square: 0,
        };
      });
    }
    for (const mode of ["replace-primary", "guard-loss"] as const) {
      await savedEditor.evaluate((nextMode) => {
        (window as FixtureWindow).__coverMenuTestMode = nextMode;
        window.dispatchEvent(
          new CustomEvent("mpctl-fixture-cover-negative-mode", { detail: nextMode }),
        );
      }, mode);
      const rejectedWait = await cli(
        temp,
        socketPath,
        "article",
        "cover",
        savedCoverArticle,
        "--asset",
        coverAssetHandle,
        "--expected-hash",
        originalCoverHash,
      );
      expect(rejectedWait.code).toBe(1);
      expect(cliErrorCode(rejectedWait.stderr)).not.toBe("cover_update_unknown");
      expect(
        await savedEditor
          .locator("html")
          .evaluate(() => (window as FixtureWindow).__mpctlFixtureAssets?.coverTrace),
      ).not.toContain("library-menu");
      expect(
        await savedEditor
          .locator("html")
          .evaluate(() => (window as FixtureWindow).__mpctlFixtureAssets?.coverHoverEvents),
      ).toEqual({ primaryPreview: 0, primaryWrapper: 0, square: 0 });
      await savedEditor.evaluate((routeUrl) => {
        delete (window as FixtureWindow).__coverMenuTestMode;
        history.replaceState(null, "", routeUrl);
        const primary = document.querySelector<HTMLElement>(".js_cover_preview_new")!;
        const original = (window as FixtureWindow).__coverOriginalPrimary;
        if (original && primary !== original) primary.replaceWith(original);
        delete (window as FixtureWindow).__coverOriginalPrimary;
        document.querySelector<HTMLElement>(".js_cover_preview_new")!.style.backgroundImage =
          'url("https://mmbiz.qpic.cn/mmbiz_png/current/0")';
        const wrapper = document.querySelector<HTMLElement>(
          ".js_cover_preview_new .js_chooseCoverWrap:not(.preview-square)",
        )!;
        wrapper.classList.remove("presentation-visible");
        const menu = wrapper.querySelector<HTMLElement>(".cover-dropdown")!;
        menu.classList.add("presentation-hidden");
        menu.classList.remove("presentation-visible");
        menu.querySelector(".js_imagedialog")!.textContent = "从图片库选择";
        (window as FixtureWindow).__mpctlFixtureAssets!.coverConfirms = 0;
        ((window as FixtureWindow).__mpctlFixtureAssets!.coverTrace ??= []).length = 0;
      }, routeBeforeCoverSet.url);
    }
    // Explicitly exercise the ordinary/permission-free already-visible-menu path.
    await savedEditor
      .locator(".js_cover_preview_new .js_chooseCoverWrap:not(.preview-square)")
      .evaluate((wrapper) => wrapper.classList.add("fixture-menu-visible"));
    await savedEditor.evaluate(() => {
      (window as FixtureWindow).__coverMenuTestMode = "delayed";
    });
    const changedCover = await cli(
      temp,
      socketPath,
      "article",
      "cover",
      savedCoverArticle,
      "--asset",
      coverAssetHandle,
      "--expected-hash",
      originalCoverHash,
    );
    expect(
      changedCover.code,
      `${changedCover.stdout}\n${changedCover.stderr}\n${JSON.stringify({
        imageRequests,
        imageFailures,
        imageResponses,
        expectedCropPng: { bytes: cropPng.byteLength, sha256: cropPngHash },
        routeBeforeCoverSet,
        after: await savedEditor.evaluate(() => ({
          group: document.documentElement.dataset.mpctlFixtureGroup,
          url: location.href,
          state: (window as FixtureWindow).__mpctlFixtureAssets,
          img: (() => {
            const image = document.querySelector<HTMLImageElement>(
              "#synthetic-cover-crop .crop-img",
            );
            return (
              image && {
                complete: image.complete,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                src: image.currentSrc,
              }
            );
          })(),
          visibleDialogs: [...document.querySelectorAll<HTMLElement>(".weui-desktop-dialog")]
            .filter(
              (node) => node.getClientRects().length && getComputedStyle(node).display !== "none",
            )
            .map((node) => node.textContent),
        })),
      })} `,
    ).toBe(0);
    const changedCoverHash = JSON.parse(changedCover.stdout).snapshot.effect.coverHash as string;
    expect(changedCoverHash).not.toBe(originalCoverHash);
    await expect(savedEditor.locator("#synthetic-cover-library")).toBeHidden();
    await expect(savedEditor.locator("#synthetic-cover-crop")).toBeHidden();
    expect(
      await savedEditor
        .locator("html")
        .evaluate(() => (window as FixtureWindow).__mpctlFixtureAssets?.coverConfirms),
    ).toBe(1);
    expect(
      await savedEditor
        .locator("html")
        .evaluate(() => (window as FixtureWindow).__mpctlFixtureAssets?.coverHoverEvents),
    ).toEqual({ primaryPreview: 0, primaryWrapper: 0, square: 0 });
    await savedEditor
      .locator(".js_cover_preview_new .js_chooseCoverWrap:not(.preview-square)")
      .evaluate((wrapper) => wrapper.classList.remove("fixture-menu-visible"));
    expect(
      await savedEditor
        .locator(".js_cover_preview_new .js_chooseCoverWrap:not(.preview-square) .cover-dropdown")
        .evaluate((node) => node.classList.contains("presentation-visible")),
    ).toBe(false);
    const afterCoverBodyPath = path.join(temp, "saved-after-cover.html");
    const afterCoverPull = await cli(
      temp,
      socketPath,
      "article",
      "pull",
      savedCoverArticle,
      "--body",
      afterCoverBodyPath,
    );
    expect(afterCoverPull.code, afterCoverPull.stderr).toBe(0);
    expect(await readFile(afterCoverBodyPath)).toEqual(await readFile(savedBodyPath));
    const savedAfterCoverFields = JSON.parse(
      (await cli(temp, socketPath, "article", "inspect", savedCoverArticle)).stdout,
    ) as typeof savedBeforeFields;
    expect(savedAfterCoverFields).toEqual(savedBeforeFields);
    expect(
      await savedEditor
        .locator("html")
        .evaluate(() => (window as FixtureWindow).__mpctlFixtureAssets?.nativeSaveCount),
    ).toBe(0);

    const canonicalInput = '<img src="fixture-image.png">';
    const canonicalInputPath = path.join(temp, "canonical-input.html");
    await writeFile(canonicalInputPath, canonicalInput, "utf8");
    const canonicalInputPush = await cli(
      temp,
      socketPath,
      "article",
      "push",
      savedCoverArticle,
      "--body",
      canonicalInputPath,
      "--expected-hash",
      JSON.parse(savedBeforeBody.stdout).bodyHash,
    );
    expect(canonicalInputPush.code, canonicalInputPush.stderr).toBe(0);
    const canonicalBeforeSavePath = path.join(temp, "canonical-before-save.html");
    const canonicalBeforeSave = await cli(
      temp,
      socketPath,
      "article",
      "pull",
      savedCoverArticle,
      "--body",
      canonicalBeforeSavePath,
    );
    expect(canonicalBeforeSave.code, canonicalBeforeSave.stderr).toBe(0);
    const saveBodyHash = JSON.parse(canonicalBeforeSave.stdout).bodyHash as string;
    await savedEditor.evaluate(() => {
      localStorage.setItem("mpctl-fixture-canonical-save-body", "yes");
    });
    const staleCoverSave = await cli(
      temp,
      socketPath,
      "article",
      "save",
      savedCoverArticle,
      "--expected-body-hash",
      saveBodyHash,
      "--expected-fields-hash",
      savedBeforeFields.fieldsHash,
      "--expected-cover-hash",
      originalCoverHash,
    );
    expect(staleCoverSave.code).toBe(1);
    expect(cliErrorCode(staleCoverSave.stderr)).toBe("content_conflict");
    expect(
      await savedEditor
        .locator("html")
        .evaluate(() => (window as FixtureWindow).__mpctlFixtureAssets?.nativeSaveCount),
    ).toBe(0);

    const pagesBeforeSave = new Set(context.pages());
    const documentBeforeSave = await savedEditor.evaluate(
      () => document.documentElement.dataset.mpctlFixtureDocumentId,
    );
    const savesBefore = await savedEditor.evaluate(() =>
      Number(localStorage.getItem("mpctl-fixture-total-native-saves") ?? "0"),
    );
    const nativeSaveUrl = new URL(savedEditor.url());
    expect(
      ["isMul", "replaceScene", "isSend", "isFreePublish"].map((key) =>
        nativeSaveUrl.searchParams.get(key),
      ),
    ).toEqual(["1", "0", "0", "0"]);
    const requestsBeforeNativeSave = mpRequests.length;
    const callsAtNativeSave: string[] = [];
    await savedEditor.evaluate(() =>
      document.getElementById("synthetic-native-save")!.addEventListener("click", () => {
        (window as any).__saveCallsAtClick = (window as FixtureWindow).__mpctlFixtureCalls!.length;
      }),
    );
    const save = await cli(
      temp,
      socketPath,
      "article",
      "save",
      savedCoverArticle,
      "--expected-body-hash",
      saveBodyHash,
      "--expected-fields-hash",
      savedBeforeFields.fieldsHash,
      "--expected-cover-hash",
      changedCoverHash,
    );
    expect(save.code, `${save.stdout}\n${save.stderr}`).toBe(0);
    expect(mpRequests.length).toBe(requestsBeforeNativeSave);
    const canonicalSaveUrl = new URL(savedEditor.url());
    expect(canonicalSaveUrl.searchParams.get("appmsgid")).toBe(
      nativeSaveUrl.searchParams.get("appmsgid"),
    );
    expect(canonicalSaveUrl.searchParams.get("token")).toBe(
      nativeSaveUrl.searchParams.get("token"),
    );
    expect(canonicalSaveUrl.searchParams.get("lang")).toBe(nativeSaveUrl.searchParams.get("lang"));
    expect(canonicalSaveUrl.href).toBe(nativeSaveUrl.href);
    const savedSnapshot = JSON.parse(save.stdout).snapshot;
    expect(savedSnapshot).toMatchObject({
      operation: "save",
      state: "settled",
      effect: {
        outcome: "confirmed",
        persistence: "unverified",
      },
      result: { status: "ok", value: {} },
    });
    const repeatedSave = await cli(
      temp,
      socketPath,
      "article",
      "save",
      savedCoverArticle,
      "--expected-body-hash",
      saveBodyHash,
      "--expected-fields-hash",
      savedBeforeFields.fieldsHash,
      "--expected-cover-hash",
      changedCoverHash,
      "--operation",
      savedSnapshot.operationId,
    );
    expect(repeatedSave.code, repeatedSave.stderr).toBe(0);
    expect(JSON.parse(repeatedSave.stdout).snapshot).toEqual(savedSnapshot);
    const originalSaveStatus = await cli(
      temp,
      socketPath,
      "operation",
      "status",
      savedSnapshot.operationId,
    );
    expect(originalSaveStatus.code, originalSaveStatus.stderr).toBe(0);
    expect(JSON.parse(originalSaveStatus.stdout).snapshot).toEqual(savedSnapshot);
    expect(mpRequests.length).toBe(requestsBeforeNativeSave);
    callsAtNativeSave.push(
      ...(await savedEditor.evaluate(() =>
        (window as FixtureWindow).__mpctlFixtureCalls!.slice((window as any).__saveCallsAtClick),
      )),
    );
    expect(callsAtNativeSave).toEqual([]);
    const currentAfterSave = await cli(temp, socketPath, "article", "open", "fixture-group-1");
    expect(currentAfterSave.code, currentAfterSave.stderr).toBe(0);
    const locatedAfterSave = await cli(
      temp,
      socketPath,
      "article",
      "current",
      "--candidate",
      "fixture-group-1",
    );
    expect(locatedAfterSave.code, locatedAfterSave.stderr).toBe(0);
    const freshArticle = JSON.parse(locatedAfterSave.stdout) as {
      article: string;
      title: string;
      bodyHash: string;
    };
    expect(freshArticle.article).not.toBe(savedCoverArticle);
    const canonicalFreshBody = '<img data-fromlib="1" src="fixture-image.png">';
    expect(freshArticle.bodyHash).toBe(
      createHash("sha256").update(canonicalFreshBody).digest("hex"),
    );
    expect(freshArticle.bodyHash).not.toBe(saveBodyHash);
    expect(new Set(context.pages())).toEqual(pagesBeforeSave);
    expect(
      await savedEditor.evaluate(() => document.documentElement.dataset.mpctlFixtureDocumentId),
    ).toBe(documentBeforeSave);
    expect(
      await savedEditor.evaluate(() =>
        Number(localStorage.getItem("mpctl-fixture-total-native-saves") ?? "0"),
      ),
    ).toBe(savesBefore + 1);

    const persistedList = await cli(temp, socketPath, "article", "list");
    expect(persistedList.code, persistedList.stderr).toBe(0);
    expect(
      JSON.parse(persistedList.stdout).articles.filter(
        (item: { candidate: string }) => item.candidate === "fixture-group-1",
      ),
    ).toHaveLength(1);
    const persistedInspect = await cli(
      temp,
      socketPath,
      "article",
      "inspect",
      freshArticle.article,
    );
    expect(persistedInspect.code, persistedInspect.stderr).toBe(0);
    expect(JSON.parse(persistedInspect.stdout)).toEqual(savedBeforeFields);
    const persistedCover = await cli(temp, socketPath, "article", "cover", freshArticle.article);
    expect(persistedCover.code, persistedCover.stderr).toBe(0);
    expect(JSON.parse(persistedCover.stdout).coverHash).toBe(changedCoverHash);
    const persistedBodyPath = path.join(temp, "persisted-save-body.html");
    const persistedPull = await cli(
      temp,
      socketPath,
      "article",
      "pull",
      freshArticle.article,
      "--body",
      persistedBodyPath,
    );
    expect(persistedPull.code, persistedPull.stderr).toBe(0);
    expect(await readFile(persistedBodyPath, "utf8")).toBe(canonicalFreshBody);
    const reopenedAfterSave = await cli(temp, socketPath, "article", "open", "fixture-group-1");
    expect(reopenedAfterSave.code, reopenedAfterSave.stderr).toBe(0);
    expect(new Set(context.pages())).toEqual(pagesBeforeSave);
    expect(
      context
        .pages()
        .filter((page) => new URL(page.url()).searchParams.get("appmsgid") === "fixture-group-1"),
    ).toHaveLength(1);
    const obsoleteSaveRef = await cli(temp, socketPath, "article", "inspect", savedCoverArticle);
    expect(obsoleteSaveRef.code, obsoleteSaveRef.stderr).toBe(0);
    expect(JSON.parse(obsoleteSaveRef.stdout)).toEqual(savedBeforeFields);
    await savedEditor.evaluate(() => {
      localStorage.removeItem("mpctl-fixture-canonical-save-body");
      const saved = JSON.parse(localStorage.getItem("mpctl-fixture-saved-state") ?? "{}");
      delete saved["fixture-group-1"];
      localStorage.setItem("mpctl-fixture-saved-state", JSON.stringify(saved));
    });

    await popup.getByRole("button", { name: "断开" }).click();
    await expect(popup.getByRole("status")).toContainText("未连接");
    const disconnectedStatus = await cli(temp, socketPath, "status");
    expect(disconnectedStatus.code).toBe(0);
    expect(JSON.parse(disconnectedStatus.stdout).connected).toBe(false);

    await popup
      .getByLabel("Broker WebSocket 地址")
      .fill(`ws://127.0.0.1:${proxyAddress.port}/bridge`);
    await popup.getByRole("button", { name: "显式连接" }).click();
    await expect(popup.getByRole("button", { name: "取消连接" })).toBeVisible();
    await popup.getByRole("button", { name: "取消连接" }).click();
    await expect(popup.getByRole("status")).toContainText("未连接");
    releaseHandshake();
    await proxyReachedBrokerPromise;
    await expect(popup.getByRole("status")).toContainText("未连接");
    await popup.getByLabel("Broker WebSocket 地址").fill(wsUrl);
    await popup.getByRole("button", { name: "显式连接" }).click();
    await expect(popup.getByRole("status")).toContainText("已连接", { timeout: 15_000 });

    await popup.getByRole("button", { name: "断开" }).click();
    await expect(popup.getByRole("status")).toContainText("未连接");
    const selectedUrl = `ws://127.0.0.1:${directProxy.port}/bridge`;
    const staleSettings = {
      websocketUrl: "ws://127.0.0.1:1/stale",
      pairingCredential: "stale-wrong-synthetic-credential",
    };
    await popup.evaluate(async (settings) => {
      await chrome.storage.local.set(settings);
      const stored = await chrome.storage.local.get(["websocketUrl", "pairingCredential"]);
      if (
        stored.websocketUrl !== settings.websocketUrl ||
        stored.pairingCredential !== settings.pairingCredential
      )
        throw new Error("Could not verify synthetic popup settings seed");
    }, staleSettings);
    const settingsPopup = await context.newPage();
    const settingsPageErrors: string[] = [];
    settingsPopup.on("pageerror", (error) => settingsPageErrors.push(error.name));
    await settingsPopup.addInitScript(installSettingsReadGate);
    await settingsPopup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect
      .poll(() =>
        settingsPopup.evaluate(
          () =>
            (globalThis as unknown as { __mpctlSettingsGate?: { intercepted: number } })
              .__mpctlSettingsGate?.intercepted,
        ),
      )
      .toBe(1);
    expect(JSON.parse((await cli(temp, socketPath, "status")).stdout).connected).toBe(false);
    const proxyBeforeSelectedConnect = directProxy.attempt.clientCount;
    await settingsPopup.getByLabel("Broker WebSocket 地址").fill(selectedUrl);
    await settingsPopup.getByLabel("配对凭证").fill(credential);
    await settingsPopup.getByRole("button", { name: "显式连接" }).click();
    await expect
      .poll(
        async () => ({
          statusText: await settingsPopup.getByRole("status").innerText(),
          proxyClients: directProxy!.attempt.clientCount,
        }),
        {
          timeout: 15_000,
          message: `settings-popup boundary: ${JSON.stringify({
            proxy: directProxy.attempt,
            broker: JSON.parse((await cli(temp, socketPath, "status")).stdout),
            pageErrors: settingsPageErrors,
          })}`,
        },
      )
      .toMatchObject({
        statusText: expect.stringMatching(/^已连接/),
        proxyClients: proxyBeforeSelectedConnect + 1,
      });
    expect(JSON.parse((await cli(temp, socketPath, "status")).stdout).connected).toBe(true);
    expect(directProxy.attempt.clientCount).toBe(proxyBeforeSelectedConnect + 1);
    await settingsPopup.evaluate(async () => {
      const gate = (
        globalThis as unknown as {
          __mpctlSettingsGate?: { release(): Promise<void> };
        }
      ).__mpctlSettingsGate;
      await gate?.release();
    });
    await settingsPopup.getByRole("button", { name: "断开" }).click();
    await expect(settingsPopup.getByRole("status")).toContainText("已断开");
    await expect
      .poll(async () => JSON.parse((await cli(temp, socketPath, "status")).stdout).connected)
      .toBe(false);
    await expect(settingsPopup.getByLabel("Broker WebSocket 地址")).toHaveValue(selectedUrl);
    await expect(settingsPopup.getByLabel("配对凭证")).toHaveValue(credential);
    expect(await settingsPopup.locator("body").innerText()).not.toContain(credential);
    expect(JSON.parse((await cli(temp, socketPath, "status")).stdout).connected).toBe(false);
    expect(directProxy.attempt.clientCount).toBe(proxyBeforeSelectedConnect + 1);
    await settingsPopup.getByRole("button", { name: "显式连接" }).click();
    await expect(settingsPopup.getByRole("status")).toContainText("已连接", { timeout: 15_000 });
    await expect.poll(() => directProxy!.attempt.clientCount).toBe(proxyBeforeSelectedConnect + 2);
    expect(JSON.parse((await cli(temp, socketPath, "status")).stdout).connected).toBe(true);
    await settingsPopup.getByRole("button", { name: "断开" }).click();
    await expect(settingsPopup.getByRole("status")).toContainText("已断开");
    expect(JSON.parse((await cli(temp, socketPath, "status")).stdout).connected).toBe(false);

    for (const scenario of ["url", "credential", "clear"] as const) {
      const variantStale = {
        websocketUrl: `ws://127.0.0.1:1/${scenario}-stale`,
        pairingCredential: `${scenario}-stale-wrong-synthetic-credential`,
      };
      await popup.evaluate(async (settings) => {
        await chrome.storage.local.set(settings);
        const stored = await chrome.storage.local.get(["websocketUrl", "pairingCredential"]);
        if (
          stored.websocketUrl !== settings.websocketUrl ||
          stored.pairingCredential !== settings.pairingCredential
        )
          throw new Error("Could not verify variant popup settings seed");
      }, variantStale);
      const variant = await context.newPage();
      await variant.addInitScript(installSettingsReadGate);
      await variant.goto(`chrome-extension://${extensionId}/popup.html`);
      await expect
        .poll(() =>
          variant.evaluate(
            () =>
              (globalThis as unknown as { __mpctlSettingsGate?: { intercepted: number } })
                .__mpctlSettingsGate?.intercepted,
          ),
        )
        .toBe(1);
      if (scenario === "url") {
        await variant.getByLabel("Broker WebSocket 地址").fill("ws://127.0.0.1:12345/user");
      } else if (scenario === "credential") {
        await variant.getByLabel("配对凭证").fill("user-synthetic-credential");
      } else {
        await variant.getByLabel("配对凭证").fill("temporary-synthetic-credential");
        await variant.getByLabel("配对凭证").fill("");
      }
      await variant.evaluate(async () => {
        const gate = (
          globalThis as unknown as {
            __mpctlSettingsGate?: { release(): Promise<void> };
          }
        ).__mpctlSettingsGate;
        await gate?.release();
      });
      if (scenario === "url") {
        await expect(variant.getByLabel("配对凭证")).toHaveValue(variantStale.pairingCredential);
        await expect(variant.getByLabel("Broker WebSocket 地址")).toHaveValue(
          "ws://127.0.0.1:12345/user",
        );
      } else if (scenario === "credential") {
        await expect(variant.getByLabel("Broker WebSocket 地址")).toHaveValue(
          variantStale.websocketUrl,
        );
        await expect(variant.getByLabel("配对凭证")).toHaveValue("user-synthetic-credential");
      } else {
        await expect(variant.getByLabel("Broker WebSocket 地址")).toHaveValue(
          variantStale.websocketUrl,
        );
        await expect(variant.getByLabel("配对凭证")).toHaveValue("");
      }
      await variant.close();
    }
    const rejectedPopup = await context.newPage();
    await rejectedPopup.addInitScript(() => {
      const storage = chrome.storage.local;
      const nativeGet = storage.get.bind(storage);
      let rejectRead: ((reason: unknown) => void) | undefined;
      let acknowledgeRejection: (() => void) | undefined;
      const rejected = new Promise<void>((resolve) => (acknowledgeRejection = resolve));
      let unhandledRejections = 0;
      addEventListener("unhandledrejection", () => {
        unhandledRejections++;
      });
      const state = {
        intercepted: 0,
        unhandledRejections: () => unhandledRejections,
        reject: async () => {
          await rejected;
          rejectRead?.(new Error("synthetic-rejected-private-credential"));
        },
      };
      storage.get = ((keys: string | string[] | Record<string, unknown> | null) => {
        if (
          Array.isArray(keys) &&
          keys.length === 2 &&
          keys.includes("websocketUrl") &&
          keys.includes("pairingCredential")
        ) {
          state.intercepted++;
          return new Promise((_, reject) => {
            rejectRead = reject;
            acknowledgeRejection?.();
          }) as unknown as ReturnType<typeof storage.get>;
        }
        return nativeGet(keys as never);
      }) as typeof storage.get;
      Object.defineProperty(globalThis, "__mpctlRejectedSettings", { value: state });
    });
    await rejectedPopup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect
      .poll(() =>
        rejectedPopup.evaluate(
          () =>
            (globalThis as unknown as { __mpctlRejectedSettings?: { intercepted: number } })
              .__mpctlRejectedSettings?.intercepted,
        ),
      )
      .toBe(1);
    const rejectedUrl = "ws://127.0.0.1:1/rejected";
    const rejectedCredential = "rejected-popup-synthetic-credential";
    await rejectedPopup.getByLabel("Broker WebSocket 地址").fill(rejectedUrl);
    await rejectedPopup.getByLabel("配对凭证").fill(rejectedCredential);
    await rejectedPopup.evaluate(async () => {
      const gate = (
        globalThis as unknown as {
          __mpctlRejectedSettings?: { reject(): Promise<void> };
        }
      ).__mpctlRejectedSettings;
      await gate?.reject();
    });
    await expect(rejectedPopup.getByLabel("Broker WebSocket 地址")).toHaveValue(rejectedUrl);
    await expect(rejectedPopup.getByLabel("配对凭证")).toHaveValue(rejectedCredential);
    expect(
      await rejectedPopup.evaluate(() =>
        (
          globalThis as unknown as { __mpctlRejectedSettings?: { unhandledRejections(): number } }
        ).__mpctlRejectedSettings?.unhandledRejections(),
      ),
    ).toBe(0);
    expect(await rejectedPopup.locator("body").innerText()).not.toContain(
      "synthetic-rejected-private-credential",
    );
    expect(JSON.parse((await cli(temp, socketPath, "status")).stdout).connected).toBe(false);
    const attemptsBeforeRejectedClick = directProxy.attempt.clientCount;
    await rejectedPopup.getByRole("button", { name: "显式连接" }).click();
    await expect(rejectedPopup.getByRole("status")).toContainText("操作失败，请重试");
    await expect(rejectedPopup.getByLabel("Broker WebSocket 地址")).toHaveValue(rejectedUrl);
    await expect(rejectedPopup.getByLabel("配对凭证")).toHaveValue(rejectedCredential);
    expect(await rejectedPopup.locator("body").innerText()).not.toContain(rejectedCredential);
    expect(
      await rejectedPopup.evaluate(() =>
        (
          globalThis as unknown as { __mpctlRejectedSettings?: { unhandledRejections(): number } }
        ).__mpctlRejectedSettings?.unhandledRejections(),
      ),
    ).toBe(0);
    expect(directProxy.attempt.clientCount).toBe(attemptsBeforeRejectedClick);
    expect(JSON.parse((await cli(temp, socketPath, "status")).stdout).connected).toBe(false);
    await rejectedPopup.close();

    const nativeFailurePopup = await context.newPage();
    await nativeFailurePopup.addInitScript(installSettingsReadGate, { rejectNativeRead: true });
    await nativeFailurePopup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect
      .poll(() =>
        nativeFailurePopup.evaluate(
          () =>
            (globalThis as unknown as { __mpctlSettingsGate?: { intercepted: number } })
              .__mpctlSettingsGate?.intercepted,
        ),
      )
      .toBe(1);
    await expect(
      nativeFailurePopup.evaluate(async () => {
        const gate = (
          globalThis as unknown as {
            __mpctlSettingsGate?: { release(): Promise<void> };
          }
        ).__mpctlSettingsGate;
        await gate?.release();
      }),
    ).rejects.toThrow("synthetic-native-storage-read-failure");
    await nativeFailurePopup.close();

    await popup.getByRole("button", { name: "显式连接" }).click();
    await expect(popup.getByRole("status")).toContainText("已连接", { timeout: 15_000 });

    await popup.getByRole("button", { name: "断开" }).click();
    await expect(popup.getByRole("status")).toContainText("未连接");
    expect(JSON.parse((await cli(temp, socketPath, "status")).stdout).connected).toBe(false);
    await popup.evaluate(
      (websocketUrl) =>
        chrome.storage.local.set({
          websocketUrl,
          pairingCredential: "invalid-fixture-pairing",
        }),
      `ws://127.0.0.1:${directProxy.port}/bridge`,
    );
    directProxy.resetAttempt();
    const failedConnectBaseline = directProxy.attempt;
    const failedConnectPage = await context.newPage();
    const failedConnectConsole: string[] = [];
    failedConnectPage.on("console", (message) => failedConnectConsole.push(message.text()));
    failedConnectPage.on("pageerror", (error) => failedConnectConsole.push(error.message));
    const failedConnectEvidence = directProxy.waitForFailedAttempt();
    await failedConnectPage.goto(`chrome-extension://${extensionId}/connect.html`);
    await expect
      .poll(() =>
        failedConnectConsole.some((line) =>
          line.includes("mpctl connect page failed: connect_failed"),
        ),
      )
      .toBe(true);
    const failedConnectAttempt = await failedConnectEvidence;
    expect(failedConnectAttempt.clientCount - failedConnectBaseline.clientCount).toBe(1);
    expect(
      failedConnectAttempt.upstreamConnectionCount - failedConnectBaseline.upstreamConnectionCount,
    ).toBe(1);
    expect(
      failedConnectAttempt.forwardedRequestBytes - failedConnectBaseline.forwardedRequestBytes,
    ).toBeGreaterThan(0);
    expect(failedConnectAttempt.upstreamCloseCount - failedConnectBaseline.upstreamCloseCount).toBe(
      1,
    );
    await expect.poll(() => failedConnectPage.isClosed(), { timeout: 15_000 }).toBe(true);
    expect(failedConnectConsole.join("\n")).not.toContain("invalid-fixture-pairing");
    expect(JSON.parse((await cli(temp, socketPath, "status")).stdout).connected).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(directProxy.attempt).toEqual(failedConnectAttempt);
    await popup.evaluate(
      (value) => chrome.storage.local.set({ pairingCredential: value }),
      credential,
    );
    const pagesBeforeHandoff = new Set(context.pages());
    const handoff = await cli(temp, socketPath, "connect", "--extension", extensionId);
    expect(handoff.code).not.toBe(0);
    expect(handoff.stdout).toBe("");
    const connectionInstruction = JSON.parse(handoff.stderr).error;
    expect(connectionInstruction.code).toBe("not_connected");
    expect(connectionInstruction.connectionPageUrl).toBe(
      `chrome-extension://${extensionId}/connect.html`,
    );
    expect(typeof connectionInstruction.instruction).toBe("string");
    expect(new Set(context.pages())).toEqual(pagesBeforeHandoff);
    // The caller uses the returned URL in the actual isolated browser, not a CLI launcher.
    const connectPage = await context.newPage();
    await connectPage.goto(connectionInstruction.connectionPageUrl);
    await expect.poll(() => connectPage.isClosed(), { timeout: 15_000 }).toBe(true);
    expect(JSON.parse((await cli(temp, socketPath, "status")).stdout).connected).toBe(true);

    // Earlier fault cases deliberately left editor tabs; isolate current's unique-target case.
    for (const page of context.pages()) {
      const url = new URL(page.url());
      if (
        url.hostname === "mp.weixin.qq.com" &&
        url.pathname === "/cgi-bin/appmsg" &&
        url.searchParams.get("action") === "edit"
      )
        await page.close();
    }
    const pagesBeforeArticles = new Set(context.pages());
    const first = await cli(temp, socketPath, "article", "new");
    expect(
      first.code,
      `${first.stdout}\n${first.stderr}; MP responses=${JSON.stringify(mpResponses)}`,
    ).toBe(0);
    expect(JSON.parse(first.stdout).snapshot.effect.pageCreated).toBe(true);
    const firstLocated = await cli(temp, socketPath, "article", "current", "--new");
    expect(firstLocated.code, firstLocated.stderr).toBe(0);
    const firstArticle = (JSON.parse(firstLocated.stdout) as { article: string }).article;
    const current = await cli(temp, socketPath, "article", "current");
    expect(current.code, current.stderr).toBe(0);
    expect(JSON.parse(current.stdout).bodyHash).toBe(
      JSON.parse(first.stdout).snapshot.effect.bodyHash,
    );
    expect(JSON.parse(current.stdout).article).not.toBe(firstArticle);
    const detailedStatus = await cli(temp, socketPath, "status", "--details");
    expect(JSON.parse(detailedStatus.stdout)).toMatchObject({
      connected: true,
      brokerVersion: protocolVersion,
      extensionVersion: protocolVersion,
      expectedVersion: protocolVersion,
    });
    expect([...new URL(authenticatedHome.url()).searchParams.keys()]).toEqual([
      "t",
      "token",
      "lang",
    ]);
    expect(
      mpResponses.filter((entry) => entry.path === "/cgi-bin/home").length,
    ).toBeGreaterThanOrEqual(1);
    const firstTab = await newEditorPage(context, pagesBeforeArticles);
    await expect
      .poll(() => firstTab.evaluate(() => document.documentElement.dataset.mpctlReady))
      .toBe("yes");
    const fieldsBeforeInspect = await firstTab.evaluate(() => ({
      body: document.documentElement.dataset.mpctlBody ?? "",
      calls: (window as FixtureWindow).__mpctlFixtureCalls?.length ?? 0,
      results: (window as FixtureWindow).__mpctlFixtureResults?.length ?? 0,
    }));
    const inspected = await cli(temp, socketPath, "article", "inspect", firstArticle);
    expect(inspected.code, `${inspected.stdout}\n${inspected.stderr}`).toBe(0);
    const inspectedFields = JSON.parse(inspected.stdout) as {
      title: string;
      author: string;
      summary: string;
      fieldsHash: string;
    };
    expect(Object.keys(inspectedFields)).toEqual(["title", "author", "summary", "fieldsHash"]);
    expect(inspectedFields).toEqual({
      title: "Fixture title 🌱",
      author: "Fixture",
      summary: "",
      fieldsHash: createHash("sha256")
        .update(JSON.stringify(["Fixture title 🌱", "Fixture", ""]))
        .digest("hex"),
    });
    expect(
      await firstTab.evaluate(() => ({
        body: document.documentElement.dataset.mpctlBody ?? "",
        calls: (window as FixtureWindow).__mpctlFixtureCalls?.length ?? 0,
        results: (window as FixtureWindow).__mpctlFixtureResults?.length ?? 0,
      })),
    ).toEqual(fieldsBeforeInspect);
    expect(inspected.stdout).not.toContain("mpctl-fixture-private");
    expect(inspected.stderr).toBe("");
    const checked = await cli(temp, socketPath, "article", "check", firstArticle);
    expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
    expect(JSON.parse(checked.stdout)).toEqual({
      errors: ["body_empty"],
      warnings: [
        "summary_platform_default_unchecked",
        "cover_unchecked",
        "platform_settings_unchecked",
      ],
    });
    expect(
      await firstTab.evaluate(() => ({
        body: document.documentElement.dataset.mpctlBody ?? "",
        results: (window as FixtureWindow).__mpctlFixtureResults?.length ?? 0,
      })),
    ).toEqual({ body: fieldsBeforeInspect.body, results: fieldsBeforeInspect.results });
    expect((await cli(temp, socketPath, "article", "inspect", firstArticle)).stdout).toBe(
      inspected.stdout,
    );
    const fieldsFile = path.join(temp, "fields.json");
    await writeFile(fieldsFile, JSON.stringify({ summary: "isolated 🌱" }), "utf8");
    const updated = await cli(
      temp,
      socketPath,
      "article",
      "update",
      firstArticle,
      "--fields",
      fieldsFile,
      "--expected-hash",
      inspectedFields.fieldsHash,
    );
    expect(updated.code, `${updated.stdout}\n${updated.stderr}`).toBe(0);
    expect(Object.keys(JSON.parse(updated.stdout))).toEqual(["snapshot"]);
    const updateSnapshot = JSON.parse(updated.stdout).snapshot;
    expect(updateSnapshot).toMatchObject({
      operation: "fields",
      state: "settled",
      effect: {
        outcome: "confirmed",
        requested: ["summary"],
        attempted: ["summary"],
        confirmed: ["summary"],
        unknown: [],
      },
    });
    const repeatUpdate = await cli(
      temp,
      socketPath,
      "article",
      "update",
      firstArticle,
      "--fields",
      fieldsFile,
      "--expected-hash",
      inspectedFields.fieldsHash,
      "--operation",
      updateSnapshot.operationId,
    );
    expect(repeatUpdate.code).toBe(0);
    expect(repeatUpdate.stdout).toBe(updated.stdout);
    const inspectedAfterUpdate = await cli(temp, socketPath, "article", "inspect", firstArticle);
    expect(JSON.parse(inspectedAfterUpdate.stdout)).toMatchObject({ summary: "isolated 🌱" });
    expect(JSON.parse(inspectedAfterUpdate.stdout).title).toBe(inspectedFields.title);
    expect(JSON.parse(inspectedAfterUpdate.stdout).author).toBe(inspectedFields.author);
    await writeFile(fieldsFile, JSON.stringify({ author: "stale" }), "utf8");
    const staleUpdate = await cli(
      temp,
      socketPath,
      "article",
      "update",
      firstArticle,
      "--fields",
      fieldsFile,
      "--expected-hash",
      inspectedFields.fieldsHash,
    );
    expect(staleUpdate.code).not.toBe(0);
    expect(JSON.parse(staleUpdate.stderr.split("\n").slice(1).join("\n")).error.code).toBe(
      "content_conflict",
    );
    expect((await cli(temp, socketPath, "article", "inspect", firstArticle)).stdout).toContain(
      '"author":"Fixture"',
    );
    expect(await firstTab.evaluate(() => document.documentElement.dataset.mpctlBody ?? "")).toBe(
      fieldsBeforeInspect.body,
    );
    const concurrentBase = JSON.parse(inspectedAfterUpdate.stdout) as { fieldsHash: string };
    const firstFieldsFile = path.join(temp, "first-fields.json");
    const secondFieldsFile = path.join(temp, "second-fields.json");
    await writeFile(firstFieldsFile, JSON.stringify({ author: "Winner" }), "utf8");
    await writeFile(secondFieldsFile, JSON.stringify({ summary: "Queued loser" }), "utf8");
    const queuedFirst = cli(
      temp,
      socketPath,
      "article",
      "update",
      firstArticle,
      "--fields",
      firstFieldsFile,
      "--expected-hash",
      concurrentBase.fieldsHash,
    );
    const queuedSecond = cli(
      temp,
      socketPath,
      "article",
      "update",
      firstArticle,
      "--fields",
      secondFieldsFile,
      "--expected-hash",
      concurrentBase.fieldsHash,
    );
    const queuedResults = await Promise.all([queuedFirst, queuedSecond]);
    expect(queuedResults.map((result) => result.code).sort()).toEqual([0, 1]);
    expect(queuedResults.find((result) => result.code !== 0)?.stderr).toContain(
      '"code":"content_conflict"',
    );
    const concurrentAfter = JSON.parse(
      (await cli(temp, socketPath, "article", "inspect", firstArticle)).stdout,
    ) as { author: string; summary: string };
    expect(concurrentAfter.author === "Winner" || concurrentAfter.summary === "Queued loser").toBe(
      true,
    );
    expect(concurrentAfter.author === "Winner" && concurrentAfter.summary === "Queued loser").toBe(
      false,
    );
    const beforeClear = JSON.parse(
      (await cli(temp, socketPath, "article", "inspect", firstArticle)).stdout,
    ) as { title: string; author: string; summary: string; fieldsHash: string };
    await writeFile(fieldsFile, JSON.stringify({ title: "" }), "utf8");
    const titleCleared = await cli(
      temp,
      socketPath,
      "article",
      "update",
      firstArticle,
      "--fields",
      fieldsFile,
      "--expected-hash",
      beforeClear.fieldsHash,
    );
    expect(titleCleared.code, `${titleCleared.stdout}\n${titleCleared.stderr}`).toBe(0);
    const afterClear = JSON.parse(
      (await cli(temp, socketPath, "article", "inspect", firstArticle)).stdout,
    ) as { title: string; author: string; summary: string; fieldsHash: string };
    expect(afterClear.title === "" || afterClear.title === "\n").toBe(true);
    expect(afterClear.fieldsHash).toBe(
      createHash("sha256")
        .update(JSON.stringify([afterClear.title, afterClear.author, afterClear.summary]))
        .digest("hex"),
    );
    expect(await firstTab.locator('[data-placeholder="请在这里输入标题"]').textContent()).toMatch(
      /^\n?$/,
    );
    const titleBase = JSON.parse(
      (await cli(temp, socketPath, "article", "inspect", firstArticle)).stdout,
    ) as { title: string; author: string; summary: string; fieldsHash: string };
    await writeFile(fieldsFile, JSON.stringify({ title: "Updated fixture title 🌱" }), "utf8");
    const titleUpdated = await cli(
      temp,
      socketPath,
      "article",
      "update",
      firstArticle,
      "--fields",
      fieldsFile,
      "--expected-hash",
      titleBase.fieldsHash,
    );
    expect(titleUpdated.code, `${titleUpdated.stdout}\n${titleUpdated.stderr}`).toBe(0);
    const titleInspected = JSON.parse(
      (await cli(temp, socketPath, "article", "inspect", firstArticle)).stdout,
    ) as { title: string; author: string; summary: string; fieldsHash: string };
    expect(titleInspected).toMatchObject({
      title: "Updated fixture title 🌱",
      author: titleBase.author,
      summary: titleBase.summary,
    });
    expect(titleInspected.fieldsHash).not.toBe(titleBase.fieldsHash);
    expect(await firstTab.locator('[data-placeholder="请在这里输入标题"]').innerText()).toBe(
      "Updated fixture title 🌱",
    );
    expect(await firstTab.locator("#title").inputValue()).toBe("Updated fixture title 🌱");
    // B-F2 real CLI -> IPC -> Relay -> BG -> ISOLATED native title/input.
    // The actual input listener invalidates author after its input, before change.
    await firstTab.evaluate(() => {
      const counts = { title: 0, authorInput: 0, authorChange: 0, summary: 0 };
      (window as unknown as { fieldsCounts: typeof counts }).fieldsCounts = counts;
      document
        .querySelector('[data-placeholder="请在这里输入标题"]')!
        .addEventListener("input", () => {
          counts.title++;
        });
      document.querySelector("#author")!.addEventListener("input", () => {
        counts.authorInput++;
        (document.querySelector("#author") as HTMLInputElement).disabled = true;
      });
      document.querySelector("#author")!.addEventListener("change", () => {
        counts.authorChange++;
      });
      document.querySelector("#js_description")!.addEventListener("input", () => {
        counts.summary++;
      });
    });
    const partialBase = JSON.parse(
      (await cli(temp, socketPath, "article", "inspect", firstArticle)).stdout,
    );
    await writeFile(
      fieldsFile,
      JSON.stringify({ title: "Partial title", author: "Partial", summary: "must not run" }),
    );
    const partial = await cli(
      temp,
      socketPath,
      "article",
      "update",
      firstArticle,
      "--fields",
      fieldsFile,
      "--expected-hash",
      partialBase.fieldsHash,
    );
    expect(partial.code).toBe(1);
    const partialError = JSON.parse(partial.stderr.split("\n").slice(1).join("\n")).error;
    expect(partialError.snapshot).toMatchObject({
      operation: "fields",
      state: "settled",
      effect: {
        outcome: "partial",
        requested: ["title", "author", "summary"],
        attempted: ["title", "author"],
        confirmed: ["title"],
        unknown: ["author"],
      },
      result: {
        status: "error",
        error: {
          code: "fields_unavailable",
          cause: { at: "content.guard", code: "fields_unavailable" },
        },
      },
    });
    const partialId = partialError.snapshot.operationId;
    const counts = await firstTab.evaluate(
      () => (window as unknown as { fieldsCounts: object }).fieldsCounts,
    );
    expect(counts).toEqual({ title: 1, authorInput: 1, authorChange: 0, summary: 0 });
    const partialRepeated = await cli(
      temp,
      socketPath,
      "article",
      "update",
      firstArticle,
      "--fields",
      fieldsFile,
      "--expected-hash",
      partialBase.fieldsHash,
      "--operation",
      partialId,
    );
    expect(partialRepeated.code).toBe(1);
    expect(
      JSON.parse(partialRepeated.stderr.split("\n").slice(1).join("\n")).error.snapshot,
    ).toEqual(partialError.snapshot);
    const partialStatus = await cli(temp, socketPath, "operation", "status", partialId);
    expect(partialStatus.code).toBe(0);
    expect(JSON.parse(partialStatus.stdout).snapshot).toEqual(partialError.snapshot);
    expect(
      await firstTab.evaluate(() => (window as unknown as { fieldsCounts: object }).fieldsCounts),
    ).toEqual(counts);
    expect(await firstTab.locator("#js_description").inputValue()).toBe(partialBase.summary);
    await firstTab.evaluate(() => {
      (document.querySelector("#author") as HTMLInputElement).disabled = false;
    });
    expect(await firstTab.evaluate(() => document.documentElement.dataset.mpctlBody ?? "")).toBe(
      fieldsBeforeInspect.body,
    );
    await expect
      .poll(() => firstTab.evaluate(() => Boolean((window as FixtureWindow).__MP_Editor_JSAPI__)))
      .toBe(true);
    const firstRoute = new URL(firstTab.url());
    expect([...firstRoute.searchParams.keys()]).toEqual([
      "t",
      "action",
      "isNew",
      "type",
      "createType",
      "token",
      "lang",
    ]);
    expect(firstRoute.searchParams.get("createType")).toBe("0");
    expect(firstRoute.searchParams.get("lang")).toBe("zh_CN");
    for (const value of [
      "synthetic-new-create-type",
      "synthetic-new-token",
      "synthetic-new-language",
      "synthetic-new-timestamp",
    ]) {
      expect(first.stdout).not.toContain(value);
      expect(first.stderr).not.toContain(value);
    }
    const pagesBeforeSecondArticle = new Set(context.pages());
    const second = await cli(temp, socketPath, "article", "new");
    expect(second.code).not.toBe(0);
    expect(cliErrorCode(second.stderr)).toBe("target_ambiguous");
    expect(new Set(context.pages())).toEqual(pagesBeforeSecondArticle);
    // A distinct saved article is allowed; retain independent-reference and
    // current's multiple-editor ambiguity coverage without duplicating a page.
    const otherSaved = await cli(temp, socketPath, "article", "open", "fixture-group-2");
    expect(otherSaved.code, otherSaved.stderr).toBe(0);
    const secondTab = await savedEditorPage(context, pagesBeforeSecondArticle, "fixture-group-2");
    const secondLocated = await cli(
      temp,
      socketPath,
      "article",
      "current",
      "--candidate",
      "fixture-group-2",
    );
    expect(secondLocated.code, secondLocated.stderr).toBe(0);
    const secondArticle = (JSON.parse(secondLocated.stdout) as { article: string }).article;
    expect(secondArticle).not.toBe(firstArticle);
    const ambiguousCurrent = await cli(temp, socketPath, "article", "current");
    expect(ambiguousCurrent.code).not.toBe(0);
    expect(JSON.parse(ambiguousCurrent.stderr).error.code).toBe("target_ambiguous");
    expect(pagesBeforeSecondArticle.has(secondTab)).toBe(false);
    await expect
      .poll(() => secondTab.evaluate(() => document.documentElement.dataset.mpctlReady))
      .toBe("yes");

    const html = "<h1>文件驱动 🌱</h1><p>你好，世界 — café</p>";
    await writeFile(bodyFile, html, "utf8");
    expect(
      (
        await cli(
          temp,
          socketPath,
          "article",
          "push",
          firstArticle,
          "--body",
          bodyFile,
          "--expected-hash",
          JSON.parse(first.stdout).snapshot.effect.bodyHash,
        )
      ).code,
    ).toBe(0);
    await expect
      .poll(() => firstTab.evaluate(() => document.documentElement.dataset.mpctlBody ?? ""))
      .toBe(html);
    expect(
      await firstTab.evaluate(
        () =>
          (window as FixtureWindow).__mpctlFixtureCalls?.filter((call) => call === "set_content")
            .length,
      ),
    ).toBe(1);
    expect(
      await firstTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureResults?.[0]),
    ).toEqual({ apiName: "mp_editor_set_content", content: html });
    expect(await readFile(bodyFile, "utf8")).toBe(html);

    const firstPulled = path.join(temp, "pulled.html");
    expect(
      (await cli(temp, socketPath, "article", "pull", firstArticle, "--body", firstPulled)).code,
    ).toBe(0);
    expect(await readFile(firstPulled, "utf8")).toBe(html);
    expect(
      await firstTab.evaluate(
        () =>
          (window as FixtureWindow).__mpctlFixtureCalls?.filter((call) => call === "set_content")
            .length,
      ),
    ).toBe(1);
    const secondBefore = await cli(
      temp,
      socketPath,
      "article",
      "pull",
      secondArticle,
      "--body",
      path.join(temp, "second.html"),
    );
    expect(secondBefore.code).toBe(0);
    expect(await readFile(path.join(temp, "second.html"), "utf8")).toBe(
      "<p>body for fixture-group-2</p>",
    );

    const secondDocumentUrl = secondTab.url();
    const secondDocumentId = await secondTab.evaluate(
      () => document.documentElement.dataset.mpctlFixtureDocumentId,
    );
    await secondTab.getByRole("button", { name: "Interact with editor fixture" }).click();
    await expect
      .poll(() => secondTab.evaluate(() => document.documentElement.dataset.mpctlTrustedClick))
      .toBe("true");
    expect(secondTab.url()).toBe(secondDocumentUrl);
    expect(
      await secondTab.evaluate(() => document.documentElement.dataset.mpctlFixtureDocumentId),
    ).toBe(secondDocumentId);
    expect(await secondTab.evaluate(() => document.documentElement.dataset.mpctlReady)).toBe("yes");
    const guardedPullPath = path.join(temp, "guarded-pull.html");
    const guardedPull = await cli(
      temp,
      socketPath,
      "article",
      "pull",
      secondArticle,
      "--body",
      guardedPullPath,
    );
    expect(guardedPull.code, guardedPull.stderr).toBe(0);
    expect(await readFile(guardedPullPath, "utf8")).toBe("<p>body for fixture-group-2</p>");

    const guardedPush = await cli(
      temp,
      socketPath,
      "article",
      "push",
      secondArticle,
      "--body",
      bodyFile,
      "--expected-hash",
      JSON.parse(secondBefore.stdout).bodyHash,
    );
    expect(guardedPush.code, guardedPush.stderr).toBe(0);
    const stalePush = await cli(
      temp,
      socketPath,
      "article",
      "push",
      secondArticle,
      "--body",
      bodyFile,
      "--expected-hash",
      JSON.parse(secondBefore.stdout).bodyHash,
    );
    expect(stalePush.code).not.toBe(0);
    expect(JSON.parse(stalePush.stderr.trim().split("\n").at(-1)!).error.code).toBe(
      "content_conflict",
    );
    expect(
      await secondTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureResults),
    ).toHaveLength(1);

    const listResult = await cli(temp, socketPath, "article", "list");
    expect(listResult.code, `${listResult.stdout}\n${listResult.stderr}`).toBe(0);
    expect(listResult.stdout).not.toContain("synthetic-token");
    expect(listResult.stderr).not.toContain("synthetic-token");
    const listed = (
      JSON.parse(listResult.stdout) as { articles: Array<{ candidate: string; title: string }> }
    ).articles;
    expect(listed.map((item) => item.title)).toEqual([
      "Synthetic saved article one",
      "Synthetic saved article two",
    ]);
    const repeatedList = await cli(temp, socketPath, "article", "list");
    expect(repeatedList.code).toBe(0);
    expect(JSON.parse(repeatedList.stdout).articles).toEqual(listed);
    const savedListPage = context
      .pages()
      .find((candidate) => candidate.url().includes("action=list_card"));
    expect(savedListPage).toBeDefined();
    expect(new URL(savedListPage!.url()).searchParams.get("lang")).toBe("synthetic-list-language");
    expect(new URL(savedListPage!.url()).searchParams.get("token")).toBe("synthetic-token");
    await savedListPage!.evaluate(() => {
      localStorage.setItem("mpctl-fixture-second-item", "hidden");
      const link = document.querySelector<HTMLAnchorElement>(
        '[data-appid="fixture-group-1"] .weui-desktop-tooltip__wrp.weui-desktop-link a',
      );
      if (!link) throw new Error("saved draft edit link is missing");
      const observedTarget = link.href;
      link.href = "javascript:;";
      link.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          setTimeout(() => {
            const target = new URL(observedTarget);
            target.searchParams.set("timestamp", "native-async-context");
            link.href = target.href;
            setTimeout(() => window.open(link.href), 30);
          }, 0);
        },
        { once: true },
      );
    });
    await savedListPage!.addScriptTag({
      content: nativeHandlerFixtureScript(true, false, "fixture-group-1"),
    });
    const pagesBeforeValidSavedOpen = new Set(context.pages());
    const validOpen = await cli(temp, socketPath, "article", "open", listed[0]!.candidate);
    expect(validOpen.code, `${validOpen.stdout}\n${validOpen.stderr}`).toBe(0);
    expect(validOpen.stdout).not.toContain("synthetic-token");
    expect(validOpen.stderr).not.toContain("synthetic-token");
    expect(validOpen.stdout).not.toContain("synthetic-reprint-confirm");
    expect(validOpen.stderr).not.toContain("synthetic-reprint-confirm");
    const savedTab = await newEditorPage(context, pagesBeforeValidSavedOpen);
    const savedRoute = new URL(savedTab.url());
    expect(savedRoute.searchParams.get("isMul")).toBe("1");
    expect(savedRoute.searchParams.get("lang")).toBe("zh_CN");
    expect(savedRoute.searchParams.get("replaceScene")).toBe("0");
    expect(savedRoute.searchParams.get("isSend")).toBe("0");
    expect(savedRoute.searchParams.get("isFreePublish")).toBe("0");
    expect(savedRoute.searchParams.get("token")).toBe("synthetic-new-token");
    expect(await savedTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureCalls)).toContain(
      "get_content",
    );
    expect(await savedTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureResults)).toEqual(
      [],
    );
    await savedTab.evaluate(() => {
      document.querySelector('[data-msgindex="1"]')?.remove();
    });
    // Synthetic relogin: the explicit CLI open recovers the same owned tab;
    // current remains read-only and no SAVE/native content write is issued.
    const reloginPageCount = context.pages().length;
    const readyDocument = await savedTab.evaluate(
      () => document.documentElement.dataset.mpctlFixtureDocumentId,
    );
    const requestsBeforeReadyReuse = mpRequests.length;
    const readyReuse = await cli(temp, socketPath, "article", "open", listed[0]!.candidate);
    // The native-handler fixture deliberately switches editor context but not
    // the list context. Ready reuse must refuse that relationship, not reload.
    expect(readyReuse.code).toBe(1);
    expect(cliErrorCode(readyReuse.stderr)).toBe("relationship_unknown");
    expect(
      await savedTab.evaluate(() => document.documentElement.dataset.mpctlFixtureDocumentId),
    ).toBe(readyDocument);
    expect(mpRequests.length).toBe(requestsBeforeReadyReuse);
    await savedTab.evaluate(() => {
      document.body.classList.add("page_error", "page_timeout");
      const info = document.createElement("div");
      info.id = "info";
      info.textContent = "登录超时，请重新登录";
      const link = document.createElement("a");
      link.id = "jumpUrl";
      link.href = "/cgi-bin/loginpage?url=synthetic-secret";
      document.body.append(info, link);
    });
    const expiredCurrent = await cli(
      temp,
      socketPath,
      "article",
      "current",
      "--candidate",
      listed[0]!.candidate,
    );
    expect(expiredCurrent.code).toBe(1);
    expect(cliErrorCode(expiredCurrent.stderr)).toBe("not_logged_in");
    expect(
      await savedTab.evaluate(() => document.documentElement.dataset.mpctlFixtureDocumentId),
    ).toBe(readyDocument);
    const reloginRequests = mpRequests.length;
    const reloginDiagnostics: string[] = [];
    const onReloginConsole = (message: import("@playwright/test").ConsoleMessage) =>
      reloginDiagnostics.push(`${message.location().url} ${message.text()}`);
    context.on("console", onReloginConsole);
    const reloginOpen = await cli(temp, socketPath, "article", "open", listed[0]!.candidate);
    context.off("console", onReloginConsole);
    await testInfo.attach("relogin-diagnostics", {
      contentType: "application/json",
      body: JSON.stringify({
        console: reloginDiagnostics,
        requests: mpRequests.slice(reloginRequests),
        pages: context.pages().map((page) => page.url()),
        target: await savedTab.evaluate(() => ({
          url: location.href,
          document: document.documentElement.dataset.mpctlFixtureDocumentId,
          body: document.body.className,
          fixture: (window as FixtureWindow).__mpctlFixtureResults,
        })),
        frames: await context.serviceWorkers()[0]!.evaluate(async () => {
          const tabs = await chrome.tabs.query({ url: "https://mp.weixin.qq.com/*" });
          return Promise.all(
            tabs.map(async (tab) => ({
              id: tab.id,
              url: tab.url,
              frame: await chrome.webNavigation.getFrame({ tabId: tab.id!, frameId: 0 }),
            })),
          );
        }),
      }),
    });
    expect(reloginOpen.code, `${reloginOpen.stdout}\n${reloginOpen.stderr}`).toBe(0);
    expect(JSON.parse(reloginOpen.stdout).snapshot).toMatchObject({
      operation: "open",
      state: "settled",
      effect: { pageCreated: false, targetBound: true, outcome: "confirmed" },
    });
    const reloginSnapshot = JSON.parse(reloginOpen.stdout).snapshot;
    const requestsBeforeReplay = mpRequests.length;
    const replayOpen = await cli(
      temp,
      socketPath,
      "article",
      "open",
      listed[0]!.candidate,
      "--operation",
      reloginSnapshot.operationId,
    );
    const queryOpen = await cli(
      temp,
      socketPath,
      "operation",
      "status",
      reloginSnapshot.operationId,
    );
    expect(replayOpen.code, replayOpen.stderr).toBe(0);
    expect(queryOpen.code, queryOpen.stderr).toBe(0);
    expect(JSON.parse(replayOpen.stdout).snapshot).toEqual(reloginSnapshot);
    expect(JSON.parse(queryOpen.stdout).snapshot).toEqual(reloginSnapshot);
    expect(mpRequests.length).toBe(requestsBeforeReplay);
    expect(context.pages().length).toBe(reloginPageCount);
    expect(
      await savedTab.evaluate(() => document.documentElement.dataset.mpctlFixtureDocumentId),
    ).not.toBe(readyDocument);
    expect(
      mpRequests
        .slice(reloginRequests)
        .filter((request) => new URL(request).searchParams.get("appmsgid") === "fixture-group-1"),
    ).toHaveLength(1);
    expect(await savedTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureResults)).toEqual(
      [],
    );
    expect(
      await savedTab.evaluate(
        () => (window as FixtureWindow).__mpctlFixtureAssets?.nativeSaveCount,
      ),
    ).toBe(0);
    await savedTab.evaluate(() => document.querySelector('[data-msgindex="1"]')?.remove());
    const validCurrent = await cli(
      temp,
      socketPath,
      "article",
      "current",
      "--candidate",
      listed[0]!.candidate,
    );
    expect(validCurrent.code, validCurrent.stderr).toBe(0);
    const savedArticle = (JSON.parse(validCurrent.stdout) as { article: string }).article;
    await expect
      .poll(() => savedTab.evaluate(() => document.documentElement.dataset.mpctlFixtureGroup))
      .toBe("fixture-group-1");
    const savedBodyFile = path.join(temp, "saved-body.html");
    const savedPull = await cli(
      temp,
      socketPath,
      "article",
      "pull",
      savedArticle,
      "--body",
      savedBodyFile,
    );
    expect(savedPull.code, `${savedPull.stdout}\n${savedPull.stderr}`).toBe(0);
    expect(savedPull.stdout).not.toContain("synthetic-token");
    expect(savedPull.stderr).not.toContain("synthetic-token");
    expect(savedPull.stdout).not.toContain("synthetic-reprint-confirm");
    expect(savedPull.stderr).not.toContain("synthetic-reprint-confirm");
    expect(await readFile(savedBodyFile, "utf8")).toBe("<p>body for fixture-group-1</p>");
    await writeFile(bodyFile, "<p>saved edit 🌱</p>", "utf8");
    const savedPush = await cli(
      temp,
      socketPath,
      "article",
      "push",
      savedArticle,
      "--body",
      bodyFile,
      "--expected-hash",
      JSON.parse(savedPull.stdout).bodyHash,
    );
    expect(savedPush.code, `${savedPush.stdout}\n${savedPush.stderr}`).toBe(0);
    expect(savedPush.stdout).not.toContain("synthetic-token");
    expect(savedPush.stderr).not.toContain("synthetic-token");
    expect(savedPush.stdout).not.toContain("synthetic-reprint-confirm");
    expect(savedPush.stderr).not.toContain("synthetic-reprint-confirm");
    await expect
      .poll(() => savedTab.evaluate(() => document.documentElement.dataset.mpctlBody ?? ""))
      .toBe("<p>saved edit 🌱</p>");
    const listPage = context
      .pages()
      .find((candidate) => candidate.url().includes("action=list_card"));
    expect(listPage).toBeDefined();
    await listPage!.evaluate(() => {
      const duplicate = document
        .querySelector<HTMLElement>('.weui-desktop-card[data-appid="fixture-group-2"]')!
        .cloneNode(true) as HTMLElement;
      document.getElementById("draft-list")!.append(duplicate);
    });
    const invalidatedList = await cli(temp, socketPath, "article", "open", listed[1]!.candidate);
    expect(invalidatedList.code).not.toBe(0);
    expect(cliErrorCode(invalidatedList.stderr)).toBe("target_unavailable");
    await savedTab.evaluate(() => {
      const item = document.createElement("div");
      item.className = "js_appmsg_item current";
      item.dataset.msgindex = "1";
      document.getElementById("saved-editor")?.append(item);
    });
    const savedCallsBeforeAmbiguous = await savedTab.evaluate(
      () => (window as FixtureWindow).__mpctlFixtureCalls?.length ?? 0,
    );
    const ambiguousPull = await cli(
      temp,
      socketPath,
      "article",
      "pull",
      savedArticle,
      "--body",
      path.join(temp, "ambiguous.html"),
    );
    expect(ambiguousPull.code).not.toBe(0);
    expect(JSON.parse(ambiguousPull.stderr).error.code).toBe("target_unavailable");
    expect(
      await savedTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureCalls?.length ?? 0),
    ).toBe(savedCallsBeforeAmbiguous);
    const ambiguousPush = await cli(
      temp,
      socketPath,
      "article",
      "push",
      savedArticle,
      "--body",
      bodyFile,
      "--expected-hash",
      JSON.parse(savedPush.stdout).snapshot.effect.bodyHash,
    );
    expect(ambiguousPush.code).not.toBe(0);
    expect(JSON.parse(ambiguousPush.stderr.trim().split("\n").at(-1)!).error.code).toBe(
      "target_unavailable",
    );
    expect(
      await savedTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureResults?.length ?? 0),
    ).toBe(1);

    await savedTab.evaluate(() => {
      const item = document.createElement("div");
      item.className = "js_appmsg_item appmsg_item_wrp";
      item.dataset.msgindex = "1";
      document.getElementById("saved-editor")?.append(item);
    });
    const callsBeforeNonCurrentPull = await savedTab.evaluate(
      () => (window as FixtureWindow).__mpctlFixtureCalls?.length ?? 0,
    );
    const nonCurrentPull = await cli(
      temp,
      socketPath,
      "article",
      "pull",
      savedArticle,
      "--body",
      path.join(temp, "non-current.html"),
    );
    expect(nonCurrentPull.code).not.toBe(0);
    expect(JSON.parse(nonCurrentPull.stderr).error.code).toBe("target_unavailable");
    expect(
      await readFile(path.join(temp, "non-current.html")).catch(() => undefined),
    ).toBeUndefined();
    const nonCurrentPush = await cli(
      temp,
      socketPath,
      "article",
      "push",
      savedArticle,
      "--body",
      bodyFile,
      "--expected-hash",
      JSON.parse(savedPush.stdout).snapshot.effect.bodyHash,
    );
    expect(nonCurrentPush.code).not.toBe(0);
    expect(JSON.parse(nonCurrentPush.stderr.trim().split("\n").at(-1)!).error.code).toBe(
      "target_unavailable",
    );
    expect(
      await savedTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureCalls?.length ?? 0),
    ).toBe(callsBeforeNonCurrentPull);
    expect(
      await savedTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureResults),
    ).toHaveLength(1);

    await firstTab.reload();
    await expect
      .poll(() => firstTab.evaluate(() => document.documentElement.dataset.mpctlReady))
      .toBe("yes");
    // Use a fresh view without the first popup's synthetic bootstrap fault.
    const reconnectPopup = await context.newPage();
    await reconnectPopup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(reconnectPopup.getByRole("status")).toContainText("已连接");
    await reconnectPopup.getByRole("button", { name: "断开" }).click();
    await expect(reconnectPopup.getByRole("status")).toContainText("未连接");
    await expect
      .poll(() => cli(temp, socketPath, "status").then((result) => result.stdout))
      .toContain('"connected":false');
    await reconnectPopup.getByRole("button", { name: "显式连接" }).click();
    await expect(reconnectPopup.getByRole("status")).toContainText("已连接", { timeout: 15_000 });
    await authenticatedHome.goto(homeUrl);
    await expect(authenticatedHome.locator("div.new-creation__menu-item")).toHaveText("文章");
    const pagesBeforeReconnect = new Set(context.pages());
    await firstTab.close();
    await secondTab.close();
    const reloaded = await cli(temp, socketPath, "article", "new");
    expect(reloaded.code, `${reloaded.stdout}\n${reloaded.stderr}`).toBe(0);
    const reloadedCurrent = await cli(temp, socketPath, "article", "current", "--new");
    expect(reloadedCurrent.code, reloadedCurrent.stderr).toBe(0);
    const reloadedArticle = (JSON.parse(reloadedCurrent.stdout) as { article: string }).article;
    expect(reloadedArticle).not.toBe(firstArticle);
    const reloadedTab = await newEditorPage(context, pagesBeforeReconnect);
    const afterReconnect = await cli(
      temp,
      socketPath,
      "article",
      "pull",
      reloadedArticle,
      "--body",
      path.join(temp, "reconnected.html"),
    );
    expect(afterReconnect.code, `${afterReconnect.stdout}\n${afterReconnect.stderr}`).toBe(0);
    expect(await readFile(path.join(temp, "reconnected.html"), "utf8")).toBe("");
    expect(
      await reloadedTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureCalls),
    ).toContain("get_content");
    expect(
      await reloadedTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureResults),
    ).toHaveLength(0);
    const duplicateTabs = await reconnectPopup.evaluate(async () => {
      const created = [];
      for (let index = 0; index < 2; index++) {
        const tab = await chrome.tabs.create({ url: "about:blank", active: false });
        const group = await chrome.tabs.group({ tabIds: tab.id! });
        await chrome.tabGroups.update(group, { title: "mpctl" });
        created.push(tab.id!);
      }
      return created;
    });
    const cleanup = await cli(temp, socketPath, "workspace", "cleanup");
    expect(cleanup.code, cleanup.stderr).toBe(0);
    expect(JSON.parse(cleanup.stdout)).toEqual({
      groupsRemoved: 2,
      tabsMoved: 2,
      groupsRemaining: 1,
    });
    expect(
      await reconnectPopup.evaluate(async (ids) => {
        const { managedGroupId } = await chrome.storage.local.get("managedGroupId");
        const groups = await chrome.tabGroups.query({ title: "mpctl" });
        const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
        return {
          groupCount: groups.length,
          allPreserved: tabs.every((tab) => tab.groupId === managedGroupId),
        };
      }, duplicateTabs),
    ).toEqual({ groupCount: 1, allPreserved: true });
    const again = await cli(temp, socketPath, "workspace", "cleanup");
    expect(JSON.parse(again.stdout)).toEqual({
      groupsRemoved: 0,
      tabsMoved: 0,
      groupsRemaining: 1,
    });
    const unexpectedMpRequests = mpRequests.filter(
      (request) =>
        !(
          new URL(request).hostname === "mp.weixin.qq.com" &&
          [
            "/",
            "/cgi-bin/home",
            "/cgi-bin/appmsg",
            "/cgi-bin/jsapi.js",
            "/fixture-pending-editor-image",
          ].includes(new URL(request).pathname)
        ) &&
        !(
          new URL(request).hostname === "mmbiz.qpic.cn" &&
          [
            "/mmbiz_png/fixture-probe/0",
            "/mmbiz_png/current/0",
            "/mmbiz_png/synthetic-library-card/300",
            "/mmbiz_png/synthetic-library-card/0",
            "/mmbiz_png/synthetic-body-cover/0",
          ].includes(new URL(request).pathname)
        ),
    );
    expect(unexpectedMpRequests).toEqual([]);
    expect(imageResponses.length).toBeGreaterThan(0);
    expect(
      imageResponses.every(
        (image) =>
          image.status === 200 &&
          image.contentType?.startsWith("image/png") &&
          image.bytes === cropPng.byteLength &&
          image.sha256 === cropPngHash,
      ),
    ).toBe(true);
    expect(
      mpResponses.filter((entry) => entry.path === "/cgi-bin/appmsg").length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      mpResponses.filter((entry) => entry.path === "/cgi-bin/jsapi.js").length,
    ).toBeGreaterThanOrEqual(3);
    expect(mpResponses.every((entry) => entry.status === 200)).toBe(true);

    // These isolated editors have completed their assertions. Release only
    // fixture-owned pages so the login test exercises login, not identity conflict.
    for (const editor of context.pages().filter((candidate) => {
      const url = new URL(candidate.url());
      return url.hostname === "mp.weixin.qq.com" && url.searchParams.get("action") === "edit";
    }))
      await editor.close();
    loginTimeoutMode = true;
    await savedListPage!.reload();
    await expect(savedListPage!.locator("body")).toContainText("登录超时");
    const jsapiRequestsBeforeTimeout = mpRequests.filter(
      (request) => new URL(request).pathname === "/cgi-bin/jsapi.js",
    ).length;
    const loginList = await cli(temp, socketPath, "article", "list");
    expect(loginList.code).not.toBe(0);
    expect(JSON.parse(loginList.stderr).error.code).toBe("not_logged_in");
    expect(loginList.stderr).not.toContain("synthetic-secret");
    await authenticatedHome.goto(homeUrl);
    await expect(authenticatedHome.locator("div.new-creation__menu-item")).toHaveText("文章");
    const pagesBeforeLoginNew = new Set(context.pages());
    // Hold only the waiter's existing final-second callback. Actual DOM expiry
    // must reach BG through the production identity path before this runs.
    const loginWorker = context.serviceWorkers()[0]!;
    await loginWorker.evaluate(() => {
      const original = globalThis.setTimeout;
      const held: Array<{ callback: () => void; deadline: number }> = [];
      globalThis.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
        if (delay >= 8500 && delay <= 9000) {
          held.push({ callback, deadline: Date.now() + delay + 1000 });
          return -held.length;
        }
        return original(callback, delay, ...args);
      }) as typeof setTimeout;
      Object.assign(globalThis, { b1LoginTimer: { original, held } });
    });
    const loginStartup: Array<Record<string, unknown>> = [];
    const loginCreated: Page[] = [];
    const observeLoginPage = (page: Page) => {
      if (pagesBeforeLoginNew.has(page)) return;
      const pageIndex = loginCreated.push(page) - 1;
      page.on("console", (message) => {
        if (message.text().includes("mpctl content startup failed"))
          loginStartup.push({ pageIndex, kind: "startup", message: message.text() });
      });
      page.on("pageerror", (error) =>
        loginStartup.push({
          pageIndex,
          kind: "pageerror",
          name: error.name,
          message: error.message,
        }),
      );
      page.on("requestfailed", (request) =>
        loginStartup.push({
          pageIndex,
          kind: "requestfailed",
          path: new URL(request.url()).pathname,
          error: request.failure()?.errorText,
        }),
      );
    };
    context.on("page", observeLoginPage);
    let loginNew: Awaited<ReturnType<typeof cli>>;
    try {
      loginNew = await cli(temp, socketPath, "article", "new");
    } finally {
      context.off("page", observeLoginPage);
    }
    const loginDocuments = await Promise.all(
      loginCreated.map(async (page, pageIndex) => ({
        pageIndex,
        state: await page
          .evaluate(() => ({
            readyState: document.readyState,
            path: location.pathname,
            isNew: new URL(location.href).searchParams.get("isNew"),
            expired:
              document.body.classList.contains("page_timeout") &&
              Boolean(document.querySelector("#info")) &&
              Boolean(document.querySelector("#jumpUrl")),
            scripts: [...document.scripts].map((script) =>
              script.src ? new URL(script.src).pathname : "inline",
            ),
          }))
          .catch((error) => ({ error: String(error) })),
      })),
    );
    const diagnostic = JSON.stringify(
      { cli: loginNew, startup: loginStartup, documents: loginDocuments },
      null,
      2,
    )
      .replaceAll("synthetic-token", "[fixture-token]")
      .replaceAll("synthetic-secret", "[fixture-secret]");
    await testInfo.attach("login-new-startup", {
      body: Buffer.from(diagnostic),
      contentType: "application/json",
    });
    await writeFile(testInfo.outputPath("login-new-startup.json"), diagnostic);
    const loginTimer = await loginWorker.evaluate(() => {
      const timer = (
        globalThis as unknown as {
          b1LoginTimer: {
            original: typeof setTimeout;
            held: Array<{ callback: () => void; deadline: number }>;
          };
        }
      ).b1LoginTimer;
      globalThis.setTimeout = timer.original;
      const now = Date.now;
      try {
        for (const entry of timer.held) {
          Date.now = () => entry.deadline + 124;
          entry.callback();
        }
      } finally {
        Date.now = now;
        Reflect.deleteProperty(globalThis, "b1LoginTimer");
      }
      return { heldFallbacks: timer.held.length };
    });
    await testInfo.attach("login-identity-before-held-fallback", {
      body: Buffer.from(JSON.stringify(loginTimer)),
      contentType: "application/json",
    });
    await writeFile(
      testInfo.outputPath("login-identity-before-held-fallback.json"),
      JSON.stringify(loginTimer),
    );
    expect(loginTimer.heldFallbacks).toBe(1);
    expect(loginNew.code).not.toBe(0);
    expect(cliErrorCode(loginNew.stderr), diagnostic).toBe("not_logged_in");
    expect(loginNew.stderr).not.toContain("synthetic-secret");
    const loginEditor = await newEditorPage(context, pagesBeforeLoginNew);
    await loginEditor.waitForLoadState("domcontentloaded");
    const loginNewAgain = await cli(temp, socketPath, "article", "new");
    expect(loginNewAgain.code).not.toBe(0);
    expect(cliErrorCode(loginNewAgain.stderr)).toBe("target_ambiguous");
    expect(
      mpRequests.filter((request) => new URL(request).pathname === "/cgi-bin/jsapi.js").length,
    ).toBe(jsapiRequestsBeforeTimeout);

    // Already connected: the real CLI must reload via IPC→WS→background, with no launcher.
    const unexpectedPages: Page[] = [];
    const onReloadPage = (page: Page) => unexpectedPages.push(page);
    const beforeTabs = await context.serviceWorkers()[0]!.evaluate(async () =>
      (await chrome.tabs.query({}))
        .filter((tab) => !tab.url?.startsWith("chrome-extension://"))
        .map((tab) => tab.id)
        .sort(),
    );
    context.on("page", onReloadPage);
    const reloadResult = await cli(
      temp,
      socketPath,
      "connect",
      "--reload",
      "--extension",
      extensionId,
    );
    context.off("page", onReloadPage);
    expect(reloadResult.code, `${reloadResult.stdout}\n${reloadResult.stderr}`).toBe(0);
    expect(JSON.parse(reloadResult.stdout)).toEqual({ connected: true });
    expect(unexpectedPages).toHaveLength(0);
    expect(JSON.parse((await cli(temp, socketPath, "status")).stdout)).toEqual({ connected: true });
    expect(
      await context.serviceWorkers()[0]!.evaluate(async () => ({
        tabs: (await chrome.tabs.query({}))
          .filter((tab) => !tab.url?.startsWith("chrome-extension://"))
          .map((tab) => tab.id)
          .sort(),
        intent: (await chrome.storage.local.get("reconnectAfterReloadUntil"))
          .reconnectAfterReloadUntil,
      })),
    ).toEqual({ tabs: beforeTabs, intent: undefined });
  } finally {
    releaseEditorImage();
    handshakeTerminal = true;
    for (const socket of handshakeClients) socket.destroy();
    for (const socket of handshakeUpstreams) socket.destroy();
    handshakeClients.clear();
    handshakeUpstreams.clear();
    const directProxyClosed = directProxy?.close();
    releaseHandshake();
    if (handshakeProxy?.listening)
      await new Promise<void>((resolve) => handshakeProxy!.close(() => resolve()));
    await directProxyClosed;
    await context?.close();
    if (broker?.pid && broker.exitCode === null) {
      const exited = new Promise<void>((resolve) => broker!.once("close", () => resolve()));
      broker.kill("SIGTERM");
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      if (!graceful) {
        broker.kill("SIGKILL");
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
      }
    }
    if (fixtureServer?.listening) {
      await new Promise<void>((resolve) => fixtureServer!.close(() => resolve()));
    }
    await rm(temp, { recursive: true, force: true });
  }
});

async function reservePort(): Promise<number> {
  const server = await import("node:net").then(({ createServer }) => createServer());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a WebSocket port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

type DirectStatusProxy = {
  port: number;
  readonly attempt: DirectProxyAttempt;
  resetAttempt(): void;
  waitForFailedAttempt(): Promise<DirectProxyAttempt>;
  close(): Promise<void>;
};

type DirectProxyAttempt = {
  clientCount: number;
  upstreamConnectionCount: number;
  forwardedRequestBytes: number;
  upstreamEndCount: number;
  upstreamCloseCount: number;
};

async function startDirectStatusProxy(destinationPort: number): Promise<DirectStatusProxy> {
  const server = createTcpServer();
  const clients = new Set<import("node:net").Socket>();
  const upstreams = new Set<import("node:net").Socket>();
  let terminal = false;
  let attempt: DirectProxyAttempt = emptyDirectProxyAttempt();
  let closeAttempt: (() => void) | undefined;
  let rejectAttempt: ((error: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  server.on("connection", (client) => {
    if (terminal) {
      client.destroy();
      return;
    }
    clients.add(client);
    attempt.clientCount++;
    const upstream = connectTcp(destinationPort, "127.0.0.1");
    upstreams.add(upstream);
    upstream.on("connect", () => attempt.upstreamConnectionCount++);
    const requestObserver = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        attempt.forwardedRequestBytes += chunk.length;
        callback(null, chunk);
      },
    });
    const disposePair = () => {
      clients.delete(client);
      upstreams.delete(upstream);
      if (!client.destroyed) client.destroy();
      if (!upstream.destroyed) upstream.destroy();
      requestObserver.destroy();
    };
    client.on("error", disposePair);
    upstream.on("error", disposePair);
    client.on("close", disposePair);
    upstream.on("close", () => {
      attempt.upstreamCloseCount++;
      closeAttempt?.();
      disposePair();
    });
    upstream.on("end", () => attempt.upstreamEndCount++);
    upstream.once("connect", () => {
      if (terminal || client.destroyed) return;
      client.pipe(requestObserver).pipe(upstream);
      upstream.pipe(client);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Direct proxy did not bind");
  return {
    port: address.port,
    get attempt() {
      return { ...attempt };
    },
    resetAttempt() {
      if (terminal) throw new Error("Direct proxy is closed");
      attempt = emptyDirectProxyAttempt();
    },
    async waitForFailedAttempt() {
      if (terminal) throw new Error("Direct proxy is closed");
      if (timer) throw new Error("A direct proxy attempt observer is already active");
      const closed = new Promise<DirectProxyAttempt>((resolve, reject) => {
        closeAttempt = () => resolve({ ...attempt });
        rejectAttempt = reject;
        timer = setTimeout(
          () => reject(new Error("Timed out awaiting broker-facing socket closure")),
          5_000,
        );
      });
      try {
        return await closed;
      } finally {
        if (timer) clearTimeout(timer);
        timer = undefined;
        closeAttempt = undefined;
        rejectAttempt = undefined;
      }
    },
    async close() {
      if (terminal) return;
      terminal = true;
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of clients) socket.destroy();
      for (const socket of upstreams) socket.destroy();
      clients.clear();
      upstreams.clear();
      if (timer) clearTimeout(timer);
      rejectAttempt?.(new Error("Direct proxy closed"));
      closeAttempt = undefined;
      rejectAttempt = undefined;
      timer = undefined;
      await serverClosed;
    },
  };
}

function emptyDirectProxyAttempt(): DirectProxyAttempt {
  return {
    clientCount: 0,
    upstreamConnectionCount: 0,
    forwardedRequestBytes: 0,
    upstreamEndCount: 0,
    upstreamCloseCount: 0,
  };
}

async function waitForSocket(
  socketPath: string,
  process: ChildProcess,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.exitCode != null)
      throw new Error(`Broker exited before IPC ready: ${process.exitCode}\n${stderr()}`);
    try {
      await import("node:fs/promises").then(({ access }) => access(socketPath));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Broker IPC socket did not become ready within 10s\n${stderr()}`);
}

async function cli(temp: string, socketPath: string, ...args: string[]) {
  return runCli(temp, socketPath, args);
}

function cliErrorCode(stderr: string): string {
  return JSON.parse(stderr.trim().split("\n").at(-1)!).error.code;
}

async function runCli(temp: string, socketPath: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bun", ["run", "packages/cli/src/main.ts", ...args], {
      cwd: root,
      env: {
        ...process.env,
        MPCTL_BROKER_SOCKET: socketPath,
        MPCTL_BROKER_CONFIG: path.join(temp, "broker.json"),
        MPCTL_PAIRING_CREDENTIAL: credential,
        XDG_RUNTIME_DIR: temp,
        WSL_DISTRO_NAME: "",
        MPCTL_BROWSER_PROFILE: "",
        MPCTL_BROWSER_EXECUTABLE: path.join(temp, "unexpected-browser-launch"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (cleanupTimeout) clearTimeout(cleanupTimeout);
      action();
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      const timedOut = new Error(
        `CLI timed out after ${cliTimeoutMs / 1_000}s: ${args.join(" ")}\n${stderr}`,
      );
      cleanupTimeout = setTimeout(() => finish(() => reject(timedOut)), 2_000);
    }, cliTimeoutMs);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      if (cleanupTimeout)
        return finish(() =>
          reject(
            new Error(`CLI timed out after ${cliTimeoutMs / 1_000}s: ${args.join(" ")}\n${stderr}`),
          ),
        );
      finish(() => resolve({ code, stdout, stderr }));
    });
  });
}

async function extensionIdFromContext(context: BrowserContext): Promise<string> {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 5_000 }));
  return new URL(worker.url()).host;
}

function createPngFixture(size: number, width = 256, height = Math.ceil(size / width)): Uint8Array {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const pixel = row + 1 + x * 4;
      raw[pixel] = (x * 17 + y) & 0xff;
      raw[pixel + 1] = (y * 23 + x) & 0xff;
      raw[pixel + 2] = (x ^ y) & 0xff;
      raw[pixel + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function pngCrc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function newEditorPage(context: BrowserContext, previousPages: Set<Page>): Promise<Page> {
  let created: Page | undefined;
  await expect
    .poll(() => {
      created = context.pages().find((candidate) => {
        if (previousPages.has(candidate)) return false;
        return candidate.url().startsWith("https://mp.weixin.qq.com/cgi-bin/appmsg");
      });
      return created;
    })
    .toBeTruthy();
  return created!;
}

async function savedEditorPage(
  context: BrowserContext,
  previousPages: Set<Page>,
  groupId: string,
): Promise<Page> {
  let created: Page | undefined;
  await expect
    .poll(async () => {
      created = context.pages().find((candidate) => {
        if (previousPages.has(candidate)) return false;
        const url = new URL(candidate.url());
        return url.pathname === "/cgi-bin/appmsg" && url.searchParams.get("appmsgid") === groupId;
      });
      return created
        ? created.evaluate(() => {
            const url = new URL(location.href);
            return (
              document.documentElement.dataset.mpctlFixtureGroup ??
              url.searchParams.get("appmsgid") ??
              undefined
            );
          })
        : undefined;
    })
    .toBe(groupId);
  return created!;
}

function installSettingsReadGate(options: { rejectNativeRead?: boolean } = {}) {
  const storage = chrome.storage.local;
  const nativeGet = storage.get.bind(storage);
  const nativeReadFailure = new Error("synthetic-native-storage-read-failure");
  const nativeRead = (keys: string | string[] | Record<string, unknown> | null) =>
    options.rejectNativeRead ? Promise.reject(nativeReadFailure) : nativeGet(keys as never);
  let releaseRead: (() => void) | undefined;
  let acknowledgePrepared: (() => void) | undefined;
  const prepared = new Promise<void>((resolve) => (acknowledgePrepared = resolve));
  let acknowledgeDelivery: (() => void) | undefined;
  const delivered = new Promise<void>((resolve) => (acknowledgeDelivery = resolve));
  let readFailure: unknown;
  const state = {
    intercepted: 0,
    release: async () => {
      await prepared;
      if (readFailure !== undefined) throw readFailure;
      if (!releaseRead) throw new Error("Settings read was not prepared");
      releaseRead();
      await delivered;
    },
  };
  storage.get = ((keys: string | string[] | Record<string, unknown> | null) => {
    if (
      Array.isArray(keys) &&
      keys.length === 2 &&
      keys.includes("websocketUrl") &&
      keys.includes("pairingCredential")
    ) {
      state.intercepted++;
      return new Promise((resolve, reject) => {
        void nativeRead(keys).then(
          (values) => {
            releaseRead = () => {
              resolve(values as never);
              acknowledgeDelivery?.();
            };
            acknowledgePrepared?.();
          },
          (error) => {
            readFailure = error;
            reject(error);
            acknowledgePrepared?.();
          },
        );
      }) as unknown as ReturnType<typeof storage.get>;
    }
    return nativeGet(keys as never);
  }) as typeof storage.get;
  Object.defineProperty(globalThis, "__mpctlSettingsGate", { value: state });
}

type FixtureWindow = Window & {
  __MP_Editor_JSAPI__?: unknown;
  __mpctlFixtureCalls?: string[];
  __mpctlFixtureResults?: Array<{ apiName: string; content: string }>;
  __coverLauncher?: Element;
  __coverLauncherParent?: Element;
  __primaryCover?: Element;
  __primaryCoverWrapper?: Element;
  __coverMenuTestMode?:
    | "wrong-label"
    | "duplicate"
    | "hidden"
    | "delayed"
    | "replace-primary"
    | "guard-loss"
    | "visible-item-hidden-ancestor";
  __coverOriginalPrimary?: HTMLElement;
  __mpctlFixtureAssets?: {
    coverConfirms?: number;
    coverTrace?: string[];
    coverHoverEvents?: { primaryPreview: number; primaryWrapper: number; square: number };
    changes: unknown[];
    cardCount: number;
    nativeSaveCount?: number;
  };
};

type PopupConnectFault = {
  installed: boolean;
  intercepted: number;
  restored: boolean;
  arm: () => void;
};
import { nativeHomeHtml, nativeHandlerFixtureScript } from "../native-handler-fixture";
