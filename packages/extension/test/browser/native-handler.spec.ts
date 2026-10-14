import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { nativeHandlerFixtureScript } from "../native-handler-fixture";
let temp: string;
let bundle: string;
test.beforeAll(async () => {
  temp = await mkdtemp("/tmp/opencode/mpctl-f1-handler-");
  execFileSync("bun", [
    "build",
    "test/browser/fixtures/navigation-correction.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${temp}/entry.js`,
  ]);
  bundle = await readFile(`${temp}/entry.js`, "utf8");
});
test.afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

for (const dependency of ["needSplitMsg", "parent.report"] as const)
  test(`H3 Chromium ${dependency} rejected before original late popup scheduling`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("entry.js")
          ? route.fulfill({ contentType: "text/javascript", body: bundle })
          : route.fulfill({
              contentType: "text/html",
              body: '<meta charset="utf-8"><div class="weui-desktop-card" data-appid="A"><div class="weui-desktop-tooltip__wrp weui-desktop-link"><a href="javascript:;">edit</a></div></div>',
            }),
      );
      await page.goto("https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77");
      await page.addScriptTag({ content: nativeHandlerFixtureScript(true) });
      const result = await page.evaluate(async (dependency) => {
        const url = "https://mp.weixin.qq.com/entry.js";
        const { navigationFixture, captureNativeDraftEditorUrl } = await import(url);
        const f = await navigationFixture();
        let release!: () => void;
        const gate = new Promise<void>((done) => {
          release = done;
        });
        const scheduled: Promise<void>[] = [];
        let calls = 0;
        let late = 0;
        const state = window as any;
        const vm = state.nativeHandlerVm;
        const unsupported = function unsupportedNativeHelper() {
          calls++;
          scheduled.push(
            gate.then(() => {
              window.open(
                "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=A",
              );
              late++;
            }),
          );
          return false;
        };
        if (dependency === "needSplitMsg") vm.needSplitMsg = unsupported;
        else vm.$parent.report = unsupported;
        try {
          f.api.executeMain = async () => {
            f.counters.capture++;
            return [{ result: await captureNativeDraftEditorUrl("A") }];
          };
          const input = { operationId: f.id(), candidate: "A" };
          const first = await f.decode(await f.workspace.openArticle(input));
          release();
          await Promise.all(scheduled);
          const replay = await f.decode(await f.workspace.openArticle(input));
          const query = await f.decode(await f.workspace.getOperation(input.operationId));
          return {
            first,
            replay,
            query,
            calls,
            late,
            counts: f.counters,
            native: state.nativeHandlerCounts,
            getterWrite: localStorage.getItem("previousLength"),
          };
        } finally {
          release();
          await Promise.all(scheduled);
          f.dispose();
        }
      }, dependency);
      expect(result.first.snapshot).toMatchObject({
        state: "settled",
        result: { status: "error" },
      });
      expect(result.replay.snapshot).toEqual(result.first.snapshot);
      expect(result.query.snapshot).toEqual(result.first.snapshot);
      expect(result.calls).toBe(0);
      expect(result.late).toBe(0);
      expect(result.native.invocation).toBe(0);
      expect(result.native.getter).toBe(0);
      expect(result.getterWrite).toBeNull();
      expect(result.counts).toEqual({
        create: 0,
        group: 0,
        capture: 1,
        reload: 0,
        read: 0,
        set: 0,
      });
      expect(browser.contexts()[0]!.pages()).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });
