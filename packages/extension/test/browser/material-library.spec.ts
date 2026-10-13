import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare global {
  interface Window {
    nativeFixture: { events: string[]; bodyBefore: string };
  }
}

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const helperSource = path.join(root, "packages/extension/src/mp/material-library.ts");
const fixtureUrl = "https://material-library.test/fixture";
const helperUrl = "https://material-library.test/material-library.js";
const executableCandidates = [
  process.env.MPCTL_CHROMIUM_EXECUTABLE,
  "/home/c_w_xiaohei/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome",
].filter((candidate): candidate is string => Boolean(candidate));
const bodyText = "正文必须保持原样";
let temp: string;
let helperBundle: string;
let executablePath: string;

const fixture = `<!doctype html>
<meta charset="utf-8">
<style>
  [hidden] { display: none !important; }
  li, button { display: inline-block; min-width: 20px; min-height: 20px; }
  .weui-desktop-dialog { position: fixed; inset: 15% 15%; background: white; border: 1px solid; }
</style>
<ul><li id="js_editor_insertimage"><button class="insert-image">插入图片</button>
  <div class="dropdown" hidden><button class="js_img_from_local">从图片库选择</button></div>
</li></ul>
<article id="body">${bodyText}</article>
<script>
  const menu = document.querySelector('#js_editor_insertimage');
  const dropdown = menu.querySelector('.dropdown');
  window.nativeFixture = { events: [], bodyBefore: document.querySelector('#body').innerHTML };
  menu.addEventListener('click', (event) => {
    if (event.target.closest('.js_img_from_local')) {
      window.nativeFixture.events.push('library-choice');
      const dialog = document.createElement('section');
      dialog.className = 'weui-desktop-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML = '<h2>选择图片</h2><div class="weui-desktop-img-picker__list"></div>' +
        '<button class="weui-desktop-dialog__close-btn" aria-label="关闭">×</button>' +
        '<footer><button>确定</button><button>取消</button></footer>';
      document.body.append(dialog);
      dialog.addEventListener('click', (buttonEvent) => {
        if (buttonEvent.target.closest('button')?.textContent.trim() === '取消') {
          window.nativeFixture.events.push('cancel');
          dialog.remove();
        }
      });
      return;
    }
    if (!event.target.closest('.js_img_from_local')) {
      window.nativeFixture.events.push('menu');
      dropdown.hidden = !dropdown.hidden;
    }
  });
</script>`;

test.beforeAll(async () => {
  executablePath = (await firstExisting(executableCandidates)) ?? "";
  if (!executablePath) throw new Error("No Chromium found; set MPCTL_CHROMIUM_EXECUTABLE");
  temp = await mkdtemp("/tmp/opencode/mpctl-material-library-browser-");
  await symlink(
    path.join(root, "packages/extension/node_modules"),
    path.join(temp, "node_modules"),
  );
  const entrySource = path.join(temp, "entry.ts");
  const bundlePath = path.join(temp, "material-library.js");
  await writeFile(
    entrySource,
    `import { Result } from "better-result";\n` +
      `import { openMaterialLibrary, closeMaterialLibrary } from ${JSON.stringify(helperSource)};\n` +
      `export { Result, openMaterialLibrary, closeMaterialLibrary };\n` +
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
    `material-library source sha256=${createHash("sha256")
      .update(await readFile(helperSource))
      .digest("hex")}`,
    `private bundle sha256=${createHash("sha256").update(helperBundle).digest("hex")}`,
  );
});

test.afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

async function firstExisting(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next explicit candidate.
    }
  }
  return undefined;
}

async function openFixture() {
  const context = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--no-first-run"],
  });
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === fixtureUrl)
      await route.fulfill({ status: 200, contentType: "text/html", body: fixture });
    else if (url === helperUrl)
      await route.fulfill({ status: 200, contentType: "text/javascript", body: helperBundle });
    else await route.abort("blockedbyclient");
  });
  await page.goto(fixtureUrl);
  return { context, page };
}

