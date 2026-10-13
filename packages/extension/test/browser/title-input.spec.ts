import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const helperSource = path.join(root, "packages/extension/src/mp/title-input.ts");
const fixtureUrl = "https://title-input.test/fixture";
const helperUrl = "https://title-input.test/title-input.js";
const executablePath =
  process.env.CHROMEEXEC ??
  process.env.MPCTL_CHROMIUM_EXECUTABLE ??
  "/home/c_w_xiaohei/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome";
let temp: string;
let bundlePath: string;
let helperBundle: string;
let sourceHash: string;

const fixture = `<!doctype html>
<meta charset="utf-8">
<style>
  #title-editor { min-height: 2em; }
  #title { display: none; }
</style>
<div id="title-editor" contenteditable="true" data-placeholder="请在这里输入标题">原始标题</div>
<textarea id="title" hidden>原始标题</textarea>
<div id="body-editor" contenteditable="true" tabindex="-1">正文不得更改</div>
<script>
  const title = document.querySelector('#title-editor');
  const mirror = document.querySelector('#title');
  title.addEventListener('focus', () => {
    const text = title.textContent;
    title.replaceChildren(document.createTextNode(text));
  });
  title.addEventListener('input', () => { setTimeout(() => { mirror.value = title.innerText; }, 25); });
  window.fixtureState = { inputEvents: 0 };
  title.addEventListener('input', () => { window.fixtureState.inputEvents++; });
</script>`;

test.beforeAll(async () => {
  temp = await mkdtemp("/tmp/opencode/mpctl-title-input-browser-");
  bundlePath = path.join(temp, "title-input.js");
  sourceHash = createHash("sha256")
    .update(await readFile(helperSource))
    .digest("hex");
  execFileSync(
    "bun",
    ["build", helperSource, "--target=browser", "--format=esm", `--outfile=${bundlePath}`],
    { cwd: root, stdio: "pipe" },
  );
  helperBundle = await readFile(bundlePath, "utf8");
  console.info(
    `title-input source sha256=${sourceHash}`,
    `title-input bundle sha256=${createHash("sha256").update(helperBundle).digest("hex")}`,
  );
});

test.afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

