import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const helperSource = path.join(root, "packages/extension/src/mp/asset-upload.ts");
const fixtureUrl = "https://asset-upload.test/fixture";
const helperUrl = "https://asset-upload.test/asset-upload.js";
const executablePath =
  process.env.MPCTL_CHROMIUM_EXECUTABLE ??
  "/home/c_w_xiaohei/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome";
const filename = "browser-fixture.png";
const mimeType = "image/png";
const fixtureBytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 250, 251];
const fixtureSha256 = createHash("sha256").update(Uint8Array.from(fixtureBytes)).digest("hex");
const thumbnailUrl = "https://mmbiz.qpic.cn/mmbiz_png/synthetic-fixture/300?wx_fmt=png";
let temp: string;
let entrySource: string;
let bundlePath: string;
let helperBundle: string;

const fixture = `<!doctype html>
<meta charset="utf-8">
<main id="body-editor">正文不得更改</main>
<div class="weui-desktop-dialog" role="dialog">
  <h2>选择图片</h2>
<section class="weui-desktop-img-picker__list"></section>
  <div class="weui-desktop-upload_global-media">
    <input type="file" multiple hidden accept="image/bmp,image/png,image/jpeg,image/jpg,image/gif,image/webp">
  </div>
</div>
<div class="separate-toolbar"><input id="toolbar-file" type="file" multiple accept="image/*"></div>
<script>
  const dialog = document.querySelector('.weui-desktop-dialog');
  const list = dialog.querySelector('.weui-desktop-img-picker__list');
  const input = dialog.querySelector('.weui-desktop-upload_global-media input[type="file"]');
  const bodyBefore = document.querySelector('#body-editor').textContent;
  window.fixtureState = {
    changes: [], bodyBefore, routeChanged: false, createCard: true,
    cardDelayMs: 0, titleDelayMs: 0,
    thumbnailUrl: ${JSON.stringify(thumbnailUrl)},
  };
  const progress = document.createElement('progress');
  progress.max = 100;
  progress.value = 100;
  document.body.append(progress);

  function addCard(name, url) {
    const card = document.createElement('article');
    card.className = 'weui-desktop-img-picker__item';
    const title = document.createElement('span');
    title.className = 'weui-desktop-img-picker__img-title';
    title.textContent = name;
    const thumb = document.createElement('span');
    thumb.className = 'weui-desktop-img-picker__img-thumb';
    thumb.setAttribute('style', 'background-image: url("' + url + '");');
    card.append(title, thumb);
    list.append(card);
    return card;
  }

  input.addEventListener('change', (event) => {
    const files = [...input.files];
    const records = files.map(async (file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      nativeFile: file instanceof File,
      sha256: await crypto.subtle.digest('SHA-256', await file.arrayBuffer()).then((hash) =>
        [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')),
    }));
    window.fixtureState.changes.push({ isTrusted: event.isTrusted, files: records });
    Promise.all(records).then((resolved) => {
      window.fixtureState.lastFiles = resolved;
      if (window.fixtureState.createCard && resolved[0])
        setTimeout(() => {
          const card = addCard(window.fixtureState.titleDelayMs ? '' : resolved[0].name, window.fixtureState.thumbnailUrl);
          if (window.fixtureState.titleDelayMs)
            setTimeout(() => card.querySelector('.weui-desktop-img-picker__img-title').textContent = resolved[0].name, window.fixtureState.titleDelayMs);
        }, window.fixtureState.cardDelayMs);
      input.value = '';
    });
  });

  window.fixtureApi = {
    watchTitleForRouteChange() {
      const observer = new MutationObserver(() => {
        const title = list.querySelector('.weui-desktop-img-picker__img-title');
        if (!title) return;
        observer.disconnect();
        const text = title.textContent;
        Object.defineProperty(title, 'textContent', {
          configurable: true,
          get() {
            window.fixtureState.routeChanged = true;
            return text;
          },
        });
      });
      observer.observe(list, { childList: true, subtree: true });
    },
    suppressCard() { window.fixtureState.createCard = false; },
    delayCard(ms) { window.fixtureState.cardDelayMs = ms; },
    delayTitle(ms) { window.fixtureState.titleDelayMs = ms; },
    useInvalidThumbnail() { window.fixtureState.thumbnailUrl = 'https://example.invalid/not-a-library-image.png'; },
    useNativeSzThumbnail() { window.fixtureState.thumbnailUrl = 'https://mmbiz.qpic.cn/sz_mmbiz_png/native-fixture/300?wx_fmt=png'; },
    bodyState() { return document.querySelector('#body-editor').textContent; },
  };
</script>`;