for (const saved of [false, true])
  test(`associated native ${saved ? "saved" : "new"} target completes without unrelated DOM fanout`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("entry.js")
          ? route.fulfill({ contentType: "text/javascript", body: bundle })
          : route.fulfill({
              contentType: "text/html",
              body: '<meta charset="utf-8"><div class="new-creation__menu-item">文章</div><div class="weui-desktop-card" data-appid="A"><div class="weui-desktop-tooltip__wrp weui-desktop-link"><a href="javascript:;">edit</a></div></div>',
            }),
      );
      await page.goto(
        saved
          ? "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77"
          : "https://mp.weixin.qq.com/cgi-bin/home?t=home",
      );
      await page.addScriptTag({ content: nativeHandlerFixtureScript(saved) });
      const value = await page.evaluate(async (saved) => {
        const url = "https://mp.weixin.qq.com/entry.js";
        const { captureNativeNewEditorUrl, captureNativeDraftEditorUrl } = await import(url);
        const real = window.open;
        const result = saved
          ? await captureNativeDraftEditorUrl("A")
          : await captureNativeNewEditorUrl();
        return {
          result,
          counters: (window as any).nativeHandlerCounts,
          restored: window.open === real,
          length: localStorage.getItem("previousLength"),
        };
      }, saved);
      expect(value.result).toMatchObject({ kind: "captured", ended: true });
      expect(value.result).not.toHaveProperty("notDispatched");
      expect(value.counters.dom).toBe(0);
      expect(value.restored).toBe(true);
      if (saved) {
        expect(value.counters.getter).toBe(1);
        expect(value.counters.emit).toBe(1);
        expect(value.length).toBe("1");
      }
    } finally {
      await browser.close();
    }
  });

for (const saved of [false, true])
  test(`actual delayed native ${saved ? "draft" : "home >60"} timeout banner is independent of article acquisition`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("entry.js")
          ? route.fulfill({ contentType: "text/javascript", body: bundle })
          : route.fulfill({
              contentType: "text/html",
              body: '<meta charset="utf-8"><div class="new-creation__menu-item">文章</div><div class="weui-desktop-card" data-appid="A"><div class="weui-desktop-tooltip__wrp weui-desktop-link"><a href="javascript:;">edit</a></div></div>',
            }),
      );
      await page.goto(
        saved
          ? "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77"
          : "https://mp.weixin.qq.com/cgi-bin/home?t=home",
      );
      await page.addScriptTag({ content: nativeHandlerFixtureScript(saved, true) });
      const before = await page.evaluate(async (saved) => {
        const url = "https://mp.weixin.qq.com/entry.js";
        const { navigationFixture, captureNativeNewEditorUrl } = await import(url);
        const f = await navigationFixture();
        (window as any).f = f;
        f.api.executeMain = async ({ args }: any) => {
          f.counters.capture++;
          return [{ result: await captureNativeNewEditorUrl(args?.[0]) }];
        };
        const input = saved ? { operationId: f.id(), candidate: "A" } : { operationId: f.id() };
        (window as any).input = input;
        const response = await f.decode(
          saved ? await f.workspace.openArticle(input) : await f.workspace.newArticle(input),
        );
        return {
          response,
          counts: { ...f.counters },
          tip: (window as any).nativeHandlerCounts.tip ?? 0,
        };
      }, saved);
      expect(before.response.snapshot).toMatchObject({
        state: "settled",
        result: { status: "ok" },
        effect: { pageCreated: true, targetBound: true },
      });
      expect(before.tip).toBe(0);
      const after = await page.evaluate(async (saved) => {
        const s = window as any;
        s.releaseNativeTelemetry();
        await s.nativeTelemetryDone;
        try {
          const replay = await s.f.decode(
            saved
              ? await s.f.workspace.openArticle(s.input)
              : await s.f.workspace.newArticle(s.input),
          );
          const selected = await s.f.current(saved ? "A" : undefined);
          const read = await s.f.workspace.readBody(selected.article);
          const banner = document.querySelector(".weui-toptips")!;
          return {
            replay,
            counts: s.f.counters,
            read,
            tips: s.nativeHandlerCounts.tip,
            banner: {
              text: banner.textContent,
              controls: banner.querySelectorAll("a,button,input").length,
              pointer: getComputedStyle(banner.parentElement!).pointerEvents,
            },
            show: s.nativeTipState.isShow,
          };
        } finally {
          s.nativeTipState.isShow = false;
          s.f.dispose();
        }
      }, saved);
      expect(after.replay.snapshot).toEqual(before.response.snapshot);
      expect(after.counts).toMatchObject({ create: 1, group: 1, capture: 1, reload: 0, set: 0 });
      expect(after.read.status).toBe("ok");
      expect(after.tips).toBe(1);
      expect(after.show).toBe(true);
      expect(after.banner.controls).toBe(0);
      expect(after.banner.text).toContain("网络环境");
      expect(after.banner.pointer).toBe("auto");
    } finally {
      await browser.close();
    }
  });
