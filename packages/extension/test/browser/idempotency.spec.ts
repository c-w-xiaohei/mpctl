import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const extension = path.join(root, "packages/extension/.output/chrome-mv3");
const fixtures = path.join(root, "packages/extension/test/browser/fixtures/bridge");
const editorUrl =
  "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=synthetic-context&lang=en_US";
for (const boundary of [
  "completed",
  "accepted",
  "issued-before-native",
  "active-main",
  "both-destroyed",
  "refusal-loss",
  "fields-destroyed",
  "fields-invalidated",
  "upload-blank-title",
  "upload-cleanup-fails",
  "upload-worker-stopped",
  "upload-provider-destroyed",
  "upload-invalidated",
  "save-checkpoint-abort",
  "save-uncommitted-worker-stopped",
  "save-confirmed-worker-stopped",
  "save-native-confirmed",
  "save-native-reply-lost",
  "navigation-reply-lost",
  "navigation-create-worker-stopped",
] as const) {
  test(`real MV3 ${boundary}: exact original key and receipt without replay`, async () => {
    test.setTimeout(90_000);
    const temp = await mkdtemp("/tmp/opencode/mpctl-idempotency-");
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no port");
        server.close(() => resolve(address.port));
      });
    });
    const socket = path.join(temp, "broker.sock");
    const env = {
      ...process.env,
      MPCTL_BROKER_SOCKET: socket,
      MPCTL_BROKER_WS_PORT: String(port),
      MPCTL_PAIRING_CREDENTIAL: "idempotency-fixture",
      XDG_RUNTIME_DIR: temp,
      XDG_CONFIG_HOME: temp,
    };
    let context: BrowserContext | undefined;
    let broker: ChildProcess | undefined;
    let navigationServer: HttpsServer | undefined;
    let navigationPort: number | undefined;
    const children = new Set<ChildProcess>();
    const cli = async (...args: string[]) => {
      const child = spawn("bun", ["run", "packages/cli/src/main.ts", ...args], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      child.once("exit", () => children.delete(child));
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (data) => {
        stdout += data;
      });
      child.stderr!.on("data", (data) => {
        stderr += data;
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      return { code, stdout, stderr };
    };
    try {
      if (boundary.startsWith("navigation-")) {
        const cert = path.join(temp, "cert.pem");
        const key = path.join(temp, "key.pem");
        execFileSync(
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
            key,
            "-out",
            cert,
            "-subj",
            "/CN=mp.weixin.qq.com",
          ],
          { stdio: "ignore" },
        );
        navigationServer = createHttpsServer(
          { cert: await readFile(cert), key: await readFile(key) },
          async (request, response) => {
            const url = new URL(request.url ?? "/", "https://mp.weixin.qq.com");
            const file =
              url.pathname === "/cgi-bin/jsapi.js"
                ? "jsapi.js"
                : url.pathname === "/cgi-bin/home"
                  ? "home.html"
                  : "index.html";
            response.writeHead(200, {
              "content-type": file.endsWith(".js") ? "text/javascript" : "text/html",
              "cache-control": "no-store",
            });
            const content = await readFile(path.join(fixtures, file), "utf8");
            response.end(file === "home.html" ? nativeHomeHtml(content) : content);
          },
        );
        navigationPort = await new Promise<number>((resolve) => {
          navigationServer!.listen(0, "127.0.0.1", () => {
            const address = navigationServer!.address();
            if (!address || typeof address === "string")
              throw new Error("fixture server unavailable");
            resolve(address.port);
          });
        });
      }
      broker = spawn("bun", ["run", "packages/broker/src/main.ts"], {
        cwd: root,
        env,
        stdio: "ignore",
      });
      await expect
        .poll(async () => {
          try {
            await readFile(socket);
          } catch (error: any) {
            return error.code !== "ENOENT";
          }
          return true;
        })
        .toBe(true);
      context = await chromium.launchPersistentContext(path.join(temp, "profile"), {
        executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
        headless: true,
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
          "--no-sandbox",
          "--headless=new",
          ...(navigationPort
            ? [
                "--no-proxy-server",
                "--ignore-certificate-errors",
                `--host-resolver-rules=MAP mp.weixin.qq.com 127.0.0.1:${navigationPort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
              ]
            : ["--host-resolver-rules=MAP mp.weixin.qq.com ~NOTFOUND, EXCLUDE 127.0.0.1"]),
        ],
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.protocol === "chrome-extension:") return route.continue();
        if (
          (boundary.startsWith("save-") || boundary.startsWith("navigation-")) &&
          url.hostname === "mp.weixin.qq.com" &&
          url.pathname === "/"
        )
          return route.fulfill({
            status: 302,
            headers: {
              location:
                "https://mp.weixin.qq.com/cgi-bin/home?t=site-redirected-home&lang=synthetic-language&token=synthetic-context",
            },
            body: "",
          });
        if (
          (boundary.startsWith("save-") || boundary.startsWith("navigation-")) &&
          url.hostname === "mp.weixin.qq.com" &&
          url.pathname === "/cgi-bin/home"
        )
          return route.fulfill({
            body: url.search
              ? nativeHomeHtml(await readFile(path.join(fixtures, "home.html"), "utf8"))
              : await readFile(path.join(fixtures, "index.html"), "utf8"),
            contentType: "text/html",
          });
        if (url.hostname === "mp.weixin.qq.com" && url.pathname === "/cgi-bin/appmsg")
          return route.fulfill({
            path: path.join(fixtures, "index.html"),
            contentType: "text/html",
          });
        if (url.hostname === "mp.weixin.qq.com" && url.pathname === "/cgi-bin/jsapi.js") {
          const source = await readFile(path.join(fixtures, "jsapi.js"), "utf8");
          // The next MAIN outbound packet is the held keyed setContent response.
          // The endpoint sends serializer bytes, not an exposed Nexus message object.
          const capture = `(() => { const dispatch = document.dispatchEvent.bind(document); document.dispatchEvent = function(event) { if (event.type.startsWith("mpctl:") && event.type.endsWith(":main") && event.detail?.message && document.documentElement.dataset.t1DropReply === "yes") { delete document.documentElement.dataset.t1DropReply; document.documentElement.dataset.t1ReplyDropped = "yes"; return true; } return dispatch(event); }; })();\n`;
          return route.fulfill({
            body:
              capture +
              source
                .replace(
                  "setTimeout(() => {\n      imageCards.append(card);\n      imageState.cardCount++;\n    }, imageState.cardDelayMs);",
                  'if (document.documentElement.dataset.t3HoldCard === "yes") { window.__t3ReleaseCard = () => { imageCards.append(card); imageState.cardCount++; }; document.documentElement.dataset.t3CardPending = "yes"; } else setTimeout(() => { imageCards.append(card); imageState.cardCount++; }, imageState.cardDelayMs);',
                )
                .replace(
                  'titleMirror.value = title.innerText === "\\n" ? "" : title.innerText;',
                  'if (document.documentElement.dataset.t2HoldMirror === "yes") { window.__t2ReleaseMirror = () => { titleMirror.value = title.innerText; document.documentElement.dataset.t2MirrorReleased = "yes"; }; document.documentElement.dataset.t2TitlePending = "yes"; return; } titleMirror.value = title.innerText === "\\n" ? "" : title.innerText;',
                )
                .replace(
                  'return sucCb({ msg: "ok" });',
                  'if (document.documentElement.dataset.t1Hold === "yes") { window.__t1ReleaseSetter = () => sucCb({ msg: "ok" }); return; } return sucCb({ msg: "ok" });',
                )
                .replace(
                  'if (apiName === "mp_editor_get_content") return sucCb({ content, msg: "" });',
                  'if (apiName === "mp_editor_get_content") { if (document.documentElement.dataset.t1HoldRead === "yes") { window.__t1ReleaseRead = () => sucCb({ content, msg: "" }); return; } return sucCb({ content, msg: "" }); }',
                ),
            contentType: "text/javascript",
          });
        }
        return route.abort();
      });
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
      const extensionId = new URL(worker.url()).host;
      const page = await context.newPage();
      const scenarioUrl = boundary.startsWith("save-")
        ? editorUrl
            .replace("media/appmsg_edit_v2", "media/appmsg_edit")
            .replace("isNew=1", "appmsgid=fixture-group-1")
        : boundary === "completed" || boundary === "refusal-loss"
          ? editorUrl
          : editorUrl
              .replace("media/appmsg_edit_v2", "media/appmsg_edit")
              .replace("isNew=1", "appmsgid=lifecycle-group");
      await page.goto(scenarioUrl);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.mpctlReady))
        .toBe("yes");
      await worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: "https://mp.weixin.qq.com/*" });
        const first = tabs[0]?.id;
        if (first === undefined) throw new Error("fixture editor unavailable");
        const group = await chrome.tabs.group({ tabIds: [first] });
        await chrome.tabGroups.update(group, { title: "mpctl" });
        await chrome.storage.local.set({ managedGroupId: group });
      });
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.getByLabel("Broker WebSocket 地址").fill(`ws://127.0.0.1:${port}/bridge`);
      await popup.getByLabel("配对凭证").fill("idempotency-fixture");
      await popup.getByRole("button", { name: "显式连接" }).click();
      await expect(popup.getByRole("status")).toContainText("已连接");
      const current = await cli("article", "current");
      expect(current.code, current.stdout + current.stderr).toBe(0);
      const article = JSON.parse(current.stdout);
      if (boundary.startsWith("navigation-")) {
        // Hold at an actual Chrome adapter boundary, not a fake second workspace.
        // The created tab exists; BG has not yet received the create result in the kill case.
        const home = await context.newPage();
        await home.goto(
          "https://mp.weixin.qq.com/cgi-bin/home?t=home&lang=en_US&token=synthetic-context",
        );
        await worker.evaluate(async () => {
          const tabs = await chrome.tabs.query({ url: "https://mp.weixin.qq.com/*" });
          const group = (await chrome.storage.local.get("managedGroupId")).managedGroupId;
          if (typeof group !== "number") throw new Error("group unavailable");
          for (const tab of tabs)
            if (tab.id !== undefined) await chrome.tabs.group({ groupId: group, tabIds: tab.id });
        });
        await page.close();
        const operationId = await popup.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve) => {
            const request = indexedDB.open("mpctl.operations", 1);
            request.onsuccess = () => resolve(request.result);
          });
          const ledger = await new Promise<any>((resolve) => {
            const request = db.transaction("meta").objectStore("meta").get("ledger");
            request.onsuccess = () => resolve(request.result);
          });
          db.close();
          return `op:${ledger.ledgerId}:${crypto.randomUUID()}`;
        });
        await worker.evaluate((boundary) => {
          const originalCreate = chrome.tabs.create.bind(chrome.tabs);
          const originalGroup = chrome.tabs.group.bind(chrome.tabs);
          const state = globalThis as any;
          state.__t5Create = 0;
          state.__t5Group = 0;
          chrome.tabs.create = (async (options: chrome.tabs.CreateProperties) => {
            state.__t5Create++;
            const tab = await originalCreate(options);
            if (boundary === "navigation-create-worker-stopped") {
              state.__t5Reached = true;
              await new Promise<void>((resolve) => {
                state.__t5Release = resolve;
              });
            }
            return tab;
          }) as typeof chrome.tabs.create;
          chrome.tabs.group = (async (options: chrome.tabs.GroupOptions) => {
            state.__t5Group++;
            if (boundary === "navigation-reply-lost") {
              state.__t5Reached = true;
              await new Promise<void>((resolve) => {
                state.__t5Release = resolve;
              });
            }
            return originalGroup(options);
          }) as typeof chrome.tabs.group;
        }, boundary);
        const submit = cli("article", "new", "--operation", operationId);
        await expect.poll(() => worker.evaluate(() => (globalThis as any).__t5Reached)).toBe(true);
        const issued = await popup.evaluate(async (id) => {
          const db = await new Promise<IDBDatabase>((resolve) => {
            const request = indexedDB.open("mpctl.operations", 1);
            request.onsuccess = () => resolve(request.result);
          });
          const record = await new Promise<any>((resolve) => {
            const request = db.transaction("operations").objectStore("operations").get(id);
            request.onsuccess = () => resolve(request.result);
          });
          db.close();
          return record;
        }, operationId);
        expect(issued.snapshot.state).toBe("issued");
        expect(issued.snapshot.effect.pageCreated).toBe(boundary === "navigation-reply-lost");
        expect(
          await worker.evaluate(() => ({
            create: (globalThis as any).__t5Create,
            group: (globalThis as any).__t5Group,
          })),
        ).toEqual({ create: 1, group: boundary === "navigation-reply-lost" ? 1 : 0 });
        for (const child of children) child.kill("SIGKILL");
        await submit;
        if (boundary === "navigation-reply-lost") {
          await worker.evaluate(() => (globalThis as any).__t5Release());
          await expect
            .poll(
              async () =>
                JSON.parse((await cli("operation", "status", operationId)).stdout).snapshot.state,
            )
            .toBe("settled");
          const before = context.pages().length;
          await home.close();
          const replay = await cli("article", "new", "--operation", operationId);
          expect(replay.code, replay.stderr).toBe(0);
          const replaySnapshot = JSON.parse(replay.stdout).snapshot;
          expect(replaySnapshot.result).toEqual({ status: "ok", value: {} });
          expect(replaySnapshot.effect).toMatchObject({
            pageCreated: true,
            targetBound: true,
          });
          expect(context.pages()).toHaveLength(before - 1);
          expect(
            await worker.evaluate(() => ({
              create: (globalThis as any).__t5Create,
              group: (globalThis as any).__t5Group,
            })),
          ).toEqual({ create: 1, group: 1 });
          const located = await cli("article", "current", "--new");
          expect(located.code, located.stderr).toBe(0);
          const inspect = await cli("article", "inspect", JSON.parse(located.stdout).article);
          expect(inspect.code, inspect.stderr).toBe(0);
        } else {
          const session = await context.newCDPSession(home);
          const versions: any[] = [];
          session.on("ServiceWorker.workerVersionUpdated", (event) =>
            versions.push(...event.versions),
          );
          await session.send("ServiceWorker.enable");
          await expect
            .poll(
              () =>
                versions.find(
                  (item) => item.scriptURL === worker.url() && item.runningStatus === "running",
                )?.versionId,
            )
            .toBeTruthy();
          const version = versions.findLast(
            (item) => item.scriptURL === worker.url() && item.runningStatus === "running",
          );
          await popup.close();
          await session.send("ServiceWorker.stopWorker", { versionId: version.versionId });
          expect(
            (await session.send("Target.closeTarget", { targetId: version.targetId })).success,
          ).toBe(true);
          await expect
            .poll(() =>
              versions.some(
                (item) => item.versionId === version.versionId && item.runningStatus === "stopped",
              ),
            )
            .toBe(true);
          const replacement = await context.newPage();
          await replacement.goto(`chrome-extension://${extensionId}/popup.html`);
          await replacement.getByRole("button", { name: "显式连接" }).click();
          await expect(replacement.getByRole("status")).toContainText("已连接");
          const before = context.pages().length;
          const replay = await cli("article", "new", "--operation", operationId);
          expect(replay.code).toBe(1);
          const failure = JSON.parse(replay.stderr.trim().split("\n").at(-1)!).error;
          expect(failure.snapshot).toMatchObject({
            state: "unresolved",
            effect: { pageCreated: false, targetBound: false },
          });
          const owner = await replacement.evaluate(async (id) => {
            const db = await new Promise<IDBDatabase>((resolve) => {
              const request = indexedDB.open("mpctl.operations", 1);
              request.onsuccess = () => resolve(request.result);
            });
            const old = await new Promise<any>((resolve) => {
              const request = db.transaction("operations").objectStore("operations").get(id);
              request.onsuccess = () => resolve(request.result);
            });
            db.close();
            return old.owner;
          }, operationId);
          expect(owner).toBe(issued.owner);
          const newAttempt = await cli("article", "new");
          expect(newAttempt.code).toBe(1);
          const refusedId = JSON.parse(newAttempt.stderr.trim().split("\n").at(-1)!).error.snapshot
            .operationId;
          const newOwner = await replacement.evaluate(async (id) => {
            const db = await new Promise<IDBDatabase>((resolve) => {
              const request = indexedDB.open("mpctl.operations", 1);
              request.onsuccess = () => resolve(request.result);
            });
            const record = await new Promise<any>((resolve) => {
              const request = db.transaction("operations").objectStore("operations").get(id);
              request.onsuccess = () => resolve(request.result);
            });
            db.close();
            return record.owner;
          }, refusedId);
          expect(newOwner).not.toBe(issued.owner);
          expect(context.pages()).toHaveLength(before);
          for (const args of [
            ["article", "list"],
            ["workspace", "cleanup"],
            ["connect", "--reload", "--extension", extensionId],
          ])
            expect((await cli(...args)).code).toBe(1);
          const located = await cli("article", "current", "--new");
          // Created-before-ack tab was never grouped. Pure current cannot repair
          // placement or claim an old navigation's writable target.
          expect(located.code).toBe(1);
          expect(JSON.parse(located.stderr).error.code).toBe("target_unavailable");
          expect(context.pages()).toHaveLength(before);
          await session.detach();
        }
        return;
      }
      const file = path.join(temp, "body.html");
      if (boundary.startsWith("save-")) {
        const draftList = await context.newPage();
        await draftList.goto(
          "https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card&token=synthetic-context&lang=en_US",
        );
        await expect
          .poll(() => draftList.evaluate(() => document.documentElement.dataset.mpctlReady))
          .toBe("yes");
        await worker.evaluate(async () => {
          const tabs = await chrome.tabs.query({ url: "https://mp.weixin.qq.com/*" });
          const list = tabs.find((tab) => tab.url?.includes("action=list_card"));
          const settings = await chrome.storage.local.get("managedGroupId");
          await chrome.tabs.group({
            groupId: settings.managedGroupId as number,
            tabIds: [list!.id!],
          });
        });
        const listBefore = await cli("article", "list");
        expect(listBefore.code, listBefore.stderr).toBe(0);
        const state = await cli("article", "inspect", article.article, "--all");
        expect(state.code, state.stderr).toBe(0);
        const stateFile = path.join(temp, "state.json");
        await writeFile(stateFile, state.stdout);
        const ledgerId = await popup.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve) => {
            const request = indexedDB.open("mpctl.operations");
            request.onsuccess = () => resolve(request.result);
          });
          const meta = await new Promise<any>((resolve) => {
            const request = db.transaction("meta").objectStore("meta").get("ledger");
            request.onsuccess = () => resolve(request.result);
          });
          db.close();
          return meta.ledgerId as string;
        });
        const id = `op:${ledgerId}:${crypto.randomUUID()}`;
        const args = ["article", "save", article.article, "--expect", stateFile, "--operation", id];
        const readRow = () =>
          popup.evaluate(async (id) => {
            const db = await new Promise<IDBDatabase>((resolve) => {
              const r = indexedDB.open("mpctl.operations");
              r.onsuccess = () => resolve(r.result);
            });
            const row = await new Promise<any>((resolve) => {
              const r = db.transaction("operations").objectStore("operations").get(id);
              r.onsuccess = () => resolve(r.result);
            });
            db.close();
            return row;
          }, id);
        const nativeCounts = () =>
          page.evaluate(() =>
            Number(localStorage.getItem("mpctl-fixture-total-native-saves") ?? "0"),
          );
        const originalDocument = await page.evaluate(
          () => document.documentElement.dataset.mpctlFixtureDocumentId,
        );
        await worker.evaluate(async () => {
          await chrome.storage.local.set({ t4SaveReloads: 0, t4ListReloads: 0 });
          const original = chrome.tabs.reload.bind(chrome.tabs);
          chrome.tabs.reload = (async (...args: Parameters<typeof original>) => {
            const tab = await chrome.tabs.get(args[0]!);
            const key = tab.url?.includes("action=list_card") ? "t4ListReloads" : "t4SaveReloads";
            const counts = await chrome.storage.local.get(key);
            await chrome.storage.local.set({ [key]: Number(counts[key] ?? 0) + 1 });
            return original(...args);
          }) as typeof chrome.tabs.reload;
        });
        const navigationCounts = (host = popup) =>
          host.evaluate(async () => {
            const counts = await chrome.storage.local.get(["t4SaveReloads", "t4ListReloads"]);
            return { reload: counts.t4SaveReloads, list: counts.t4ListReloads };
          });
        if (
          boundary === "save-checkpoint-abort" ||
          boundary === "save-confirmed-worker-stopped" ||
          boundary === "save-uncommitted-worker-stopped"
        ) {
          await worker.evaluate((mode) => {
            const original = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (value: any, ...rest: any[]) {
              const request = original.call(this, value, ...rest);
              if (
                value.snapshot?.operation === "save" &&
                value.snapshot?.state === "settled" &&
                value.snapshot?.effect?.outcome === "confirmed" &&
                !(globalThis as any).__t4CheckpointHit
              ) {
                (globalThis as any).__t4CheckpointHit = true;
                if (mode === "save-checkpoint-abort" || mode === "save-uncommitted-worker-stopped")
                  request.addEventListener("success", () => {
                    request.transaction!.abort();
                    (globalThis as any).__t4CheckpointAborted = true;
                  });
                else {
                  const tx = request.transaction!;
                  // Hold delivery only after real transaction complete. The worker is then genuinely stopped.
                  tx.oncomplete = () => {
                    (globalThis as any).__t4ConfirmedCommitted = true;
                  };
                }
              }
              return request;
            };
          }, boundary);
        }

        if (boundary === "save-native-reply-lost") {
          await worker.evaluate(() => {
            const original = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (value: any, ...args: any[]) {
              if (
                value.snapshot?.operation === "save" &&
                value.snapshot?.state === "settled" &&
                value.snapshot?.effect?.outcome === "confirmed"
              ) {
                const tx = this.transaction;
                const complete = tx.oncomplete;
                tx.oncomplete = () => {
                  (globalThis as any).__t4VerifiedCommitted = true;
                  (globalThis as any).__t4ReleaseVerified = () =>
                    complete?.call(tx, new Event("complete"));
                };
              }
              return original.call(this, value, ...args);
            };
          });
        }
        const submitted = cli(...args);
        await expect.poll(nativeCounts).toBe(1);
        if (boundary === "save-native-confirmed" || boundary === "save-native-reply-lost") {
          let reply: any;
          if (boundary === "save-native-reply-lost") {
            await expect
              .poll(() => worker.evaluate(() => (globalThis as any).__t4VerifiedCommitted))
              .toBe(true);
            expect(children.size).toBe(1);
            for (const child of children) child.kill("SIGKILL");
            expect((await submitted).code).not.toBe(0);
            await worker.evaluate(() => (globalThis as any).__t4ReleaseVerified());
            reply = JSON.parse((await cli("operation", "status", id)).stdout);
          } else {
            const response = await submitted;
            expect(response.code, response.stderr).toBe(0);
            reply = JSON.parse(response.stdout);
          }
          expect(reply.snapshot).toMatchObject({
            operationId: id,
            state: "settled",
            effect: { outcome: "confirmed", persistence: "unverified" },
          });
          expect(reply.snapshot.result.value).toEqual({});
          expect(
            await page.evaluate(() => document.documentElement.dataset.mpctlFixtureDocumentId),
          ).toBe(originalDocument);
          const callsBefore = await page.evaluate(() => (window as any).__mpctlFixtureCalls.length);
          expect((await cli(...args)).code).toBe(0);
          expect(JSON.parse((await cli("operation", "status", id)).stdout).snapshot).toEqual(
            reply.snapshot,
          );
          expect(await nativeCounts()).toBe(1);
          expect(await navigationCounts()).toEqual({ reload: 0, list: 0 });
          expect(await page.evaluate(() => (window as any).__mpctlFixtureCalls.length)).toBe(
            callsBefore,
          );
          return;
        }
        if (boundary === "save-checkpoint-abort") {
          await expect
            .poll(() => worker.evaluate(() => (globalThis as any).__t4CheckpointAborted))
            .toBe(true);
          const response = await submitted;
          expect(response.code).toBe(1);
          const error = JSON.parse(response.stderr.trim().split("\n").at(-1)!).error;
          expect(error.issue).toMatchObject({
            failure: { code: "storage_failed" },
            uncommitted: { effect: { outcome: "confirmed", persistence: "unverified" } },
          });
          expect(
            await page.evaluate(() => document.documentElement.dataset.mpctlFixtureDocumentId),
          ).toBe(originalDocument);
          expect((await readRow()).snapshot.effect.persistence).toBe("unverified");
          await cli(...args);
          expect(await nativeCounts()).toBe(1);
          expect(await navigationCounts()).toEqual({ reload: 0, list: 0 });
          return;
        }

        await expect
          .poll(() =>
            worker.evaluate(
              (boundary) =>
                boundary === "save-uncommitted-worker-stopped"
                  ? (globalThis as any).__t4CheckpointAborted
                  : boundary === "save-confirmed-worker-stopped"
                    ? (globalThis as any).__t4ConfirmedCommitted
                    : false,
              boundary,
            ),
          )
          .toBe(true);
        const beforeStop = await readRow();
        expect(beforeStop.snapshot.effect).toEqual({
          outcome: boundary === "save-uncommitted-worker-stopped" ? "not_dispatched" : "confirmed",
          persistence: "unverified",
        });
        const session = await context.newCDPSession(page);
        const versions: any[] = [];
        session.on("ServiceWorker.workerVersionUpdated", (event) =>
          versions.push(...event.versions),
        );
        await session.send("ServiceWorker.enable");
        await expect
          .poll(
            () =>
              versions.find((v) => v.scriptURL === worker.url() && v.runningStatus === "running")
                ?.versionId,
          )
          .toBeTruthy();
        const version = versions.findLast(
          (v) => v.scriptURL === worker.url() && v.runningStatus === "running",
        );
        await popup.close();
        const stopping = session.send("ServiceWorker.stopWorker", { versionId: version.versionId });
        expect(
          (await session.send("Target.closeTarget", { targetId: version.targetId })).success,
        ).toBe(true);
        await stopping;
        await expect
          .poll(() =>
            versions.some(
              (v) => v.versionId === version.versionId && v.runningStatus === "stopped",
            ),
          )
          .toBe(true);
        await session.detach();
        const replacementPopup = await context.newPage();
        await replacementPopup.goto(`chrome-extension://${extensionId}/popup.html`);
        await replacementPopup.getByRole("button", { name: "显式连接" }).click();
        await expect(replacementPopup.getByRole("status")).toContainText("已连接");
        await expect(worker.evaluate(() => true)).rejects.toThrow(
          "Execution context was destroyed",
        );
        const query = await cli("operation", "status", id);
        expect(query.code, query.stderr).toBe(0);
        const recovered = JSON.parse(query.stdout).snapshot;
        expect(recovered, query.stdout).toMatchObject({
          effect: { outcome: "confirmed", persistence: "unverified" },
          state: "settled",
        });
        expect((await cli(...args)).code).toBe(
          boundary === "save-confirmed-worker-stopped" ? 0 : 1,
        );
        expect(await nativeCounts()).toBe(1);
        expect(await navigationCounts(replacementPopup)).toEqual({
          reload: 0,
          list: 0,
        });

        if (
          boundary === "save-confirmed-worker-stopped" ||
          boundary === "save-uncommitted-worker-stopped"
        )
          expect(
            await page.evaluate(() => document.documentElement.dataset.mpctlFixtureDocumentId),
          ).toBe(originalDocument);
        // The stopped original CLI is not a resume request.
        void submitted;
        return;
      }
      if (boundary.startsWith("upload-")) {
        const assetFile = path.join(temp, "lifecycle.png");
        const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 42]);
        await writeFile(assetFile, bytes);
        const counts = () =>
          page.evaluate(() => ({
            assign: Number(document.documentElement.dataset.t3Assignments ?? 0),
            change: (window as any).__mpctlFixtureAssets.changes.length,
            open: (window as any).__mpctlFixtureAssets.openCount,
            cancel: (window as any).__mpctlFixtureAssets.cancelCount,
            native: [...(window as any).__mpctlFixtureCalls],
          }));
        await worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: "https://mp.weixin.qq.com/*" });
          await chrome.scripting.executeScript({
            target: { tabId: tab!.id! },
            world: "ISOLATED",
            func: () => {
              const descriptor = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "files",
              )!;
              Object.defineProperty(HTMLInputElement.prototype, "files", {
                ...descriptor,
                set(value) {
                  document.documentElement.dataset.t3Assignments = String(
                    Number(document.documentElement.dataset.t3Assignments ?? 0) + 1,
                  );
                  descriptor.set!.call(this, value);
                },
              });
            },
          });
        });
        await page.evaluate((boundary) => {
          if (boundary === "upload-blank-title")
            document.documentElement.dataset.mpctlUploadMode = "blank-title";
          else if (boundary === "upload-cleanup-fails")
            document.documentElement.dataset.mpctlUploadMode = "cleanup-fails";
          else document.documentElement.dataset.t3HoldCard = "yes";
        }, boundary);
        const submitted = cli("asset", "upload", article.article, "--file", assetFile);
        await expect
          .poll(() => page.evaluate(() => (window as any).__mpctlFixtureAssets.changes.length))
          .toBe(1);
        const readRow = async (host: typeof popup) =>
          host.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve) => {
              const request = indexedDB.open("mpctl.operations");
              request.onsuccess = () => resolve(request.result);
            });
            const result = await new Promise<any>((resolve) => {
              const request = db.transaction("operations").objectStore("operations").getAll();
              request.onsuccess = () =>
                resolve(request.result.find((r: any) => r.snapshot.operation === "upload"));
            });
            db.close();
            return result;
          });
        const original = await readRow(popup);
        const id = original.snapshot.operationId;
        expect(original.snapshot.state).toBe("issued");
        if (boundary === "upload-worker-stopped" || boundary === "upload-provider-destroyed") {
          await expect
            .poll(() => page.evaluate(() => document.documentElement.dataset.t3CardPending))
            .toBe("yes");
          const session = await context.newCDPSession(page);
          const versions: any[] = [];
          session.on("ServiceWorker.workerVersionUpdated", (event) =>
            versions.push(...event.versions),
          );
          await session.send("ServiceWorker.enable");
          await expect
            .poll(
              () =>
                versions.findLast(
                  (v) => v.scriptURL === worker.url() && v.runningStatus === "running",
                )?.versionId,
            )
            .toBeTruthy();
          const version = versions.findLast(
            (v) => v.scriptURL === worker.url() && v.runningStatus === "running",
          );
          await popup.close();
          const stopping = session.send("ServiceWorker.stopWorker", {
            versionId: version.versionId,
          });
          expect(
            (await session.send("Target.closeTarget", { targetId: version.targetId })).success,
          ).toBe(true);
          await stopping;
          await expect
            .poll(() =>
              versions.some(
                (v) => v.versionId === version.versionId && v.runningStatus === "stopped",
              ),
            )
            .toBe(true);
          let before: Awaited<ReturnType<typeof counts>> | undefined;
          if (boundary === "upload-provider-destroyed") await page.close();
          else {
            await page.evaluate(() => (window as any).__t3ReleaseCard());
            await expect(page.locator("#synthetic-image-library")).toBeHidden();
            before = await counts();
          }
          const fresh = await context.newPage();
          await fresh.goto(`chrome-extension://${extensionId}/popup.html`);
          await fresh.getByRole("button", { name: "显式连接" }).click();
          await expect(fresh.getByRole("status")).toContainText("已连接");
          await expect(worker.evaluate(() => true)).rejects.toThrow(
            "Execution context was destroyed",
          );
          const recovered = await readRow(fresh);
          expect(recovered.owner).toBe(original.owner);
          expect(recovered.snapshot.state).toBe("unresolved");
          if (boundary === "upload-worker-stopped") {
            const freshCurrent = await cli("article", "current");
            expect(freshCurrent.code, freshCurrent.stderr).toBe(0);
            const listedBeforeReceipt = await cli(
              "asset",
              "list",
              JSON.parse(freshCurrent.stdout).article,
            );
            expect(JSON.parse(listedBeforeReceipt.stderr).error).toMatchObject({
              code: "operation_blocked",
              blockingOperationId: id,
            });
            before = await counts();
          }
          const status = await cli("operation", "status", id);
          expect(status.code).toBe(0);
          expect(JSON.parse(status.stdout).snapshot).toMatchObject({
            state: boundary === "upload-worker-stopped" ? "settled" : "unresolved",
            effect: {
              outcome: boundary === "upload-worker-stopped" ? "confirmed" : "not_dispatched",
            },
          });
          const repeated = await cli(
            "asset",
            "upload",
            article.article,
            "--file",
            assetFile,
            "--operation",
            id,
          );
          expect(repeated.code).toBe(boundary === "upload-worker-stopped" ? 0 : 1);
          if (before) expect(await counts()).toEqual(before);
          expect((await submitted).code).not.toBe(0);
          if (!page.isClosed()) await session.detach();
          return;
        }
        if (boundary === "upload-invalidated") {
          await expect
            .poll(() => page.evaluate(() => document.documentElement.dataset.t3CardPending))
            .toBe("yes");
          await worker.evaluate(async () => {
            const [tab] = await chrome.tabs.query({ url: "https://mp.weixin.qq.com/*" });
            await chrome.scripting.executeScript({
              target: { tabId: tab!.id! },
              world: "ISOLATED",
              func: () => {
                const abort = AbortController.prototype.abort;
                AbortController.prototype.abort = function (reason) {
                  abort.call(this, reason);
                  if (reason === "Content script context invalidated")
                    document.documentElement.dataset.t3CtxAborted = "yes";
                };
                document.dispatchEvent(
                  new CustomEvent(`${chrome.runtime.id}:mp:wxt:content-script-started`, {
                    detail: { contentScriptName: "mp", messageId: "upload-newer-script" },
                  }),
                );
              },
            });
          });
          await expect
            .poll(() => page.evaluate(() => document.documentElement.dataset.t3CtxAborted))
            .toBe("yes");
        }
        const failure = await submitted;
        expect(failure.code).toBe(1);
        const error = JSON.parse(failure.stderr.trim().split("\n").at(-1)!).error;
        expect(error.snapshot).toMatchObject({
          operation: "upload",
          state: "unresolved",
          effect: { outcome: boundary === "upload-cleanup-fails" ? "confirmed" : "unknown" },
        });
        expect(error.snapshot.result.error.cause).toMatchObject({
          at:
            boundary === "upload-cleanup-fails"
              ? "content.library_cleanup"
              : "content.upload_confirm",
          code:
            boundary === "upload-cleanup-fails"
              ? "cancel_timeout"
              : boundary === "upload-invalidated"
                ? "target_unavailable"
                : "card_title_empty",
        });
        if (boundary === "upload-blank-title")
          expect(error.snapshot.result.error.confirmationTimedOut).toBe(true);
        const before = await counts();
        expect({ assign: before.assign, change: before.change, open: before.open }).toEqual({
          assign: 1,
          change: 1,
          open: 1,
        });
        const repeated = await cli(
          "asset",
          "upload",
          article.article,
          "--file",
          assetFile,
          "--operation",
          id,
        );
        expect(JSON.parse(repeated.stderr.trim().split("\n").at(-1)!).error.snapshot).toEqual(
          error.snapshot,
        );
        const status = await cli("operation", "status", id);
        expect(status.code).toBe(0);
        expect(JSON.parse(status.stdout).snapshot).toEqual(error.snapshot);
        const listed = await cli("asset", "list", article.article);
        expect(JSON.parse(listed.stderr).error).toMatchObject({
          code: "operation_blocked",
          blockingOperationId: id,
        });
        const maintained = await cli("workspace", "cleanup");
        expect(maintained.code).toBe(1);
        expect(await counts()).toEqual(before);
        const changed = Uint8Array.from(bytes);
        changed[8] = 43;
        await writeFile(assetFile, changed);
        const conflict = await cli(
          "asset",
          "upload",
          article.article,
          "--file",
          assetFile,
          "--operation",
          id,
        );
        expect(JSON.parse(conflict.stderr.trim().split("\n").at(-1)!).error.code).toBe(
          "operation_conflict",
        );
        expect(await counts()).toEqual(before);
        return;
      }
      if (boundary === "fields-invalidated") {
        const initial = JSON.parse((await cli("article", "inspect", article.article)).stdout);
        await worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: "https://mp.weixin.qq.com/*" });
          if (!tab?.id) throw new Error("original fields tab missing");
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "ISOLATED",
            func: () => {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
              Object.defineProperty(HTMLInputElement.prototype, "value", {
                ...setter,
                set(value) {
                  if (this.id === "author")
                    document.documentElement.dataset.t2AuthorSets = String(
                      Number(document.documentElement.dataset.t2AuthorSets ?? 0) + 1,
                    );
                  setter.set!.call(this, value);
                },
              });
              const summary = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                "value",
              )!;
              Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
                ...summary,
                set(value) {
                  if (this.id === "js_description")
                    document.documentElement.dataset.t2SummarySets = String(
                      Number(document.documentElement.dataset.t2SummarySets ?? 0) + 1,
                    );
                  summary.set!.call(this, value);
                },
              });
              const abort = AbortController.prototype.abort;
              AbortController.prototype.abort = function (reason) {
                abort.call(this, reason);
                if (reason === "Content script context invalidated")
                  document.documentElement.dataset.t2CtxAborted = "yes";
              };
            },
          });
        });
        await page.evaluate(() => {
          document.documentElement.dataset.t2HoldMirror = "yes";
          const counts = { title: 0, author: 0, summary: 0 };
          (window as any).__t2FieldCounts = counts;
          document
            .querySelector('[data-placeholder="请在这里输入标题"]')!
            .addEventListener("input", () => counts.title++);
          document.querySelector("#author")!.addEventListener("input", () => counts.author++);
          document
            .querySelector("#js_description")!
            .addEventListener("input", () => counts.summary++);
        });
        const fieldsFile = path.join(temp, "fields.json");
        await writeFile(
          fieldsFile,
          JSON.stringify({ title: "Held title", author: "Never", summary: "Never" }),
        );
        const original = cli(
          "article",
          "update",
          article.article,
          "--fields",
          fieldsFile,
          "--expected-hash",
          initial.fieldsHash,
        );
        await expect
          .poll(() => page.evaluate(() => document.documentElement.dataset.t2TitlePending), {
            intervals: [5, 10, 20],
          })
          .toBe("yes");
        expect(await page.locator("#title").inputValue()).toBe(initial.title);
        // Host integration: dispatch the actual WXT newer-script event in the
        // original extension's ISOLATED world. Its existing Context listener
        // invokes notifyInvalidated -> abort -> registered production callbacks.
        await worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: "https://mp.weixin.qq.com/*" });
          if (!tab?.id) throw new Error("original fields tab missing");
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "ISOLATED",
            func: () => {
              document.dispatchEvent(
                new CustomEvent(`${chrome.runtime.id}:mp:wxt:content-script-started`, {
                  detail: { contentScriptName: "mp", messageId: "correction-newer-script" },
                }),
              );
            },
          });
        });
        const stopped = await original;
        expect(await page.evaluate(() => document.documentElement.dataset.t2CtxAborted)).toBe(
          "yes",
        );
        expect(stopped.code).toBe(1);
        const error = JSON.parse(stopped.stderr.trim().split("\n").at(-1)!).error;
        expect(error.snapshot).toMatchObject({
          operation: "fields",
          state: "unresolved",
          effect: { attempted: ["title"], confirmed: [], unknown: ["title"] },
          result: {
            status: "error",
            error: {
              code: "target_unavailable",
              cause: { at: "content.title_mirror", code: "target_unavailable" },
            },
          },
        });
        expect(await page.locator("#title").inputValue()).toBe(initial.title);
        const id = error.snapshot.operationId;
        const pendingCount = () =>
          worker.evaluate(async (id) => {
            const db = await new Promise<IDBDatabase>((done, fail) => {
              const request = indexedDB.open("mpctl.operations", 1);
              request.onsuccess = () => done(request.result);
              request.onerror = () => fail(request.error);
            });
            try {
              return await new Promise<string>((done) => {
                const request = db.transaction("operations").objectStore("operations").get(id);
                request.onsuccess = () => done(request.result.snapshot.state);
              });
            } finally {
              db.close();
            }
          }, id);
        expect(await pendingCount()).toBe("unresolved");
        await page.evaluate(() => (window as any).__t2ReleaseMirror());
        expect(await page.locator("#title").inputValue()).toBe("Held title");
        const before = await page.evaluate(() => ({
          counts: { ...(window as any).__t2FieldCounts },
          native: [...(window as any).__mpctlFixtureCalls],
        }));
        expect(before.counts).toEqual({ title: 1, author: 0, summary: 0 });
        const status = await cli("operation", "status", id);
        expect(status.code).toBe(0);
        expect(JSON.parse(status.stdout).snapshot).toEqual(error.snapshot);
        const repeat = await cli(
          "article",
          "update",
          article.article,
          "--fields",
          fieldsFile,
          "--expected-hash",
          initial.fieldsHash,
          "--operation",
          id,
        );
        expect(JSON.parse(repeat.stderr.trim().split("\n").at(-1)!).error.snapshot).toEqual(
          error.snapshot,
        );
        const otherFields = await cli(
          "article",
          "update",
          article.article,
          "--fields",
          fieldsFile,
          "--expected-hash",
          initial.fieldsHash,
        );
        expect(
          JSON.parse(otherFields.stderr.trim().split("\n").at(-1)!).error.snapshot.result.error,
        ).toMatchObject({ code: "operation_blocked", blockingOperationId: id });
        await writeFile(file, "must not dispatch");
        const body = await cli(
          "article",
          "push",
          article.article,
          "--body",
          file,
          "--expected-hash",
          article.bodyHash,
        );
        expect(
          JSON.parse(body.stderr.trim().split("\n").at(-1)!).error.snapshot.result.error,
        ).toMatchObject({ code: "operation_blocked", blockingOperationId: id });
        expect(await pendingCount()).toBe("unresolved");
        expect(
          await page.evaluate(() => ({
            counts: { ...(window as any).__t2FieldCounts },
            native: [...(window as any).__mpctlFixtureCalls],
          })),
        ).toEqual(before);
        expect(await page.locator("#author").inputValue()).toBe(initial.author);
        expect(await page.locator("#js_description").inputValue()).toBe(initial.summary);
        expect(
          await page.evaluate(() => ({
            author: Number(document.documentElement.dataset.t2AuthorSets ?? 0),
            summary: Number(document.documentElement.dataset.t2SummarySets ?? 0),
          })),
        ).toEqual({ author: 0, summary: 0 });
        return;
      }
      if (boundary === "fields-destroyed") {
        const inspected = await cli("article", "inspect", article.article);
        expect(inspected.code).toBe(0);
        const initial = JSON.parse(inspected.stdout);
        await page.evaluate(() => {
          document.querySelector("#author")!.addEventListener("input", () => {
            document.querySelector("#author")!.setAttribute("disabled", "");
          });
        });
        const fieldsFile = path.join(temp, "fields.json");
        await writeFile(
          fieldsFile,
          JSON.stringify({ title: "Original title", author: "Stopped", summary: "untouched" }),
        );
        const partial = await cli(
          "article",
          "update",
          article.article,
          "--fields",
          fieldsFile,
          "--expected-hash",
          initial.fieldsHash,
        );
        expect(partial.code).toBe(1);
        const error = JSON.parse(partial.stderr.trim().split("\n").at(-1)!).error;
        expect(error.snapshot).toMatchObject({
          operation: "fields",
          state: "settled",
          effect: {
            requested: ["title", "author", "summary"],
            attempted: ["title", "author"],
            confirmed: ["title"],
            unknown: ["author"],
          },
          result: { status: "error", error: { code: "fields_unavailable" } },
        });
        expect(await page.locator("#js_description").inputValue()).toBe(initial.summary);
        const operationId = error.snapshot.operationId;
        const oldUrl = page.url();
        await page.close();
        const replacement = await context.newPage();
        await replacement.goto(oldUrl);
        await expect
          .poll(() => replacement.evaluate(() => document.documentElement.dataset.mpctlReady))
          .toBe("yes");
        // Wait for actual content bootstrap, not only the fixture's JSAPI publication.
        await expect
          .poll(() =>
            replacement.evaluate(
              () => (window as any).__mpctlFixtureCalls?.includes("get_isready") ?? false,
            ),
          )
          .toBe(true);
        const before = await replacement.evaluate(() => ({
          calls: (window as any).__mpctlFixtureCalls?.length ?? 0,
          fields: {
            title: (document.querySelector('[data-placeholder="请在这里输入标题"]') as HTMLElement)
              .innerText,
            author: (document.querySelector("#author") as HTMLInputElement).value,
            summary: (document.querySelector("#js_description") as HTMLTextAreaElement).value,
          },
        }));
        const status = await cli("operation", "status", operationId);
        expect(status.code).toBe(0);
        expect(JSON.parse(status.stdout).snapshot).toEqual(error.snapshot);
        const repeated = await cli(
          "article",
          "update",
          article.article,
          "--fields",
          fieldsFile,
          "--expected-hash",
          initial.fieldsHash,
          "--operation",
          operationId,
        );
        expect(repeated.code).toBe(1);
        expect(JSON.parse(repeated.stderr.trim().split("\n").at(-1)!).error.snapshot).toEqual(
          error.snapshot,
        );
        expect(
          await replacement.evaluate(() => ({
            calls: (window as any).__mpctlFixtureCalls?.length ?? 0,
            fields: {
              title: (
                document.querySelector('[data-placeholder="请在这里输入标题"]') as HTMLElement
              ).innerText,
              author: (document.querySelector("#author") as HTMLInputElement).value,
              summary: (document.querySelector("#js_description") as HTMLTextAreaElement).value,
            },
          })),
        ).toEqual(before);
        return;
      }
      if (boundary !== "completed") {
        const counts = () =>
          page.evaluate(() =>
            (window as any).__mpctlFixtureCalls.reduce(
              (out: Record<string, number>, name: string) => {
                out[name] = (out[name] ?? 0) + 1;
                return out;
              },
              {},
            ),
          );
        const row = (host: import("@playwright/test").Page, id: string) =>
          host.evaluate(async (id) => {
            const db = await new Promise<IDBDatabase>((done) => {
              const open = indexedDB.open("mpctl.operations", 1);
              open.onsuccess = () => done(open.result);
            });
            const result = await new Promise<any>((done) => {
              const request = db.transaction("operations").objectStore("operations").get(id);
              request.onsuccess = () => done(request.result);
            });
            db.close();
            return result;
          }, id);
        // Read the committed ledger identity on the extension origin; no test RPC.
        const ledgerId = await popup.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((done) => {
            const open = indexedDB.open("mpctl.operations", 1);
            open.onsuccess = () => done(open.result);
          });
          const ledger = await new Promise<any>((done) => {
            const request = db.transaction("meta").objectStore("meta").get("ledger");
            request.onsuccess = () => done(request.result);
          });
          db.close();
          return ledger.ledgerId;
        });
        const id = `op:${ledgerId}:${crypto.randomUUID()}`;
        await writeFile(file, "<p>lifecycle original</p>");
        const initialCounts = await counts();
        if (boundary === "accepted" || boundary === "issued-before-native") {
          // Native IDB commits; only the original JS continuation is held at its
          // oncomplete delivery. Destroying the worker discards that continuation.
          await worker.evaluate(
            (state) => {
              const method = state === "accepted" ? "add" : "put";
              const original = IDBObjectStore.prototype[method];
              (IDBObjectStore.prototype as any)[method] = function (value: any, ...args: any[]) {
                if (value.snapshot?.state === state) {
                  const tx = this.transaction;
                  const oncomplete = tx.oncomplete;
                  tx.oncomplete = () => {
                    (globalThis as any).__t1CommitBarrier = state;
                    (globalThis as any).__t1HeldContinuation = () =>
                      oncomplete?.call(tx, new Event("complete"));
                  };
                }
                return original.call(this, value, ...args);
              };
            },
            boundary === "accepted" ? "accepted" : "issued",
          );
        } else {
          if (boundary !== "refusal-loss")
            await page.evaluate(() => {
              const timer = window.setTimeout.bind(window);
              // External clock barrier keeps MAIN's native task genuinely active
              // through worker stop/wake; callback release, not a sleep, ends it.
              window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: any[]) =>
                delay === 5_000 && document.documentElement.dataset.t1Hold === "yes"
                  ? -1
                  : timer(handler, delay, ...args)) as typeof window.setTimeout;
            });
          await page.evaluate((mode) => {
            document.documentElement.dataset[mode === "refusal-loss" ? "t1HoldRead" : "t1Hold"] =
              "yes";
          }, boundary);
        }
        const submitted = cli(
          "article",
          "push",
          article.article,
          "--body",
          file,
          "--expected-hash",
          boundary === "refusal-loss" ? "a".repeat(64) : article.bodyHash,
          "--operation",
          id,
        );
        if (boundary === "accepted" || boundary === "issued-before-native") {
          await expect
            .poll(() => worker.evaluate(() => (globalThis as any).__t1CommitBarrier))
            .toBe(boundary === "accepted" ? "accepted" : "issued");
          expect(await counts()).toEqual(initialCounts);
        } else {
          await expect
            .poll(() =>
              page.evaluate(
                (mode) =>
                  typeof (window as any)[
                    mode === "refusal-loss" ? "__t1ReleaseRead" : "__t1ReleaseSetter"
                  ],
                boundary,
              ),
            )
            .toBe("function");
        }
        const original = await row(popup, id);
        expect(original.snapshot.state).toBe(boundary === "accepted" ? "accepted" : "issued");
        const beforeRestart = await counts();
        expect(beforeRestart.set_content ?? 0).toBe(
          boundary === "active-main" || boundary === "both-destroyed" ? 1 : 0,
        );

        if (boundary === "refusal-loss") {
          await page.evaluate(() => {
            delete document.documentElement.dataset.t1HoldRead;
            document.documentElement.dataset.t1DropReply = "yes";
            (window as any).__t1ReleaseRead();
          });
          await expect
            .poll(() => page.evaluate(() => document.documentElement.dataset.t1ReplyDropped))
            .toBe("yes");
          expect((await submitted).code).toBe(1);
          expect((await row(popup, id)).snapshot).toMatchObject({
            state: "unresolved",
            effect: { outcome: "unknown" },
          });
          const beforeQuery = await counts();
          const status = await cli("operation", "status", id);
          expect(status.code, status.stderr).toBe(0);
          expect(JSON.parse(status.stdout)).toMatchObject({
            snapshot: {
              state: "settled",
              effect: { outcome: "unknown" },
              result: { status: "error", error: { code: "content_conflict" } },
            },
          });
          expect(JSON.parse(status.stdout).issue).toBeUndefined();
          expect(await counts()).toEqual(beforeQuery);
          const next = await cli(
            "article",
            "push",
            article.article,
            "--body",
            file,
            "--expected-hash",
            article.bodyHash,
          );
          expect(next.code, next.stderr).toBe(0);
          expect((await counts()).set_content).toBe(1);
          return;
        }
        const session = await context.newCDPSession(page);
        const versions: any[] = [];
        session.on("ServiceWorker.workerVersionUpdated", (event) =>
          versions.push(...event.versions),
        );
        await session.send("ServiceWorker.enable");
        await expect
          .poll(
            () =>
              versions.findLast(
                (v) => v.scriptURL === worker.url() && v.runningStatus === "running",
              )?.versionId,
          )
          .toBeTruthy();
        const version = versions.findLast(
          (v) => v.scriptURL === worker.url() && v.runningStatus === "running",
        );
        await popup.close();
        const stopping = session.send("ServiceWorker.stopWorker", { versionId: version.versionId });
        expect(
          (await session.send("Target.closeTarget", { targetId: version.targetId })).success,
        ).toBe(true);
        await stopping;
        await expect
          .poll(() =>
            versions.some(
              (v) => v.versionId === version.versionId && v.runningStatus === "stopped",
            ),
          )
          .toBe(true);
        if (boundary === "both-destroyed") await page.close();
        const freshPopup = await context.newPage();
        await freshPopup.goto(`chrome-extension://${extensionId}/popup.html`);
        await freshPopup.getByRole("button", { name: "显式连接" }).click();
        await expect(freshPopup.getByRole("status")).toContainText("已连接");
        await expect(worker.evaluate(() => true)).rejects.toThrow(
          "Execution context was destroyed",
        );
        const recovered = await row(freshPopup, id);
        expect(recovered.snapshot.state).toBe(boundary === "accepted" ? "settled" : "unresolved");
        expect(recovered.owner).toBe(original.owner); // historical owner isn't reassigned by recovery
        expect((await submitted).code).not.toBe(0);
        let freshArticle: any;
        if (boundary !== "both-destroyed") {
          expect(await counts()).toEqual(beforeRestart);
          const current = await cli("article", "current");
          expect(current.code, current.stderr).toBe(0);
          freshArticle = JSON.parse(current.stdout);
        } else {
          const replacement = await context.newPage();
          await replacement.goto(scenarioUrl);
          // Replacement is an explicit test/user action, never a receipt recovery action.
          await freshPopup.evaluate(async () => {
            const tabs = await chrome.tabs.query({ url: "https://mp.weixin.qq.com/*" });
            const group = await chrome.tabs.group({ tabIds: [tabs[0]!.id!] });
            await chrome.tabGroups.update(group, { title: "mpctl" });
            await chrome.storage.local.set({ managedGroupId: group });
          });
          await expect
            .poll(() => replacement.evaluate(() => document.documentElement.dataset.mpctlReady))
            .toBe("yes");
          let replacementArticle: any;
          await expect
            .poll(async () => {
              const current = await cli("article", "current");
              if (current.code === 0) replacementArticle = JSON.parse(current.stdout);
              return current.code;
            })
            .toBe(0);
          const before = await replacement.evaluate(() =>
            (window as any).__mpctlFixtureCalls.slice(),
          );
          const status = await cli("operation", "status", id);
          expect(status.code).toBe(0);
          expect(JSON.parse(status.stdout)).toMatchObject({
            snapshot: { state: "unresolved" },
            issue: { failure: { code: "receipt_unreachable" } },
          });
          const replay = await cli(
            "article",
            "push",
            article.article,
            "--body",
            file,
            "--expected-hash",
            article.bodyHash,
            "--operation",
            id,
          );
          expect(replay.code).toBe(1);
          expect(await replacement.evaluate(() => (window as any).__mpctlFixtureCalls)).toEqual(
            before,
          );
          expect(before).not.toContain("set_content");
          const newIntent = await cli(
            "article",
            "push",
            replacementArticle.article,
            "--body",
            file,
            "--expected-hash",
            replacementArticle.bodyHash,
          );
          expect(newIntent.code).toBe(1);
          expect(JSON.parse(newIntent.stderr.trim().split("\n").at(-1)!).error.code).toBe(
            "operation_blocked",
          );
          const newId = JSON.parse(newIntent.stderr.trim().split("\n").at(-1)!).error.operationId;
          expect((await row(freshPopup, newId)).owner).not.toBe(original.owner);
          expect(await replacement.evaluate(() => (window as any).__mpctlFixtureCalls)).toEqual(
            before,
          );
        }
        if (freshArticle) {
          const related = await cli(
            "article",
            "push",
            freshArticle.article,
            "--body",
            file,
            "--expected-hash",
            freshArticle.bodyHash,
          );
          const relatedReply = JSON.parse(
            (related.code === 0 ? related.stdout : related.stderr.trim().split("\n").at(-1))!,
          );
          const nextId =
            related.code === 0 ? relatedReply.snapshot.operationId : relatedReply.error.operationId;
          expect((await row(freshPopup, nextId)).owner).not.toBe(original.owner);
          if (boundary === "accepted") {
            expect(related.code, related.stderr).toBe(0);
            expect((await counts()).set_content).toBe(1);
            expect(recovered.snapshot.result.error.code).toBe("operation_interrupted");
          } else {
            expect(related.code).toBe(1);
            expect(relatedReply.error.code).toBe("operation_blocked");
            const beforeStatus = await counts();
            const active = await cli("operation", "status", id);
            expect(active.code).toBe(0);
            expect(JSON.parse(active.stdout).snapshot.state).toBe("unresolved");
            expect(await counts()).toEqual(beforeStatus);
            if (boundary === "issued-before-native")
              expect(JSON.parse(active.stdout).issue.failure.code).toBe("receipt_missing");
            else {
              await page.evaluate(() => {
                delete document.documentElement.dataset.t1Hold;
                (window as any).__t1ReleaseSetter();
              });
              let ended: any;
              await expect
                .poll(async () => {
                  const status = await cli("operation", "status", id);
                  ended = JSON.parse(status.stdout);
                  return ended.snapshot.state;
                })
                .toBe("settled");
              expect(ended.snapshot.effect.outcome).toBe("confirmed");
              expect(await counts()).toEqual({
                ...beforeStatus,
                get_content: beforeStatus.get_content + 1,
              });
              expect((await counts()).set_content).toBe(1);
            }
          }
          const beforeReplay = await counts();
          await cli(
            "article",
            "push",
            article.article,
            "--body",
            file,
            "--expected-hash",
            article.bodyHash,
            "--operation",
            id,
          );
          expect(await counts()).toEqual(beforeReplay);
        }
        if (boundary !== "both-destroyed") await session.detach();
        return;
      }
      await writeFile(file, "<p>idempotent body</p>");
      const first = await cli(
        "article",
        "push",
        article.article,
        "--body",
        file,
        "--expected-hash",
        article.bodyHash,
      );
      expect(first.code, first.stdout + first.stderr).toBe(0);
      const firstReply = JSON.parse(first.stdout);
      const id = firstReply.snapshot.operationId;
      const counts = () =>
        page.evaluate(() =>
          (window as any).__mpctlFixtureCalls.reduce(
            (counts: Record<string, number>, call: string) => {
              counts[call] = (counts[call] ?? 0) + 1;
              return counts;
            },
            {},
          ),
        );
      const beforeDuplicate = await counts();
      const duplicates = await Promise.all(
        [1, 2].map(() =>
          cli(
            "article",
            "push",
            article.article,
            "--body",
            file,
            "--expected-hash",
            article.bodyHash,
            "--operation",
            id,
          ),
        ),
      );
      for (const duplicate of duplicates) expect(duplicate.code, duplicate.stderr).toBe(0);
      expect(await counts()).toEqual(beforeDuplicate);
      expect(beforeDuplicate.set_content).toBe(1);
      // Drop the original CLI reply by terminating only this submitting child at the
      // exact setter callback barrier. BG/MAIN remain alive and finish the original key.
      const heldId = `op:${id.split(":")[1]}:${crypto.randomUUID()}`;
      await writeFile(file, "<p>lost CLI reply</p>");
      await page.evaluate(() => {
        document.documentElement.dataset.t1Hold = "yes";
      });
      const abandoned = spawn(
        "bun",
        [
          "run",
          "packages/cli/src/main.ts",
          "article",
          "push",
          article.article,
          "--body",
          file,
          "--expected-hash",
          firstReply.snapshot.effect.bodyHash,
          "--operation",
          heldId,
        ],
        { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      children.add(abandoned);
      abandoned.once("exit", () => children.delete(abandoned));
      const abandonedExit = new Promise((resolve) => abandoned.once("exit", resolve));
      await expect
        .poll(() => page.evaluate(() => typeof (window as any).__t1ReleaseSetter))
        .toBe("function");
      const activeStatus = await cli("operation", "status", heldId);
      expect(JSON.parse(activeStatus.stdout).snapshot.state).toBe("issued");
      abandoned.kill("SIGTERM");
      await abandonedExit;
      await page.evaluate(() => {
        delete document.documentElement.dataset.t1Hold;
        document.documentElement.dataset.t1DropReply = "yes";
        (window as any).__t1ReleaseSetter();
      });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.t1ReplyDropped))
        .toBe("yes");
      const countsAfterDrop = await counts();
      let afterLoss: any;
      await expect
        .poll(
          async () => {
            const status = await cli("operation", "status", heldId);
            afterLoss = JSON.parse(status.stdout);
            return afterLoss.snapshot.state;
          },
          { timeout: 40_000 },
        )
        .toBe("settled");
      expect(await counts()).toEqual(countsAfterDrop);
      const beforeLossReplay = await counts();
      const lossReplay = await cli(
        "article",
        "push",
        article.article,
        "--body",
        file,
        "--expected-hash",
        firstReply.snapshot.effect.bodyHash,
        "--operation",
        heldId,
      );
      expect(lossReplay.code, lossReplay.stderr).toBe(0);
      expect(await counts()).toEqual(beforeLossReplay);
      expect(beforeLossReplay.set_content).toBe(2);
      // External native-IDB seam: lose the BG terminal commit after MAIN has a receipt.
      await worker.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value: any, ...args: any[]) {
          const request = original.call(this, value, ...args);
          if (value.snapshot?.state === "settled" || value.snapshot?.state === "unresolved")
            request.addEventListener("success", () => this.transaction.abort());
          return request;
        };
      });
      await writeFile(file, "<p>second operation</p>");
      const lost = await cli(
        "article",
        "push",
        article.article,
        "--body",
        file,
        "--expected-hash",
        afterLoss.snapshot.effect.bodyHash,
      );
      expect(lost.code).toBe(1);
      const failed = JSON.parse(lost.stderr.trim().split("\n").at(-1)!);
      const lostId = failed.error.operationId;
      expect(failed.error.issue.uncommitted.effect.outcome).toBe("confirmed");
      const fields = path.join(temp, "fields.json");
      await writeFile(fields, JSON.stringify({ title: "must not write" }));
      const blocked = await cli(
        "article",
        "update",
        article.article,
        "--fields",
        fields,
        "--expected-hash",
        "a".repeat(64),
      );
      expect(blocked.code).toBe(1);
      const blockedFields = JSON.parse(blocked.stderr.split("\n").slice(1).join("\n")).error;
      // This test still aborts every terminal IDB write. Fields now also own a
      // committed claim, so the zero-dispatch refusal is explicitly uncommitted.
      expect(blockedFields.code).toBe("storage_failed");
      expect(blockedFields.snapshot).toMatchObject({
        operation: "fields",
        state: "accepted",
        effect: { outcome: "not_dispatched", attempted: [] },
      });
      expect(blockedFields.issue.uncommitted.result.error.code).toBe("operation_blocked");
      expect(blockedFields.issue.uncommitted.result.error.blockingOperationId).toBe(lostId);
      expect(await page.locator('[data-placeholder="请在这里输入标题"]').innerText()).not.toBe(
        "must not write",
      );
      const blockedReload = await cli("connect", "--reload", "--extension", extensionId);
      expect(blockedReload.code).toBe(1);
      expect(JSON.parse(blockedReload.stderr).error.code).toBe("reload_failed");
      const beforeOwner = await worker.evaluate(async (id) => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const request = indexedDB.open("mpctl.operations", 1);
          request.onsuccess = () => resolve(request.result);
        });
        const record = await new Promise<any>((resolve) => {
          const request = db.transaction("operations").objectStore("operations").get(id);
          request.onsuccess = () => resolve(request.result);
        });
        db.close();
        return { owner: record.owner, state: record.snapshot.state };
      }, lostId);
      expect(beforeOwner.state).toBe("issued");
      const beforeRestart = await counts();
      const marker = await page.evaluate(
        () => document.documentElement.dataset.mpctlFixtureDocumentId,
      );
      await worker.evaluate(() => {
        (globalThis as any).__t1WorkerGeneration = "original";
      });
      console.info("idempotency: MAIN confirmed; stopping BG");
      const session = await context.newCDPSession(page);
      const versions: any[] = [];
      session.on("ServiceWorker.workerVersionUpdated", (event) => versions.push(...event.versions));
      await session.send("ServiceWorker.enable");
      await expect
        .poll(
          () =>
            versions.find(
              (version) =>
                version.scriptURL === worker.url() && version.runningStatus === "running",
            )?.versionId,
        )
        .toBeTruthy();
      const version = versions.findLast(
        (version) => version.scriptURL === worker.url() && version.runningStatus === "running",
      );
      await popup.close();
      await session.send("ServiceWorker.stopWorker", { versionId: version.versionId });
      // Playwright's autoattached debugger can retain this worker; close the exact worker target.
      expect(
        (await session.send("Target.closeTarget", { targetId: version.targetId })).success,
      ).toBe(true);
      await expect
        .poll(() =>
          versions.some(
            (item) => item.versionId === version.versionId && item.runningStatus === "stopped",
          ),
        )
        .toBe(true);
      console.info("idempotency: original BG closed");
      // An extension API event wakes MV3; startWorker is not a supported wake for this registration.
      const replacementPopup = await context.newPage();
      await replacementPopup.goto(`chrome-extension://${extensionId}/popup.html`);
      console.info("idempotency: popup wake sent");
      await expect
        .poll(
          () => versions.findLast((item) => item.versionId === version.versionId)?.runningStatus,
        )
        .toBe("running");
      // Chrome reuses targetId, but destroys the old JS execution context.
      await expect(worker.evaluate(() => (globalThis as any).__t1WorkerGeneration)).rejects.toThrow(
        "Execution context was destroyed",
      );
      await replacementPopup.getByRole("button", { name: "显式连接" }).click();
      await expect(replacementPopup.getByRole("status")).toContainText("已连接");
      const recovered = await replacementPopup.evaluate(async (id) => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const request = indexedDB.open("mpctl.operations", 1);
          request.onsuccess = () => resolve(request.result);
        });
        const record = await new Promise<any>((resolve) => {
          const request = db.transaction("operations").objectStore("operations").get(id);
          request.onsuccess = () => resolve(request.result);
        });
        db.close();
        return record.snapshot.state;
      }, lostId);
      expect(recovered).toBe("unresolved");
      expect(await counts()).toEqual(beforeRestart);
      const status = await cli("operation", "status", lostId);
      expect(status.code, status.stdout + status.stderr).toBe(0);
      expect(JSON.parse(status.stdout).snapshot).toMatchObject({
        operationId: lostId,
        state: "settled",
        effect: { outcome: "confirmed" },
      });
      expect(await counts()).toEqual(beforeRestart);
      expect(beforeRestart.set_content).toBe(3);
      expect(
        await page.evaluate(() => document.documentElement.dataset.mpctlFixtureDocumentId),
      ).toBe(marker);
      const replay = await cli(
        "article",
        "push",
        article.article,
        "--body",
        file,
        "--expected-hash",
        afterLoss.snapshot.effect.bodyHash,
        "--operation",
        lostId,
      );
      expect(replay.code, replay.stderr).toBe(0);
      expect(await counts()).toEqual(beforeRestart);
      const nextWrite = await cli(
        "article",
        "push",
        article.article,
        "--body",
        file,
        "--expected-hash",
        firstReply.snapshot.effect.bodyHash,
      );
      expect(nextWrite.code).toBe(1); // fresh BG must not revive the old ephemeral article capability
      const nextId = JSON.parse(nextWrite.stderr.trim().split("\n").at(-1)!).error.operationId;
      const nextOwner = await replacementPopup.evaluate(async (id) => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const request = indexedDB.open("mpctl.operations", 1);
          request.onsuccess = () => resolve(request.result);
        });
        const record = await new Promise<any>((resolve) => {
          const request = db.transaction("operations").objectStore("operations").get(id);
          request.onsuccess = () => resolve(request.result);
        });
        db.close();
        return record.owner;
      }, nextId);
      expect(nextOwner).not.toBe(beforeOwner.owner);
      expect(await counts()).toEqual(beforeRestart);
      await session.detach();
    } finally {
      await Promise.all(
        [...children].map(async (child) => {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise((resolve) => child.once("exit", resolve));
            child.kill("SIGTERM");
            await exited;
          }
        }),
      );
      await context?.close();
      if (navigationServer)
        await new Promise<void>((resolve) => navigationServer!.close(() => resolve()));
      if (broker && broker.exitCode === null) {
        broker.kill("SIGTERM");
        await new Promise((resolve) => broker!.once("exit", resolve));
      }
      await rm(temp, { recursive: true, force: true });
    }
  });
}
import { nativeHomeHtml } from "../native-handler-fixture";