test.beforeAll(async () => {
  temp = await mkdtemp("/tmp/opencode/mpctl-asset-upload-browser-");
  bundlePath = path.join(temp, "asset-upload.js");
  entrySource = path.join(root, "packages/extension/test/browser/.asset-upload-entry.ts");
  await writeFile(
    entrySource,
    `import { Result } from "better-result";\n` +
      `import { uploadAsset } from ${JSON.stringify(helperSource)};\n` +
      `export { uploadAsset };\n` +
      `export const makeGuard = (isChanged: () => boolean) => () =>\n` +
      `  isChanged() ? Result.err({ code: "route_changed" as const }) : Result.ok(undefined);\n`,
  );
  execFileSync(
    "bun",
    ["build", entrySource, "--target=browser", "--format=esm", `--outfile=${bundlePath}`],
    { cwd: root, stdio: "pipe" },
  );
  helperBundle = await readFile(bundlePath, "utf8");
  console.info(
    `asset-upload source sha256=${createHash("sha256")
      .update(await readFile(helperSource))
      .digest("hex")}`,
    `asset-upload private bundle sha256=${createHash("sha256").update(helperBundle).digest("hex")}`,
  );
});

test.afterAll(async () => {
  await rm(entrySource, { force: true });
  if (temp) await rm(temp, { recursive: true, force: true });
});

async function openFixture() {
  const context = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--no-first-run"],
  });
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === fixtureUrl) {
      await route.fulfill({ status: 200, contentType: "text/html", body: fixture });
    } else if (url === helperUrl) {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: helperBundle });
    } else {
      await route.abort("blockedbyclient");
    }
  });
  await page.goto(fixtureUrl);
  return { context, page };
}

test("production helper dispatches one browser-native File and confirms its library card", async () => {
  test.setTimeout(30_000);
  const { context, page } = await openFixture();

  try {
    const outcome = await page.evaluate(
      async ({ url, bytes, name, type }) => {
        const { uploadAsset, makeGuard } = await import(url);
        const result = await uploadAsset(
          document,
          { blob: new Blob([Uint8Array.from(bytes)], { type }), filename: name, mimeType: type },
          makeGuard(() => false),
          { timeoutMs: 1_000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        return {
          result: result.result,
          effect: result.effect,
          ended: result.ended,
          changes: (
            window as typeof window & { fixtureState: { changes: { isTrusted: boolean }[] } }
          ).fixtureState.changes,
          lastFiles: (window as typeof window & { fixtureState: { lastFiles?: unknown } })
            .fixtureState.lastFiles,
          inputFileCount: document.querySelector<HTMLInputElement>(
            ".weui-desktop-upload_global-media input[type=file]",
          )!.files?.length,
          progress: document.querySelector<HTMLProgressElement>("progress")?.value,
          body: (
            window as typeof window & { fixtureApi: { bodyState(): string } }
          ).fixtureApi.bodyState(),
          selectedCover:
            document.querySelector('[aria-pressed="true"], .is-cover')?.textContent ?? null,
        };
      },
      { url: helperUrl, bytes: fixtureBytes, name: filename, type: mimeType },
    );

    expect(outcome.result, JSON.stringify(outcome)).toMatchObject({ status: "ok" });
    expect(outcome.effect).toEqual({ outcome: "confirmed", filename, thumbnailUrl });
    expect(outcome.ended).toBe(true);
    expect(outcome.changes).toHaveLength(1);
    expect(outcome.lastFiles).toEqual([
      {
        name: filename,
        type: mimeType,
        size: fixtureBytes.length,
        nativeFile: true,
        sha256: fixtureSha256,
      },
    ]);
    expect(outcome.changes[0]?.isTrusted).toBe(false);
    expect(outcome.inputFileCount).toBe(0);
    expect(outcome.progress).toBe(100);
    expect(outcome.body).toBe("正文不得更改");
    expect(outcome.selectedCover).toBeNull();

    const duplicate = await page.evaluate(
      async ({ url, bytes, name, type }) => {
        const { uploadAsset, makeGuard } = await import(url);
        const result = await uploadAsset(
          document,
          { blob: new Blob([Uint8Array.from(bytes)], { type }), filename: name, mimeType: type },
          makeGuard(() => false),
          { timeoutMs: 50 },
        );
        return result.result?.status === "error" ? result.result.error.code : "unexpected_success";
      },
      { url: helperUrl, bytes: fixtureBytes, name: filename, type: mimeType },
    );
    expect(duplicate).toBe("asset_ambiguous");
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { fixtureState: { changes: unknown[] } }).fixtureState.changes
            .length,
      ),
    ).toBe(1);
  } finally {
    await context.close();
  }
});

