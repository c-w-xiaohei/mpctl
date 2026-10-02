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

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const extension = path.join(root, "packages/extension/.output/chrome-mv3");
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

test("real CLI, broker, extension and page bridge pull/push UTF-8 HTML on exact ephemeral article refs", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mpctl-browser-"));
  const socketPath = path.join(temp, "broker.sock");
  const bodyFile = path.join(temp, "unicode body.html");
  const wsPort = await reservePort();
  const httpsPort = await reservePort();
  const wsUrl = `ws://127.0.0.1:${wsPort}/bridge`;
  const allowedWebSocketPorts = new Set([String(wsPort)]);
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
      const url = new URL(request.url ?? "/", "https://mp.weixin.qq.com");
      mpRequests.push(url.href);
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
        response.end(
          await readFile(
            path.join(fixtureRoot, loginTimeoutMode ? "login-timeout.html" : "index.html"),
          ),
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
        response.end(await readFile(path.join(fixtureRoot, "home.html")));
        return;
      }
      if (url.pathname === "/cgi-bin/jsapi.js") {
        mpResponses.push({ path: url.pathname, status: 200 });
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end(await readFile(path.join(fixtureRoot, "jsapi.js")));
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
      `--host-resolver-rules=MAP mp.weixin.qq.com:443 127.0.0.1:${httpsPort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
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
      if (
        url.protocol === "ws:" &&
        url.hostname === "127.0.0.1" &&
        allowedWebSocketPorts.has(url.port)
      )
        return route.continue();
      if (url.protocol === "https:" && url.hostname === "mp.weixin.qq.com") return route.continue();
      return route.abort("blockedbyclient");
    });
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
    expect(mountFault?.intercepted).toBe(1);
    expect(mountFault?.restored).toBe(true);
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
    const nativeResult = JSON.parse(completedNative.stdout) as {
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
    const firstArticle = (JSON.parse(first.stdout) as { article: string }).article;
    const current = await cli(temp, socketPath, "article", "current");
    expect(current.code, current.stderr).toBe(0);
    expect(JSON.parse(current.stdout).bodyHash).toBe(JSON.parse(first.stdout).bodyHash);
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
      "timestamp",
    ]);
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
    expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(0);
    const secondArticle = (JSON.parse(second.stdout) as { article: string }).article;
    const ambiguousCurrent = await cli(temp, socketPath, "article", "current");
    expect(ambiguousCurrent.code).not.toBe(0);
    expect(JSON.parse(ambiguousCurrent.stderr).error.code).toBe("target_ambiguous");
    expect(secondArticle).not.toBe(firstArticle);
    const secondTab = await newEditorPage(context, pagesBeforeSecondArticle);
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
          JSON.parse(first.stdout).bodyHash,
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
    expect(await readFile(path.join(temp, "second.html"), "utf8")).toBe("");

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
    expect(await readFile(guardedPullPath, "utf8")).toBe("");

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
    expect(JSON.parse(stalePush.stderr).error.code).toBe("content_conflict");
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
    const pagesBeforeValidSavedOpen = new Set(context.pages());
    const validOpen = await cli(temp, socketPath, "article", "open", listed[0]!.candidate);
    expect(validOpen.code, `${validOpen.stdout}\n${validOpen.stderr}`).toBe(0);
    expect(validOpen.stdout).not.toContain("synthetic-token");
    expect(validOpen.stderr).not.toContain("synthetic-token");
    expect(validOpen.stdout).not.toContain("synthetic-reprint-confirm");
    expect(validOpen.stderr).not.toContain("synthetic-reprint-confirm");
    const savedTab = await newEditorPage(context, pagesBeforeValidSavedOpen);
    const savedRoute = new URL(savedTab.url());
    expect(savedRoute.searchParams.get("timestamp")).toBe("native-async-context");
    expect(savedRoute.searchParams.get("lang")).toBe("synthetic-saved-language");
    expect(savedRoute.searchParams.get("replaceScene")).toBe("synthetic-scene");
    expect(savedRoute.searchParams.get("isSend")).toBe("synthetic-send");
    expect(savedRoute.searchParams.get("isFreePublish")).toBe("synthetic-free-publish");
    expect(savedRoute.searchParams.get("reprint_confirm")).toBe("synthetic-reprint-confirm");
    expect(savedRoute.searchParams.get("token")).toBe("synthetic-token");
    expect(await savedTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureCalls)).toContain(
      "get_content",
    );
    expect(await savedTab.evaluate(() => (window as FixtureWindow).__mpctlFixtureResults)).toEqual(
      [],
    );
    await savedTab.evaluate(() => {
      document.querySelector('[data-msgindex="1"]')?.remove();
    });
    const savedArticle = (JSON.parse(validOpen.stdout) as { article: string }).article;
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
    expect(JSON.parse(invalidatedList.stderr).error.code).toBe("target_unavailable");
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
      JSON.parse(savedPush.stdout).bodyHash,
    );
    expect(ambiguousPush.code).not.toBe(0);
    expect(JSON.parse(ambiguousPush.stderr).error.code).toBe("target_unavailable");
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
      JSON.parse(savedPush.stdout).bodyHash,
    );
    expect(nonCurrentPush.code).not.toBe(0);
    expect(JSON.parse(nonCurrentPush.stderr).error.code).toBe("target_unavailable");
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
    const reloaded = await cli(temp, socketPath, "article", "new");
    expect(reloaded.code, `${reloaded.stdout}\n${reloaded.stderr}`).toBe(0);
    const reloadedArticle = (JSON.parse(reloaded.stdout) as { article: string }).article;
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
    expect(
      mpRequests.every(
        (request) =>
          new URL(request).pathname === "/" ||
          new URL(request).pathname === "/cgi-bin/home" ||
          new URL(request).pathname === "/cgi-bin/appmsg" ||
          new URL(request).pathname === "/cgi-bin/jsapi.js",
      ),
    ).toBe(true);
    expect(
      mpResponses.filter((entry) => entry.path === "/cgi-bin/appmsg").length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      mpResponses.filter((entry) => entry.path === "/cgi-bin/jsapi.js").length,
    ).toBeGreaterThanOrEqual(3);
    expect(mpResponses.every((entry) => entry.status === 200)).toBe(true);

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
    const loginNew = await cli(temp, socketPath, "article", "new");
    expect(loginNew.code).not.toBe(0);
    expect(cliErrorCode(loginNew.stderr)).toBe("not_logged_in");
    expect(loginNew.stderr).not.toContain("synthetic-secret");
    const loginEditor = await newEditorPage(context, pagesBeforeLoginNew);
    await loginEditor.waitForLoadState("domcontentloaded");
    const loginNewAgain = await cli(temp, socketPath, "article", "new");
    expect(loginNewAgain.code).not.toBe(0);
    expect(cliErrorCode(loginNewAgain.stderr)).toBe("not_logged_in");
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

async function newEditorPage(context: BrowserContext, previousPages: Set<Page>): Promise<Page> {
  let created: Page | undefined;
  await expect
    .poll(() => {
      created = context
        .pages()
        .find(
          (candidate) =>
            !previousPages.has(candidate) &&
            candidate.url().startsWith("https://mp.weixin.qq.com/cgi-bin/appmsg"),
        );
      return created;
    })
    .toBeTruthy();
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
};

type PopupConnectFault = {
  installed: boolean;
  intercepted: number;
  restored: boolean;
  arm: () => void;
};
