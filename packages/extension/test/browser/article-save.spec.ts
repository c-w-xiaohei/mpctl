import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare global {
  interface Window {
    nativeSaveFixture: {
      nativeClicks: number;
      launcherClicks: number;
      events: string[];
      before: { body: string; fields: string; cover: string };
    };
  }
}

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const extension = path.join(root, "packages/extension");
const helperSource = path.join(extension, "src/mp/article-save.ts");
const fixtureUrl = "https://article-save.test/fixture";
const helperUrl = "https://article-save.test/article-save.js";
const executableCandidates = [
  process.env.MPCTL_CHROMIUM_EXECUTABLE,
  "/home/c_w_xiaohei/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome",
].filter((candidate): candidate is string => Boolean(candidate));

let temporaryDirectory: string;
let helperBundle: string;
let executablePath: string;

const fixture = `<!doctype html>
<meta charset="utf-8">
<style>
  [hidden] { display: none !important; }
  button, a { display: inline-block; min-width: 24px; min-height: 24px; }
  .appmsg_history_new { display: block; }
  article, input, textarea, .cover { display: block; }
  #history_pop[hidden] { display: none; }
</style>
<main id="editor">
  <input id="title" value="fixture title">
  <textarea id="summary">fixture summary</textarea>
  <article id="body"><p>fixture body <strong>unchanged</strong></p></article>
  <div class="cover" data-cover="fixture-cover"></div>
  <div id="js_editor_history_bar" class="appmsg_history_container">
    <div id="history_bt" class="appmsg_history_new"><p>历史版本</p></div>
  </div>
  <table id="unrelated-table"><tbody><tr><td>not history</td></tr></tbody></table>
  <div id="history-portal-host"></div>
  <button id="draft-save">保存为草稿</button><button>预览</button><button>发表</button>
</main>
<script>
  const scenario = new URL(location.href).searchParams.get('scenario') || 'fresh';
  const launcher = document.querySelector('#history_bt');
  let portal = null;
  let table = null;
  const makePortal = () => {
    portal = document.createElement('div');
    portal.id = 'history_pop';
    portal.className = 'appmsg_history_popup history_overflow_auto';
    table = document.createElement('table');
    table.id = 'history-table';
    table.className = 'appmsg_history_table';
    const headerTime = scenario === 'bad-header' ? '错误时间' : '操作时间';
    table.innerHTML = '<tbody><tr class="appmsg_history_tr">' +
      '<td class="appmsg_history_time">' + headerTime + '</td><td class="appmsg_history_author">操作人</td>' +
      '<td class="appmsg_history_source">来源</td><td class="appmsg_history_opr">操作</td></tr>' +
      '<tr class="appmsg_history_tr"><td class="appmsg_history_time">10-03 17:11</td>' +
      '<td class="appmsg_history_author">operator</td><td class="appmsg_history_source">网页版</td>' +
      '<td class="appmsg_history_opr">手动保存</td></tr></tbody>';
    portal.append(table);
    document.querySelector('#history-portal-host').append(portal);
    if (scenario === 'duplicate-table') portal.append(table.cloneNode(true));
    if (scenario === 'duplicate-portal') {
      const duplicate = portal.cloneNode(true);
      document.querySelector('#history-portal-host').append(duplicate);
    }
  };
  const button = document.querySelector('#draft-save');
  const body = document.querySelector('#body');
  const title = document.querySelector('#title');
  const summary = document.querySelector('#summary');
  const cover = document.querySelector('.cover');
  window.nativeSaveFixture = {
    nativeClicks: 0,
    launcherClicks: 0,
    portalRemounted: false,
    events: [],
    before: { body: body.innerHTML, fields: title.value + '|' + summary.value, cover: cover.dataset.cover },
  };
  launcher.addEventListener('click', () => {
    const state = window.nativeSaveFixture;
    state.launcherClicks++;
    if (scenario === 'cleanup-fails' && state.nativeClicks && state.launcherClicks >= 3) {
      state.events.push('cleanup-blocked');
      return;
    }
    if (!portal || !portal.isConnected) {
      if (scenario === 'delayed-portal') setTimeout(makePortal, 25);
      else makePortal();
      if (scenario === 'portal-remount-on-collapse' && state.nativeClicks)
        state.portalRemounted = true;
    }
    else if (portal.hidden) portal.hidden = false;
    else if (
      scenario === 'portal-remount-on-collapse' &&
      state.nativeClicks &&
      !state.portalRemounted
    ) {
      portal.remove();
      makePortal();
      state.portalRemounted = true;
    } else portal.hidden = true;
    state.events.push(portal?.hidden ? 'history-hidden' : 'history-shown');
  });
  button.addEventListener('click', () => {
    const state = window.nativeSaveFixture;
    state.nativeClicks++;
    state.events.push('native-save');
    if (scenario === 'portal-remount-on-collapse') portal.remove();
    else portal.hidden = true;
    if (scenario !== 'old-row') {
      setTimeout(() => {
        const activeTable = document.querySelector("#history_pop table.appmsg_history_table");
        if (!activeTable) return;
        const row = activeTable.tBodies[0].insertRow();
        row.className = 'appmsg_history_tr';
        for (const [className, text] of [
          ['appmsg_history_time', '10-03 17:12'],
          ['appmsg_history_author', 'operator'],
          ['appmsg_history_source', '网页版'],
          ['appmsg_history_opr', '手动保存'],
        ]) {
          const cell = row.insertCell();
          cell.className = className;
          cell.textContent = text;
        }
      }, 15);
    }
  });
</script>`;