test("opens the native-shaped image library and cancels without changing article bytes", async () => {
  const { context, page } = await openFixture();
  try {
    const opened = await page.evaluate(async (url) => {
      const { Result, openMaterialLibrary, makeGuard } = await import(url);
      const result = await openMaterialLibrary(
        document,
        makeGuard(() => false),
        { timeoutMs: 500 },
      );
      return {
        isError: Result.isError(result),
        code: Result.isError(result) ? result.error.code : undefined,
        opened: Result.isError(result) ? undefined : result.value.opened,
        dialog: Result.isError(result) ? undefined : result.value.dialog.outerHTML,
        events: window.nativeFixture.events,
        bodyBefore: window.nativeFixture.bodyBefore,
        bodyAfter: document.querySelector("#body")!.innerHTML,
        assignedFiles: document.querySelectorAll('input[type="file"]').length,
        titleTextNodes: (() => {
          const nodes: string[] = [];
          const dialog = document.querySelector(".weui-desktop-dialog");
          if (!dialog) return nodes;
          const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const value = walker.currentNode.textContent?.trim();
            if (value) nodes.push(value);
          }
          return nodes;
        })(),
      };
    }, helperUrl);
    expect(opened).toMatchObject({
      isError: false,
      opened: true,
      events: ["menu", "library-choice"],
    });
    expect(opened.dialog).toContain("weui-desktop-dialog__close-btn");
    expect(opened.titleTextNodes).toContain("选择图片");
    expect(opened.assignedFiles).toBe(0);
    expect(opened.bodyAfter).toBe(opened.bodyBefore);

    const cancelled = await page.evaluate(async (url) => {
      const { Result, openMaterialLibrary, closeMaterialLibrary, makeGuard } = await import(url);
      const result = await openMaterialLibrary(
        document,
        makeGuard(() => false),
        { timeoutMs: 500 },
      );
      if (Result.isError(result)) return { openedError: result.error.code };
      const cleanup = await closeMaterialLibrary(
        document,
        result.value.dialog,
        makeGuard(() => false),
        { timeoutMs: 500 },
      );
      return {
        openedError: undefined,
        cleanupError: Result.isError(cleanup) ? cleanup.error.code : undefined,
        events: window.nativeFixture.events,
        remainingDialogs: document.querySelectorAll(".weui-desktop-dialog").length,
        bodyBefore: window.nativeFixture.bodyBefore,
        bodyAfter: document.querySelector("#body")!.innerHTML,
      };
    }, helperUrl);
    expect(cancelled).toMatchObject({
      openedError: undefined,
      cleanupError: undefined,
      events: ["menu", "library-choice", "cancel"],
      remainingDialogs: 0,
    });
    expect(cancelled.bodyAfter).toBe(cancelled.bodyBefore);
  } finally {
    await context.close();
  }
});

test("reuses an already-owned open dialog without clicking menu or cancelling it", async () => {
  const { context, page } = await openFixture();
  try {
    const outcome = await page.evaluate(async (url) => {
      const { Result, openMaterialLibrary, makeGuard } = await import(url);
      const first = await openMaterialLibrary(
        document,
        makeGuard(() => false),
        { timeoutMs: 500 },
      );
      if (Result.isError(first)) return { error: first.error.code };
      const second = await openMaterialLibrary(
        document,
        makeGuard(() => false),
        { timeoutMs: 500 },
      );
      return {
        error: Result.isError(second) ? second.error.code : undefined,
        opened: Result.isError(second) ? undefined : second.value.opened,
        sameDialog: !Result.isError(second) && second.value.dialog === first.value.dialog,
        events: window.nativeFixture.events,
      };
    }, helperUrl);
    expect(outcome).toEqual({
      error: undefined,
      opened: false,
      sameDialog: true,
      events: ["menu", "library-choice"],
    });
  } finally {
    await context.close();
  }
});

