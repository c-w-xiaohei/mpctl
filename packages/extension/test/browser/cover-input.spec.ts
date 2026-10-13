import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const sourcePath = path.join(root, "packages/extension/src/mp/cover-input.ts");
const fixtureOrigin = "https://cover-input.test";
const fixtureUrl = `${fixtureOrigin}/fixture`;
const moduleUrl = `${fixtureOrigin}/cover-input.js`;
const qpicUrl = "https://mmbiz.qpic.cn/mmbiz_png/fixture/0";
const qpicPng = createPng(640, 360);
const pngHash = createHash("sha256").update(qpicPng).digest("hex");
const html = `<!doctype html>
<meta charset="utf-8">
<style>
  #js_cover_area { width: 440px; height: 240px; }
  .js_cover_preview_new,.js_cover_preview_square { width: 200px; height: 100px; }
  .weui-desktop-dialog { border: 1px solid; padding: 12px; }
  .weui-desktop-img-picker__item { display: inline-block; width: 110px; height: 80px; margin: 4px; }
  .weui-desktop-img-picker__item.selected { outline: 2px solid blue; }
  .weui-desktop-img-picker__img-thumb { width: 80px; height: 45px; background-size: cover; }
  .crop-img { width: 320px; height: 180px; }
  #crop[hidden], #library[hidden] { display:none }
</style>
<div id="js_cover_area">
  <div class="js_cover_preview_new" style='background-image:url("https://mmbiz.qpic.cn/mmbiz_png/baseline/0")'></div>
  <div class="js_cover_preview_square" style="display:none;background-image:none"></div>
</div>
<div id="library" class="weui-desktop-dialog" role="dialog">
  <div>选择图片</div>
  <div class="weui-desktop-img-picker__item"><div class="weui-desktop-img-picker__img-title">cover.png</div><div class="weui-desktop-img-picker__img-thumb" style='background-image:url("https://mmbiz.qpic.cn/mmbiz_png/other/300")'></div></div>
  <div class="weui-desktop-img-picker__item"><div class="weui-desktop-img-picker__img-title">cover.png</div><div class="weui-desktop-img-picker__img-thumb" style='background-image:url("https://mmbiz.qpic.cn/mmbiz_png/fixture/300")'></div></div>
  <button id="next">下一步</button><button id="cancel">取消</button><button class="weui-desktop-dialog__close-btn" aria-label="关闭"></button>
</div>
<div id="crop" class="weui-desktop-dialog" role="dialog" hidden>
  <div>编辑封面</div><img class="crop-img" src="${qpicUrl}">
  <button>上一步</button><button id="confirm">确认</button><button hidden>取消</button><button class="weui-desktop-dialog__close-btn" aria-label="关闭"></button>
</div>
<div contenteditable="true" id="body">正文固定</div>
<script>
  window.caseState = { selectedClicks: 0, selectedClassVerified: false, confirms: 0, cleanupClicks: 0, body: document.querySelector('#body').innerHTML };
  const library = document.querySelector('#library');
  const crop = document.querySelector('#crop');
  document.querySelectorAll('.weui-desktop-img-picker__item').forEach(card => card.addEventListener('click', () => {
    window.caseState.selectedClicks++;
    document.querySelectorAll('.weui-desktop-img-picker__item').forEach(item => item.classList.remove('selected'));
    card.classList.add('selected');
    window.caseState.selectedClassVerified = card.classList.contains('selected');
  }));
  document.querySelector('#next').addEventListener('click', () => { library.remove(); crop.hidden = false; });
  document.querySelector('#cancel').addEventListener('click', () => {
    window.caseState.cleanupClicks++;
    if (window.caseState.cancelThrows) throw new Error('fixture cancel handler failure');
    if (window.caseState.cancelLeavesOpen) return;
    library.remove();
  });
  document.querySelector('#confirm').addEventListener('click', () => {
    window.caseState.confirms++;
    setTimeout(() => { document.querySelector('.js_cover_preview_new').style.backgroundImage = 'url("https://mmbiz.qpic.cn/mmbiz_png/fixture/0")'; }, 30);
    setTimeout(() => { crop.remove(); }, 15);
  });
</script>`;

let tempDir: string;
let bundle: string;
let bundleHash: string;

test.beforeAll(async () => {
  tempDir = await mkdtemp("/tmp/opencode/mpctl-cover-input-browser-");
  const output = path.join(tempDir, "cover-input.js");
  const entry = path.join(tempDir, "entry.ts");
  const resultModule = path.resolve(
    root,
    "packages/extension/node_modules/better-result/dist/index.mjs",
  );
  await writeFile(
    entry,
    `export { selectArticleCoverFromLibrary } from ${JSON.stringify(sourcePath)};\nexport { Result } from ${JSON.stringify(resultModule)};\n`,
  );
  const sourceHash = createHash("sha256")
    .update(await readFile(sourcePath))
    .digest("hex");
  execFileSync("bun", ["build", entry, "--target=browser", "--format=esm", `--outfile=${output}`], {
    cwd: root,
    stdio: "pipe",
  });
  bundle = await readFile(output, "utf8");
  bundleHash = createHash("sha256").update(bundle).digest("hex");
  console.info(`cover-input source sha256=${sourceHash} bundle sha256=${bundleHash}`);
  console.info(`local fixture PNG sha256=${pngHash}`);
});