test.beforeAll(async () => {
  executablePath = (await firstExisting(executableCandidates)) ?? "";
  if (!executablePath)
    throw new Error("No installed Chromium 1200 found; set MPCTL_CHROMIUM_EXECUTABLE");
  temporaryDirectory = await mkdtemp("/tmp/opencode/mpctl-article-save-browser-");
  await symlink(
    path.join(extension, "node_modules"),
    path.join(temporaryDirectory, "node_modules"),
  );
  const entry = path.join(temporaryDirectory, "entry.ts");
  const bundlePath = path.join(temporaryDirectory, "article-save.js");
  await writeFile(
    entry,
    `import { Result } from "better-result";\n` +
      `import { saveArticle } from ${JSON.stringify(helperSource)};\n` +
      `export { Result, saveArticle };\n`,
  );
  execFileSync(
    "bun",
    ["build", entry, "--target=browser", "--format=esm", `--outfile=${bundlePath}`],
    {
      cwd: root,
      stdio: "pipe",
    },
  );
  helperBundle = await readFile(bundlePath, "utf8");
  const sourceHash = createHash("sha256")
    .update(await readFile(helperSource))
    .digest("hex");
  const bundleHash = createHash("sha256").update(helperBundle).digest("hex");
  console.info(`article-save source sha256=${sourceHash} private bundle sha256=${bundleHash}`);
});

test.afterAll(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

async function firstExisting(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next explicit local browser candidate.
    }
  }
  return undefined;
}

async function openFixture(
  scenario = "fresh",
): Promise<{ browser: Browser; page: Page; blocked: string[] }> {
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--no-first-run"],
  });
  const page = await browser.newPage();
  const blocked: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === fixtureUrl || url.startsWith(`${fixtureUrl}?`))
      await route.fulfill({ status: 200, contentType: "text/html", body: fixture });
    else if (url === helperUrl)
      await route.fulfill({ status: 200, contentType: "text/javascript", body: helperBundle });
    else {
      blocked.push(url);
      await route.abort("blockedbyclient");
    }
  });
  await page.goto(`${fixtureUrl}?scenario=${scenario}`);
  return { browser, page, blocked };
}

async function runSave(page: Page, timeoutMs = 250) {
  return page.evaluate(
    async ({ url, timeout }) => {
      const { Result, saveArticle } = await import(url);
      const bodyBefore = document.querySelector("#body")!.innerHTML;
      const result = await saveArticle(document, () => Result.ok(undefined), {
        timeoutMs: timeout,
        pollIntervalMs: 5,
      });
      const state = window.nativeSaveFixture;
      return {
        result: result.result,
        effect: result.effect,
        ended: result.ended,
        nativeClicks: state.nativeClicks,
        launcherClicks: state.launcherClicks,
        events: state.events,
        historyHidden: document.querySelector<HTMLElement>("#history_pop")?.hidden ?? true,
        rows: document.querySelectorAll("#history-table tr.appmsg_history_tr").length,
        bodyUnchanged: bodyBefore === document.querySelector("#body")!.innerHTML,
        contentUnchanged:
          state.before.body === document.querySelector("#body")!.innerHTML &&
          state.before.fields ===
            document.querySelector<HTMLInputElement>("#title")!.value +
              "|" +
              document.querySelector<HTMLTextAreaElement>("#summary")!.value &&
          state.before.cover === document.querySelector<HTMLElement>(".cover")!.dataset.cover,
      };
    },
    { url: helperUrl, timeout: timeoutMs },
  );
}