test("rejects a cover-action dialog and an otherwise valid dialog with an extra footer action", async () => {
  const { context, page } = await openFixture();
  try {
    const codes = await page.evaluate(async (url) => {
      const { Result, openMaterialLibrary, makeGuard } = await import(url);
      const cover = document.createElement("section");
      cover.className = "weui-desktop-dialog";
      cover.innerHTML =
        '<h2>设置封面 下一步</h2><button class="weui-desktop-dialog__close-btn">×</button><button>确定</button><button>取消</button>';
      document.body.append(cover);
      const coverResult = await openMaterialLibrary(
        document,
        makeGuard(() => false),
        { timeoutMs: 200 },
      );
      cover.remove();

      const extra = document.createElement("section");
      extra.className = "weui-desktop-dialog";
      extra.innerHTML =
        '<h2>选择图片</h2><button class="weui-desktop-dialog__close-btn">×</button><button>确定</button><button>取消</button><button>删除</button>';
      document.body.append(extra);
      const extraResult = await openMaterialLibrary(
        document,
        makeGuard(() => false),
        { timeoutMs: 200 },
      );
      return {
        cover: Result.isError(coverResult) ? coverResult.error.code : "unexpected_success",
        extra: Result.isError(extraResult) ? extraResult.error.code : "unexpected_success",
        events: window.nativeFixture.events,
      };
    }, helperUrl);
    expect(codes).toEqual({ cover: "dialog_unavailable", extra: "dialog_unavailable", events: [] });
  } finally {
    await context.close();
  }
});

test("stops before library-choice dispatch when the route guard changes after the menu opens", async () => {
  const { context, page } = await openFixture();
  try {
    const outcome = await page.evaluate(async (url) => {
      const { Result, openMaterialLibrary, makeGuard } = await import(url);
      let changed = false;
      const menu = document.querySelector("#js_editor_insertimage")!;
      menu.addEventListener(
        "click",
        (event) => {
          if (event.target instanceof Element && event.target.closest("#js_editor_insertimage"))
            changed = true;
        },
        { once: true },
      );
      const result = await openMaterialLibrary(
        document,
        makeGuard(() => changed),
        { timeoutMs: 250 },
      );
      return {
        result: Result.isError(result)
          ? { kind: "error", code: result.error.code }
          : { kind: "ok", opened: result.value.opened },
        events: window.nativeFixture.events,
        dialogs: document.querySelectorAll(".weui-desktop-dialog").length,
      };
    }, helperUrl);
    expect(outcome).toEqual({
      result: { kind: "error", code: "route_changed" },
      events: ["menu"],
      dialogs: 0,
    });
  } finally {
    await context.close();
  }
});

test("does not cancel a replacement dialog after a different dialog replaces the owned one", async () => {
  const { context, page } = await openFixture();
  try {
    const outcome = await page.evaluate(async (url) => {
      const { Result, openMaterialLibrary, closeMaterialLibrary, makeGuard } = await import(url);
      const opened = await openMaterialLibrary(
        document,
        makeGuard(() => false),
        { timeoutMs: 500 },
      );
      if (Result.isError(opened)) return { openError: opened.error.code };
      const replacement = document.createElement("section");
      replacement.className = "weui-desktop-dialog";
      replacement.innerHTML =
        '<h2>选择图片</h2><button class="weui-desktop-dialog__close-btn">×</button><button>确定</button><button>取消</button>';
      opened.value.dialog.replaceWith(replacement);
      const result = await closeMaterialLibrary(
        document,
        opened.value.dialog,
        makeGuard(() => false),
        { timeoutMs: 200 },
      );
      return {
        openError: undefined,
        cleanup: Result.isError(result) ? result.error.code : "unexpected_success",
        replacementConnected: replacement.isConnected,
        events: window.nativeFixture.events,
      };
    }, helperUrl);
    expect(outcome).toEqual({
      openError: undefined,
      cleanup: "cleanup_failed",
      replacementConnected: true,
      events: ["menu", "library-choice"],
    });
  } finally {
    await context.close();
  }
});
