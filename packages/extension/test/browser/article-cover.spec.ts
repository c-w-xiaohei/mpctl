import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const helperSource = path.join(root, "packages/extension/src/mp/article-cover.ts");
const fixtureUrl = "https://article-cover.test/fixture";
const helperUrl = "https://article-cover.test/article-cover.js";
const executablePath =
  process.env.CHROMEEXEC ??
  process.env.MPCTL_CHROMIUM_EXECUTABLE ??
  "/home/c_w_xiaohei/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome";
let temp: string;
let helperBundle: string;
let sourceHash: string;
let bundleHash: string;

const fixture = `<!doctype html>
<meta charset="utf-8">
<style>
  #js_cover_area { width: 440px; height: 240px; }
  .preview { width: 200px; height: 100px; background-size: cover; }
  .js_cover_preview_square { display: none; }
  #display-hidden { display: none; }
</style>
<div id="js_cover_area">
  <div id="visibility-hidden" style="visibility: hidden">
    <div class="js_cover_preview_new preview" style='visibility: visible; background-image: url("https://mmbiz.qpic.cn/mmbiz_jpg/primary/0?wx_fmt=jpg")'></div>
  </div>
  <div class="js_cover_preview_square preview" style="background-image: none"></div>
  <div id="display-hidden">
    <div class="display-hidden-preview preview" style="background-image: url('https://mmbiz.qpic.cn/mmbiz_png/hidden/0')"></div>
  </div>
</div>`;

test.beforeAll(async () => {
  temp = await mkdtemp("/tmp/opencode/mpctl-article-cover-browser-");
  const bundlePath = path.join(temp, "article-cover.js");
  const source = await readFile(helperSource);
  sourceHash = createHash("sha256").update(source).digest("hex");
  execFileSync(
    "bun",
    ["build", helperSource, "--target=browser", "--format=esm", `--outfile=${bundlePath}`],
    { cwd: root, stdio: "pipe" },
  );
  helperBundle = await readFile(bundlePath, "utf8");
  bundleHash = createHash("sha256").update(helperBundle).digest("hex");
  console.info(`article-cover source sha256=${sourceHash} bundle sha256=${bundleHash}`);
});

test.afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