test("production helper confirms a native sz_mmbiz card and preserves its thumbnail URL", async () => {
  test.setTimeout(30_000);
  const { context, page } = await openFixture();
  const nativeThumbnailUrl = "https://mmbiz.qpic.cn/sz_mmbiz_png/native-fixture/300?wx_fmt=png";

  try {
    await page.evaluate(() =>
      (
        window as typeof window & { fixtureApi: { useNativeSzThumbnail(): void } }
      ).fixtureApi.useNativeSzThumbnail(),
    );
    const outcome = await page.evaluate(
      async ({ url, bytes, name, type }) => {
        const { uploadAsset, makeGuard } = await import(url);
        const result = await uploadAsset(
          document,
          { blob: new Blob([Uint8Array.from(bytes)], { type }), filename: name, mimeType: type },
          makeGuard(() => false),
          { timeoutMs: 1_000 },
        );
        return result;
      },
      { url: helperUrl, bytes: fixtureBytes, name: filename, type: mimeType },
    );

    expect(outcome).toMatchObject({
      effect: { outcome: "confirmed", filename, thumbnailUrl: nativeThumbnailUrl },
      ended: true,
      result: { status: "ok" },
    });
  } finally {
    await context.close();
  }
});

test("waits for a dispatched native card title while preserving browser File identity", async () => {
  test.setTimeout(30_000);
  const { context, page } = await openFixture();
  const nativeThumbnailUrl = "https://mmbiz.qpic.cn/sz_mmbiz_png/native-fixture/300?wx_fmt=png";

  try {
    await page.evaluate(() => {
      const fixtureApi = (
        window as typeof window & {
          fixtureApi: { useNativeSzThumbnail(): void; delayTitle(ms: number): void };
        }
      ).fixtureApi;
      fixtureApi.useNativeSzThumbnail();
      fixtureApi.delayTitle(150);
    });
    const outcome = await page.evaluate(
      async ({ url, bytes, name, type }) => {
        const { uploadAsset, makeGuard } = await import(url);
        const result = await uploadAsset(
          document,
          { blob: new Blob([Uint8Array.from(bytes)], { type }), filename: name, mimeType: type },
          makeGuard(() => false),
          { timeoutMs: 1_000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        const card = document.querySelector(".weui-desktop-img-picker__item");
        return {
          result: result.result,
          effect: result.effect,
          ended: result.ended,
          file: (
            window as typeof window & {
              fixtureState: {
                lastFiles?: { name: string; type: string; size: number; sha256: string }[];
              };
            }
          ).fixtureState.lastFiles?.[0],
          title: card?.querySelector(".weui-desktop-img-picker__img-title")?.textContent,
          body: (
            window as typeof window & { fixtureApi: { bodyState(): string } }
          ).fixtureApi.bodyState(),
        };
      },
      { url: helperUrl, bytes: fixtureBytes, name: filename, type: mimeType },
    );

    expect(outcome).toEqual({
      result: { status: "ok", value: {} },
      effect: { outcome: "confirmed", filename, thumbnailUrl: nativeThumbnailUrl },
      ended: true,
      file: {
        name: filename,
        type: mimeType,
        size: fixtureBytes.length,
        nativeFile: true,
        sha256: fixtureSha256,
      },
      title: filename,
      body: "正文不得更改",
    });
  } finally {
    await context.close();
  }
});

test("progress at 100% without a card times out after one event and does not retry", async () => {
  test.setTimeout(30_000);
  const { context, page } = await openFixture();

  try {
    await page.evaluate(() =>
      (
        window as typeof window & { fixtureApi: { suppressCard(): void } }
      ).fixtureApi.suppressCard(),
    );
    const outcome = await page.evaluate(
      async ({ url, bytes, name, type }) => {
        const { uploadAsset, makeGuard } = await import(url);
        const result = await uploadAsset(
          document,
          { blob: new Blob([Uint8Array.from(bytes)], { type }), filename: name, mimeType: type },
          makeGuard(() => false),
          { timeoutMs: 25 },
        );
        return result.result?.status === "error" ? result.result.error.code : "unexpected_success";
      },
      { url: helperUrl, bytes: fixtureBytes, name: filename, type: mimeType },
    );
    expect(outcome).toBe("asset_upload_unknown");
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { fixtureState: { changes: unknown[] } }).fixtureState.changes
            .length,
      ),
    ).toBe(1);
  } finally {
    await context.close();
  }
});