test("real Chromium DOM confirms delayed identical history after native collapse without mutating content", async () => {
  const { browser, page, blocked } = await openFixture();
  try {
    const actualDom = await page.evaluate(() => {
      const historyInitiallyHidden = document.querySelector("#history_pop") === null;
      document.querySelector<HTMLElement>("#history_bt")!.click();
      const row = document.querySelector("#history-table tr.appmsg_history_tr")!;
      const cells = [...row.querySelectorAll(":scope > td")];
      return {
        tableClosest: row.closest("table")?.id,
        scopeCellCount: cells.length,
        cellClasses: cells.map((cell) => cell.className),
        historyInitiallyHidden,
        exactSaveButtonCount: [...document.querySelectorAll("button")].filter(
          (button) => button.textContent?.trim() === "保存为草稿",
        ).length,
      };
    });
    expect(actualDom).toEqual({
      tableClosest: "history-table",
      scopeCellCount: 4,
      cellClasses: [
        "appmsg_history_time",
        "appmsg_history_author",
        "appmsg_history_source",
        "appmsg_history_opr",
      ],
      historyInitiallyHidden: true,
      exactSaveButtonCount: 1,
    });
    await page.locator("#history_bt").click();
    await page.evaluate(() => {
      window.nativeSaveFixture.launcherClicks = 0;
      window.nativeSaveFixture.events.length = 0;
    });

    const outcome = await runSave(page);
    expect(outcome).toMatchObject({
      result: { status: "ok" },
      effect: { outcome: "confirmed" },
      ended: true,
      nativeClicks: 1,
      launcherClicks: 3,
      events: ["history-shown", "native-save", "history-shown", "history-hidden"],
      historyHidden: true,
      rows: 3,
      bodyUnchanged: true,
      contentUnchanged: true,
    });
    expect(blocked).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("preserves an initially open history view when native save collapses it", async () => {
  const { browser, page } = await openFixture();
  try {
    await page.locator("#history_bt").click();
    const outcome = await runSave(page);
    expect(outcome).toMatchObject({
      result: { status: "ok" },
      effect: { outcome: "confirmed" },
      ended: true,
      nativeClicks: 1,
      launcherClicks: 2,
      events: ["history-shown", "native-save", "history-shown"],
      historyHidden: false,
      rows: 3,
      bodyUnchanged: true,
      contentUnchanged: true,
    });
  } finally {
    await browser.close();
  }
});

test("old history times out after one native click; invalid options and bad guard do not click", async () => {
  const { browser, page } = await openFixture("old-row");
  try {
    const timeout = await runSave(page, 35);
    expect(timeout).toMatchObject({
      result: { status: "error", error: { code: "save_unknown" } },
      nativeClicks: 1,
      rows: 2,
      historyHidden: true,
      bodyUnchanged: true,
      contentUnchanged: true,
    });

    const noClick = await page.evaluate(async (url) => {
      const { Result, saveArticle } = await import(url);
      const state = window.nativeSaveFixture;
      const before = { clicks: state.nativeClicks, launcher: state.launcherClicks };
      const invalid = await saveArticle(document, () => Result.ok(undefined), {
        timeoutMs: Number.NaN,
      });
      const badGuard = await saveArticle(document, () =>
        Result.err({ code: "target_lost" as const }),
      );
      return {
        invalid:
          invalid.result?.status === "error" ? invalid.result.error.code : "unexpected_success",
        badGuard:
          badGuard.result?.status === "error" ? badGuard.result.error.code : "unexpected_success",
        additionalNativeClicks: state.nativeClicks - before.clicks,
        additionalLauncherClicks: state.launcherClicks - before.launcher,
      };
    }, helperUrl);
    expect(noClick).toEqual({
      invalid: "page_failed",
      badGuard: "target_unavailable",
      additionalNativeClicks: 0,
      additionalLauncherClicks: 0,
    });
  } finally {
    await browser.close();
  }
});

test("cleanup failure retains only the observed fresh-save stage fact", async () => {
  const { browser, page } = await openFixture("cleanup-fails");
  try {
    const outcome = await runSave(page);
    expect(outcome).toMatchObject({
      result: {
        status: "error",
        error: { code: "cleanup_failed", cleanup: { code: "cleanup_failed" } },
      },
      effect: { outcome: "confirmed", persistence: "unverified" },
      ended: false,
      nativeClicks: 1,
      launcherClicks: 3,
      events: ["history-shown", "native-save", "history-shown", "cleanup-blocked"],
      historyHidden: false,
      rows: 3,
      bodyUnchanged: true,
      contentUnchanged: true,
    });
  } finally {
    await browser.close();
  }
});

test("waits for lazy portal and refuses malformed or ambiguous portal snapshots before save", async () => {
  const { browser, page } = await openFixture("delayed-portal");
  try {
    const delayed = await runSave(page);
    expect(delayed).toMatchObject({
      result: { status: "ok" },
      effect: { outcome: "confirmed" },
      ended: true,
      nativeClicks: 1,
    });
  } finally {
    await browser.close();
  }

  for (const scenario of ["bad-header", "duplicate-table", "duplicate-portal"]) {
    const fixtureCase = await openFixture(scenario);
    try {
      const refused = await runSave(fixtureCase.page, 45);
      expect(refused).toMatchObject({
        result: { status: "error", error: { code: "history_unavailable" } },
        nativeClicks: 0,
      });
    } finally {
      await fixtureCase.browser.close();
    }
  }
});

test("accepts only the same native portal identity when save removes and remounts history", async () => {
  const { browser, page } = await openFixture("portal-remount-on-collapse");
  try {
    const outcome = await runSave(page);
    expect(outcome).toMatchObject({
      result: { status: "ok" },
      effect: { outcome: "confirmed" },
      ended: true,
      nativeClicks: 1,
      launcherClicks: 3,
      historyHidden: true,
    });
  } finally {
    await browser.close();
  }
});