test("production cover reader snapshots actual Chromium CSS and versions only observed preview state", async () => {
  test.setTimeout(30_000);
  let context: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    context = await chromium.launch({
      headless: true,
      executablePath,
      args: ["--no-sandbox", "--no-first-run"],
    });
    const page = await context.newPage();
    const blocked: string[] = [];
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === fixtureUrl) {
        await route.fulfill({ status: 200, contentType: "text/html", body: fixture });
      } else if (url === helperUrl) {
        await route.fulfill({ status: 200, contentType: "text/javascript", body: helperBundle });
      } else {
        blocked.push(url);
        await route.abort("blockedbyclient");
      }
    });
    await page.goto(fixtureUrl);

    const baseline = await page.evaluate(async (url) => {
      const { hashArticleCover, readArticleCover } = await import(url);
      const body = document.body.innerHTML;
      const first = readArticleCover(document);
      const second = readArticleCover(document);
      const hash = first.status === "ok" ? await hashArticleCover(first.value) : undefined;
      const repeatedHash =
        second.status === "ok" ? await hashArticleCover(second.value) : undefined;
      const primary = document.querySelector<HTMLElement>(".js_cover_preview_new")!;
      const square = document.querySelector<HTMLElement>(".js_cover_preview_square")!;
      const primaryStyle = getComputedStyle(primary);
      const squareStyle = getComputedStyle(square);
      return {
        snapshot: first.status === "ok" ? first.value : { error: first.error.code },
        repeat: second.status === "ok" ? second.value : { error: second.error.code },
        hash: hash?.status === "ok" ? hash.value : hash?.error.code,
        repeatedHash: repeatedHash?.status === "ok" ? repeatedHash.value : repeatedHash?.error.code,
        primaryComputed: {
          visibility: primaryStyle.visibility,
          display: primaryStyle.display,
          rects: primary.getClientRects().length,
          background: primaryStyle.backgroundImage,
          ariaHidden: primary.getAttribute("aria-hidden"),
          parentVisibility: getComputedStyle(primary.parentElement!).visibility,
        },
        squareComputed: {
          display: squareStyle.display,
          rects: square.getClientRects().length,
          background: squareStyle.backgroundImage,
        },
        bodyUnchanged: body === document.body.innerHTML,
      };
    }, helperUrl);

    expect(baseline.snapshot).toEqual({
      primary: { visible: true, url: "https://mmbiz.qpic.cn/mmbiz_jpg/primary/0?wx_fmt=jpg" },
      square: { visible: false, url: null },
    });
    expect(baseline.repeat).toEqual(baseline.snapshot);
    expect(baseline.hash).toEqual(baseline.repeatedHash);
    expect(baseline.primaryComputed).toMatchObject({
      visibility: "visible",
      display: "block",
      rects: 1,
      ariaHidden: null,
      parentVisibility: "hidden",
    });
    expect(baseline.primaryComputed.background).toContain(
      "https://mmbiz.qpic.cn/mmbiz_jpg/primary/0?wx_fmt=jpg",
    );
    expect(baseline.squareComputed).toMatchObject({
      display: "none",
      rects: 0,
      background: "none",
    });
    expect(baseline.bodyUnchanged).toBe(true);

    const transitions = await page.evaluate(async (url) => {
      const { hashArticleCover, readArticleCover } = await import(url);
      const read = async () => {
        const snapshot = readArticleCover(document);
        if (snapshot.status === "error") return { error: snapshot.error.code };
        const hash = await hashArticleCover(snapshot.value);
        return {
          snapshot: snapshot.value,
          hash: hash.status === "ok" ? hash.value : hash.error.code,
        };
      };
      const square = document.querySelector<HTMLElement>(".js_cover_preview_square")!;
      const primary = document.querySelector<HTMLElement>(".js_cover_preview_new")!;
      const parent = primary.parentElement!;
      const initial = await read();
      primary.setAttribute("aria-hidden", "true");
      const ariaHidden = await read();
      parent.style.visibility = "visible";
      const parentVisible = await read();
      parent.style.visibility = "hidden";
      parent.style.display = "none";
      const displayHidden = await read();
      parent.style.display = "block";
      square.style.backgroundImage = 'url("https://mmbiz.qpic.cn/sz_mmbiz_png/square/0")';
      const hiddenSquareUrl = await read();
      square.style.backgroundImage = "url(data:image/png;base64,AAAA)";
      const unsupportedData = readArticleCover(document);
      square.style.backgroundImage = "url(blob:https://article-cover.test/id)";
      const unsupportedBlob = readArticleCover(document);
      square.style.backgroundImage = 'url("https://mmbiz.qpic.cn/")';
      const malformedPath = readArticleCover(document);
      return {
        initial,
        ariaHidden,
        parentVisible,
        displayHidden,
        hiddenSquareUrl,
        unsupportedData,
        unsupportedBlob,
        malformedPath,
      };
    }, helperUrl);

    expect(transitions.initial).toEqual({ snapshot: baseline.snapshot, hash: baseline.hash });
    expect(transitions.ariaHidden).toEqual(transitions.initial);
    expect(transitions.parentVisible).toEqual(transitions.initial);
    expect(transitions.displayHidden.snapshot).toEqual({
      primary: { visible: false, url: "https://mmbiz.qpic.cn/mmbiz_jpg/primary/0?wx_fmt=jpg" },
      square: { visible: false, url: null },
    });
    expect(transitions.displayHidden.hash).not.toBe(baseline.hash);
    expect(transitions.hiddenSquareUrl).toMatchObject({
      snapshot: {
        primary: { visible: true },
        square: { visible: false, url: "https://mmbiz.qpic.cn/sz_mmbiz_png/square/0" },
      },
    });
    expect(transitions.hiddenSquareUrl.hash).not.toBe(transitions.initial.hash);
    expect(transitions.unsupportedData).toEqual({
      status: "error",
      error: { code: "cover_unavailable" },
    });
    expect(transitions.unsupportedBlob).toEqual({
      status: "error",
      error: { code: "cover_unavailable" },
    });
    expect(transitions.malformedPath).toEqual({
      status: "error",
      error: { code: "cover_unavailable" },
    });
    expect(blocked.every((url) => url.startsWith("https://mmbiz.qpic.cn/"))).toBe(true);

    const rejection = await page.evaluate(async (url) => {
      const { readArticleCover } = await import(url);
      const area = document.querySelector<HTMLElement>("#js_cover_area")!;
      const square = area.querySelector<HTMLElement>(".js_cover_preview_square")!;
      const duplicate = document.createElement("div");
      duplicate.className = "js_cover_preview_square";
      area.append(duplicate);
      const ambiguous = readArticleCover(document);
      duplicate.remove();
      square.style.backgroundImage = "linear-gradient(red, blue)";
      const gradient = readArticleCover(document);
      square.style.backgroundImage = "none";
      const missing = square.remove();
      const absent = readArticleCover(document);
      return { ambiguous, gradient, absent, removed: missing === undefined };
    }, helperUrl);
    expect(rejection.ambiguous).toEqual({ status: "error", error: { code: "cover_unavailable" } });
    expect(rejection.gradient).toEqual({ status: "error", error: { code: "cover_unavailable" } });
    expect(rejection.absent).toEqual({ status: "error", error: { code: "cover_unavailable" } });
    expect(rejection.removed).toBe(true);
  } finally {
    await context?.close();
  }
});