test("production title helper uses native browser editing and leaves the body untouched", async () => {
  test.setTimeout(30_000);
  let context: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    context = await chromium.launch({
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

    const outcome = await page.evaluate(async (url) => {
      const { writeTitleInput } = await import(url);
      const title = document.querySelector<HTMLElement>("#title-editor")!;
      const mirror = document.querySelector<HTMLTextAreaElement>("#title")!;
      const body = document.querySelector<HTMLElement>("#body-editor")!;
      const result = await writeTitleInput(document, "标题 — 你好 🌱");
      return {
        result:
          result.status === "error" ? { error: result.error.code } : { title: result.value.title },
        title: title.innerText,
        mirror: mirror.value,
        body: body.innerText,
        activeIsTitle: document.activeElement === title,
        inputEvents: (window as typeof window & { fixtureState: { inputEvents: number } })
          .fixtureState.inputEvents,
      };
    }, helperUrl);

    expect(outcome).toEqual({
      result: { title: "标题 — 你好 🌱" },
      title: "标题 — 你好 🌱",
      mirror: "标题 — 你好 🌱",
      body: "正文不得更改",
      activeIsTitle: true,
      inputEvents: 1,
    });

    const emptyTitle = await page.evaluate(async (url) => {
      const { writeTitleInput } = await import(url);
      const result = await writeTitleInput(document, "");
      const title = document.querySelector<HTMLElement>("#title-editor")!;
      const mirror = document.querySelector<HTMLTextAreaElement>("#title")!;
      return {
        result:
          result.status === "error" ? { error: result.error.code } : { title: result.value.title },
        titleText: title.innerText,
        textContent: title.textContent,
        mirror: mirror.value,
      };
    }, helperUrl);
    expect(["", "\n"]).toContain(emptyTitle.result.title);
    expect(["", "\n"]).toContain(emptyTitle.titleText);
    expect(["", "\n"]).toContain(emptyTitle.textContent);
    expect(emptyTitle.mirror).toBe("");
  } finally {
    await context?.close();
  }
});

test("production title helper rejects focus or selection redirected into the body", async () => {
  test.setTimeout(30_000);
  let context: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    context = await chromium.launch({
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

    for (const redirect of ["focus", "selection"] as const) {
      await page.evaluate((kind) => {
        const title = document.querySelector<HTMLElement>("#title-editor")!;
        const body = document.querySelector<HTMLElement>("#body-editor")!;
        title.innerText = "原始标题";
        document.querySelector<HTMLTextAreaElement>("#title")!.value = "原始标题";
        const selection = document.getSelection()!;
        const addRange = selection.addRange.bind(selection);
        if (kind === "focus") {
          Object.defineProperty(selection, "addRange", {
            configurable: true,
            value: (range: Range) => {
              addRange(range);
              body.focus();
            },
          });
        } else {
          Object.defineProperty(selection, "addRange", {
            configurable: true,
            value: (range: Range) => {
              addRange(range);
              const bodyRange = document.createRange();
              bodyRange.selectNodeContents(body);
              selection.removeAllRanges();
              addRange(bodyRange);
            },
          });
        }
      }, redirect);

      const outcome = await page.evaluate(
        async ({ url }) => {
          const { writeTitleInput } = await import(url);
          const body = document.querySelector<HTMLElement>("#body-editor")!;
          const result = await writeTitleInput(document, "被拒绝的标题");
          return {
            result: result.status === "error" ? result.error.code : "ok",
            title: document.querySelector<HTMLElement>("#title-editor")!.innerText,
            body: body.innerText,
            inputEvents: (window as typeof window & { fixtureState: { inputEvents: number } })
              .fixtureState.inputEvents,
          };
        },
        { url: helperUrl, kind: redirect },
      );
      expect(outcome.result, `${redirect} redirect: ${JSON.stringify(outcome)}`).toBe(
        "page_failed",
      );
      expect(outcome.title).toBe("原始标题");
      expect(outcome.body).toBe("正文不得更改");
      expect(outcome.inputEvents).toBe(0);
    }
  } finally {
    await context?.close();
  }
});

test("creates the title range after focus handlers replace title child nodes", async () => {
  test.setTimeout(30_000);
  let context: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    context = await chromium.launch({
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

    const outcome = await page.evaluate(async (url) => {
      const { writeTitleInput } = await import(url);
      const title = document.querySelector<HTMLElement>("#title-editor")!;
      const body = document.querySelector<HTMLElement>("#body-editor")!;
      let selectedBeforeCommand = "";
      const execCommand = document.execCommand.bind(document);
      document.execCommand = (command, showUI, value) => {
        selectedBeforeCommand = document.getSelection()?.toString() ?? "";
        return execCommand(command, showUI, value);
      };
      const result = await writeTitleInput(document, "Replace whole title 🌱");
      return {
        result: result.status === "error" ? result.error.code : result.value.title,
        title: title.innerText,
        selectedBeforeCommand,
        body: body.innerText,
      };
    }, helperUrl);

    expect(outcome).toEqual({
      result: "Replace whole title 🌱",
      title: "Replace whole title 🌱",
      selectedBeforeCommand: "原始标题",
      body: "正文不得更改",
    });
  } finally {
    await context?.close();
  }
});

test("title failure boundaries never edit the body or retry a native command", async () => {
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url() === helperUrl
        ? route.fulfill({ contentType: "text/javascript", body: helperBundle })
        : route.fulfill({ contentType: "text/html", body: fixture }),
    );
    for (const mode of [
      "unsupported",
      "invalid",
      "guard",
      "hidden",
      "ambiguous",
      "false",
      "throw",
      "timeout",
      "mirror-changed",
    ]) {
      await page.goto(fixtureUrl);
      const result = await page.evaluate(
        async ({ url, mode }) => {
          const { writeTitleInput, canWriteTitleInput } = await import(url);
          const title = document.querySelector<HTMLElement>("#title-editor")!;
          const mirror = document.querySelector<HTMLTextAreaElement>("#title")!;
          let commands = 0;
          const exec = document.execCommand.bind(document);
          document.execCommand = (command, ui, value) => {
            commands++;
            if (mode === "false") return false;
            if (mode === "throw") throw new Error("native command lost");
            return exec(command, ui, value);
          };
          if (mode === "unsupported") document.queryCommandSupported = () => false;
          if (mode === "hidden") title.hidden = true;
          if (mode === "ambiguous") title.after(title.cloneNode(true));
          if (mode === "mirror-changed")
            title.addEventListener("input", () => {
              mirror.value = "different";
            });
          const before = canWriteTitleInput(document);
          const outcome = await writeTitleInput(
            document,
            mode === "invalid" ? "a\nb" : "New title",
            mode === "guard"
              ? () => ({ status: "error", error: { code: "route_changed" } })
              : undefined,
            { timeoutMs: 0 },
          );
          return {
            before,
            outcome,
            commands,
            body: document.querySelector("#body-editor")!.textContent,
          };
        },
        { url: helperUrl, mode },
      );
      expect(result.body).toBe("正文不得更改");
      expect(result.outcome.status).toBe("error");
      const invoked = ["false", "throw", "timeout", "mirror-changed"].includes(mode);
      expect(result.commands).toBe(invoked ? 1 : 0);
      expect(result.outcome.error.code).toBe(
        invoked
          ? "title_update_unknown"
          : mode === "unsupported"
            ? "unsupported"
            : mode === "invalid"
              ? "invalid_title"
              : mode === "guard"
                ? "route_changed"
                : "fields_unavailable",
      );
      if (invoked) expect(result.outcome.error.ended).toBe(false);
      if (mode === "unsupported") expect(result.before).toBe("unsupported");
    }
  } finally {
    await browser.close();
  }
});