test.afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function openFixture() {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMEEXEC ??
      process.env.MPCTL_CHROMIUM_EXECUTABLE ??
      "/home/c_w_xiaohei/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome",
    args: ["--no-sandbox", "--no-first-run"],
  });
  const page = await browser.newPage();
  const outsideRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === fixtureUrl)
      await route.fulfill({ status: 200, contentType: "text/html", body: html });
    else if (url === moduleUrl)
      await route.fulfill({ status: 200, contentType: "text/javascript", body: bundle });
    else if (url.startsWith("https://mmbiz.qpic.cn/"))
      await route.fulfill({ status: 200, contentType: "image/png", body: qpicPng });
    else {
      outsideRequests.push(url);
      await route.abort("blockedbyclient");
    }
  });
  await page.goto(fixtureUrl);
  await expect(page.locator(".crop-img")).toHaveJSProperty("complete", true);
  await expect
    .poll(() => page.locator(".crop-img").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(640);
  return { browser, page, outsideRequests };
}

const exactCandidate = {
  filename: "cover.png",
  thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/fixture/300",
};

test("real Chromium DOM selects exact thumbnail and confirms once after delayed detached-crop preview", async () => {
  const { browser, page, outsideRequests } = await openFixture();
  try {
    const actual = await page.evaluate(
      async ({ moduleUrl, candidate }) => {
        const { Result, selectArticleCoverFromLibrary } = await import(moduleUrl);
        const beforeBody = document.querySelector("#body")!.innerHTML;
        const image = document.querySelector<HTMLImageElement>(".crop-img")!;
        const result = await selectArticleCoverFromLibrary(
          document,
          candidate,
          () => Result.ok(undefined),
          { timeoutMs: 500 },
        );
        return {
          code: result.result?.status,
          effect: result.effect,
          ended: result.ended,
          hash: "coverHash" in result.effect ? result.effect.coverHash : result.result,
          sourceLoaded: image.complete && image.naturalWidth === 640 && image.naturalHeight === 360,
          cropRemoved: !document.querySelector("#crop"),
          selection: document.querySelectorAll(".weui-desktop-img-picker__item.selected").length,
          state: (window as typeof window & { caseState: Record<string, unknown> }).caseState,
          bodyUnchanged: document.querySelector("#body")!.innerHTML === beforeBody,
        };
      },
      { moduleUrl, candidate: exactCandidate },
    );
    expect(actual.code).toBe("ok");
    expect(actual.effect.outcome).toBe("confirmed");
    expect(actual.ended).toBe(true);
    expect(actual.sourceLoaded).toBe(true);
    expect(actual.cropRemoved).toBe(true);
    expect(actual.state).toMatchObject({
      selectedClicks: 1,
      selectedClassVerified: true,
      confirms: 1,
    });
    expect(actual.bodyUnchanged).toBe(true);
    expect(outsideRequests).toEqual([]);
  } finally {
    await browser.close();
  }
});

function createPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("native cancel throw preserves the selection-stage guard error and never confirms", async () => {
  const { browser, page } = await openFixture();
  try {
    const actual = await page.evaluate(
      async ({ moduleUrl, candidate }) => {
        const { Result, selectArticleCoverFromLibrary } = await import(moduleUrl);
        (window as typeof window & { caseState: Record<string, unknown> }).caseState.cancelThrows =
          true;
        let guards = 0;
        const result = await selectArticleCoverFromLibrary(document, candidate, () => {
          guards++;
          if (guards === 5) return Result.err({ code: "route_changed" });
          return Result.ok(undefined);
        });
        return {
          result: result.result,
          state: (window as typeof window & { caseState: Record<string, unknown> }).caseState,
        };
      },
      { moduleUrl, candidate: exactCandidate },
    );
    expect(actual.result).toMatchObject({
      status: "error",
      error: { code: "route_changed", cleanup: { code: "cleanup_failed" } },
    });
    expect(actual.state).toMatchObject({ confirms: 0 });
  } finally {
    await browser.close();
  }
});

test("same-asset fresh confirmation accepts an unchanged preview hash", async () => {
  const { browser, page } = await openFixture();
  try {
    const actual = await page.evaluate(
      async ({ moduleUrl, candidate }) => {
        const { Result, selectArticleCoverFromLibrary } = await import(moduleUrl);
        const original =
          document.querySelector<HTMLElement>(".js_cover_preview_new")!.style.backgroundImage;
        document.querySelector("#confirm")!.addEventListener(
          "click",
          () => {
            setTimeout(() => {
              document.querySelector<HTMLElement>(".js_cover_preview_new")!.style.backgroundImage =
                original;
            }, 30);
          },
          { once: true },
        );
        const result = await selectArticleCoverFromLibrary(
          document,
          candidate,
          () => Result.ok(undefined),
          { timeoutMs: 500 },
        );
        return {
          status: result.result?.status,
          effect: result.effect.outcome,
          ended: result.ended,
          confirms: (window as typeof window & { caseState: { confirms: number } }).caseState
            .confirms,
        };
      },
      { moduleUrl, candidate: exactCandidate },
    );
    expect(actual).toEqual({ status: "ok", effect: "confirmed", ended: true, confirms: 1 });
  } finally {
    await browser.close();
  }
});