test("a card arriving after six seconds is confirmed within the scoped remote-call budget", async () => {
  test.setTimeout(30_000);
  const { context, page } = await openFixture();
  try {
    await page.evaluate(() =>
      (
        window as typeof window & { fixtureApi: { delayCard(ms: number): void } }
      ).fixtureApi.delayCard(6_000),
    );
    const outcome = await page.evaluate(
      async ({ url, bytes, name, type }) => {
        const { uploadAsset, makeGuard } = await import(url);
        const result = await uploadAsset(
          document,
          { blob: new Blob([Uint8Array.from(bytes)], { type }), filename: name, mimeType: type },
          makeGuard(() => false),
          { timeoutMs: 9_000 },
        );
        return {
          result,
          changeCount: (window as typeof window & { fixtureState: { changes: unknown[] } })
            .fixtureState.changes.length,
        };
      },
      { url: helperUrl, bytes: fixtureBytes, name: "delayed.png", type: mimeType },
    );
    expect(outcome).toEqual({
      result: {
        effect: { outcome: "confirmed", filename: "delayed.png", thumbnailUrl },
        result: { status: "ok", value: {} },
        ended: true,
      },
      changeCount: 1,
    });
  } finally {
    await context.close();
  }
});

test("a new card with a non-library thumbnail is unknown and is not retried", async () => {
  test.setTimeout(30_000);
  const { context, page } = await openFixture();

  try {
    await page.evaluate(() =>
      (
        window as typeof window & { fixtureApi: { useInvalidThumbnail(): void } }
      ).fixtureApi.useInvalidThumbnail(),
    );
    const outcome = await page.evaluate(
      async ({ url, bytes, name, type }) => {
        const { uploadAsset, makeGuard } = await import(url);
        const result = await uploadAsset(
          document,
          { blob: new Blob([Uint8Array.from(bytes)], { type }), filename: name, mimeType: type },
          makeGuard(() => false),
          { timeoutMs: 50 },
        );
        return result.result?.status === "error" ? result.result.error.code : "unexpected_success";
      },
      { url: helperUrl, bytes: fixtureBytes, name: filename, type: mimeType },
    );
    expect(outcome).toBe("asset_upload_unknown");
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { fixtureState: { changes: unknown[] } }).fixtureState.changes
            .length,
      ),
    ).toBe(1);
  } finally {
    await context.close();
  }
});

test("route change while reading the created card returns unknown after the single event", async () => {
  test.setTimeout(30_000);
  const { context, page } = await openFixture();

  try {
    await page.evaluate(() =>
      (
        window as typeof window & { fixtureApi: { watchTitleForRouteChange(): void } }
      ).fixtureApi.watchTitleForRouteChange(),
    );
    const outcome = await page.evaluate(
      async ({ url, bytes, name, type }) => {
        const { uploadAsset, makeGuard } = await import(url);
        const result = await uploadAsset(
          document,
          { blob: new Blob([Uint8Array.from(bytes)], { type }), filename: name, mimeType: type },
          makeGuard(
            () =>
              (window as typeof window & { fixtureState: { routeChanged: boolean } }).fixtureState
                .routeChanged,
          ),
          { timeoutMs: 100 },
        );
        return result.result?.status === "error" ? result.result.error.code : "unexpected_success";
      },
      { url: helperUrl, bytes: fixtureBytes, name: filename, type: mimeType },
    );
    expect(outcome).toBe("asset_upload_unknown");
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { fixtureState: { changes: unknown[] } }).fixtureState.changes
            .length,
      ),
    ).toBe(1);
  } finally {
    await context.close();
  }
});
