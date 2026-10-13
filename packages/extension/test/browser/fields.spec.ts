import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

let temp: string;
let bundle: string;
test.use({
  launchOptions: { executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] },
});
test.beforeAll(async () => {
  temp = await mkdtemp("/tmp/opencode/mpctl-fields-");
  const output = path.join(temp, "fields.js");
  execFileSync("bun", [
    "build",
    "test/browser/fixtures/fields-dom.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${output}`,
  ]);
  bundle = await readFile(output, "utf8");
});
test.afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

test("R1 fields lost actual Nexus reply recovers original receipt through status without MAIN or native reads", async ({
  page,
}) => {
  await page.route("**/*", (route) =>
    route.request().url().endsWith("fields.js")
      ? route.fulfill({ contentType: "text/javascript", body: bundle })
      : route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: '<!doctype html><div contenteditable="true" data-placeholder="请在这里输入标题">Title</div><input id="author" name="author" value="Old"><textarea id="js_description" name="digest">Old summary</textarea>',
        }),
  );
  await page.goto(
    "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
  );
  const result = await page.evaluate(async () => {
    const url = "https://mp.weixin.qq.com/fields.js";
    const module = await import(url);
    const f = await module.lostFieldsReplyFixture(document);
    try {
      const input = {
        operationId: module.createOperationId(f.operations.ledgerId),
        article: f.article.article,
        fields: { author: "New" },
        expectedHash: (
          await module.hashArticleFields({
            title: "Title",
            author: "Old",
            summary: "Old summary",
          })
        ).unwrap(),
      };
      const first = await f.workspace.updateArticleFields(input);
      const before = { ...f.counts };
      await f.stopMain();
      const status = await f.workspace.getOperation(input.operationId);
      const repeated = await f.workspace.updateArticleFields(input);
      return {
        first,
        status,
        repeated,
        before,
        after: f.counts,
        author: document.querySelector<HTMLInputElement>("#author")!.value,
      };
    } finally {
      f.close();
    }
  });
  expect(result.first).toMatchObject({
    status: "ok",
    value: {
      snapshot: {
        operation: "fields",
        state: "unresolved",
        effect: { outcome: "unknown", attempted: [] },
      },
    },
  });
  expect(result.status).toMatchObject({
    status: "ok",
    value: {
      snapshot: {
        state: "settled",
        effect: {
          outcome: "confirmed",
          attempted: ["author"],
          confirmed: ["author"],
          unknown: [],
        },
        result: { status: "ok" },
      },
    },
  });
  expect(result.status.value.issue).toBeUndefined();
  expect(result.repeated).toEqual(result.status);
  expect(result.before).toEqual({
    ready: 1,
    get: 1,
    set: 0,
    fieldInput: 1,
    fieldChange: 1,
    dropped: 1,
  });
  expect(result.after).toEqual(result.before);
  expect(result.author).toBe("New");
});

for (const mode of [
  "title",
  "setter",
  "input",
  "mirror",
  "hash",
  "route",
  "late-mirror",
  "replacement",
  "held-guard",
  "held-route",
  "mirror-replaced",
  "mirror-removed",
  "initial-no-mirror",
] as const) {
  test(`B-F2/B-F3/K3/V2 DOM fields ${mode}: retains first facts, duplicates do not dispatch and status does not read`, async ({
    page,
  }) => {
    await page.route("**/*", (route) =>
      route.request().url().endsWith("fields.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: '<!doctype html><div contenteditable="true" data-placeholder="请在这里输入标题">Title</div><input id="title" type="hidden" value="Title"><input id="author" name="author" value="Old"><textarea id="js_description" name="digest">Old summary</textarea>',
          }),
    );
    await page.goto(
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
    );
    const result = await page.evaluate(async (mode) => {
      const moduleUrl = "https://mp.weixin.qq.com/fields.js";
      const module = await import(moduleUrl);
      const title = document.querySelector('[contenteditable="true"]') as HTMLElement;
      const mirror = document.querySelector("#title") as HTMLInputElement;
      const author = document.querySelector("#author") as HTMLInputElement;
      const summary = document.querySelector("#js_description") as HTMLTextAreaElement;
      if (mode === "initial-no-mirror") mirror.remove();
      let releaseMirror: (() => void) | undefined;
      const counts = { title: 0, author: 0, input: 0, change: 0, summary: 0 };
      let titleReached!: () => void;
      const atTitle = new Promise<void>((done) => {
        titleReached = done;
      });
      let valid = true;
      title.addEventListener("input", () => {
        counts.title++;
        titleReached();
        if (mode === "held-guard" || mode === "held-route") {
          releaseMirror = () => {
            mirror.value = title.innerText;
          };
          if (mode === "held-guard") valid = false;
          else history.replaceState({}, "", "/cgi-bin/home");
        } else if (mode === "mirror-replaced") {
          const clone = mirror.cloneNode() as HTMLInputElement;
          clone.value = title.innerText;
          mirror.replaceWith(clone);
        } else if (mode === "mirror-removed") mirror.remove();
        else if (mode === "late-mirror")
          setTimeout(() => {
            mirror.value = title.innerText;
          }, 40);
        else if (mode !== "mirror") mirror.value = title.innerText;
        if (mode === "route") history.replaceState({}, "", "/cgi-bin/home");
      });
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
      Object.defineProperty(HTMLInputElement.prototype, "value", {
        ...native,
        set(value) {
          native.set!.call(this, value);
          if (this === author) {
            counts.author++;
            if (mode === "setter" || mode === "late-mirror") valid = false;
          }
        },
      });
      author.addEventListener("input", () => {
        counts.input++;
        if (mode === "input") valid = false;
        if (mode === "replacement") author.replaceWith(author.cloneNode(true));
      });
      author.addEventListener("change", () => {
        counts.change++;
      });
      summary.addEventListener("input", () => {
        counts.summary++;
      });
      const service = module.createArticleFieldsService(document, () => {
        if (mode === "title" && counts.title && mirror.value === "New title") valid = false;
        return valid;
      });
      const identity = await service.identity();
      const execution = {
        operationId: module.createOperationId(crypto.randomUUID()),
        executorId: identity.value.executorId,
      };
      const hash = (
        await module.hashArticleFields({ title: "Title", author: "Old", summary: "Old summary" })
      ).unwrap();
      const fields = { title: "New title", author: "New", summary: "New summary" };
      const digest = crypto.subtle.digest;
      let digestCalls = 0;
      if (mode === "hash")
        crypto.subtle.digest = async (...args) => {
          if (++digestCalls === 3) throw new Error("actual final hash failure");
          return digest.apply(crypto.subtle, args);
        };
      try {
        const task = service.updateArticleFields(fields, hash, execution);
        let running;
        if (mode === "late-mirror") {
          await atTitle;
          running = await service.getReceipt(execution.operationId);
        }
        const first = await task;
        const pendingMirror =
          (mode === "held-guard" || mode === "held-route") && mirror.value === "Title";
        releaseMirror?.();
        const before = { ...counts };
        valid = false;
        const repeated = await service.updateArticleFields(fields, hash, execution);
        const receipt = await service.getReceipt(execution.operationId);
        const replaced = module.createArticleFieldsService(document, () => true);
        const replacement = await replaced.updateArticleFields(fields, hash, execution);
        return {
          first,
          pendingMirror,
          running,
          repeated,
          receipt,
          replacement,
          before,
          counts,
          values: {
            title: title.innerText,
            mirror: mirror.value,
            author: author.value,
            summary: summary.value,
          },
        };
      } finally {
        Object.defineProperty(HTMLInputElement.prototype, "value", native);
        crypto.subtle.digest = digest;
      }
    }, mode);
    expect(result.first.status).toBe("ok");
    expect(result.repeated).toEqual(result.first);
    expect(result.receipt).toEqual(result.first);
    expect(result.replacement).toMatchObject({
      status: "error",
      error: { code: "executor_mismatch" },
    });
    expect(result.counts).toEqual(result.before);
    console.log("fields boundary", mode, JSON.stringify(result.first.value));
    const effect = result.first.value.effect;
    if (["held-guard", "held-route", "mirror-replaced", "mirror-removed"].includes(mode)) {
      expect(result.first.value.ended).toBe(false);
      expect(effect).toMatchObject({ attempted: ["title"], confirmed: [], unknown: ["title"] });
      expect(result.counts).toEqual({ title: 1, author: 0, input: 0, change: 0, summary: 0 });
      expect(result.first.value.result).toMatchObject({
        status: "error",
        error: {
          cause: {
            code:
              mode === "held-guard"
                ? "target_unavailable"
                : mode === "held-route"
                  ? "route_changed"
                  : "title_update_unknown",
          },
        },
      });
      if (mode === "held-guard" || mode === "held-route") {
        expect(result.pendingMirror).toBe(true);
        expect(result.values.mirror).toBe("New title");
      }
      return;
    }
    if (mode === "initial-no-mirror") {
      expect(result.first.value.ended).toBe(true);
      expect(effect).toMatchObject({
        outcome: "confirmed",
        attempted: ["title", "author", "summary"],
        confirmed: ["title", "author", "summary"],
        unknown: [],
      });
      expect(result.counts).toEqual({ title: 1, author: 1, input: 1, change: 1, summary: 1 });
      return;
    }
    // Guard/route loss after title dispatch is not mirror-end evidence.
    expect(result.first.value.ended).toBe(!["mirror", "title", "route"].includes(mode));
    if (mode === "late-mirror")
      expect(result.running).toMatchObject({
        status: "ok",
        value: {
          ended: false,
          effect: { outcome: "unknown", attempted: ["title"], confirmed: [], unknown: ["title"] },
        },
      });
    expect(effect.requested).toEqual(["title", "author", "summary"]);
    if (mode === "title" || mode === "mirror" || mode === "route") {
      expect(result.counts).toEqual({ title: 1, author: 0, input: 0, change: 0, summary: 0 });
      expect(effect.attempted).toEqual(["title"]);
      expect(effect.confirmed).toEqual([]);
      expect(effect.unknown).toEqual(["title"]);
      expect(result.values.author).toBe("Old");
      expect(result.values.summary).toBe("Old summary");
    } else if (
      mode === "setter" ||
      mode === "input" ||
      mode === "late-mirror" ||
      mode === "replacement"
    ) {
      expect(result.counts).toEqual({
        title: 1,
        author: 1,
        input: mode === "input" || mode === "replacement" ? 1 : 0,
        change: 0,
        summary: 0,
      });
      expect(effect.confirmed).toEqual(["title"]);
      expect(effect.attempted).toEqual(["title", "author"]);
      expect(effect.unknown).toEqual(["author"]);
      expect(result.values.summary).toBe("Old summary");
    } else {
      expect(result.counts).toEqual({ title: 1, author: 1, input: 1, change: 1, summary: 1 });
      expect(effect.confirmed).toEqual(["title", "author", "summary"]);
      expect(effect.unknown).toEqual([]);
      expect(effect.fieldsHash).toBeUndefined();
    }
    expect(result.first.value.result).toMatchObject({
      status: "error",
      error: {
        code:
          mode === "mirror"
            ? "field_update_unknown"
            : mode === "hash"
              ? "hash_failed"
              : mode === "route"
                ? "route_changed"
                : mode === "replacement"
                  ? "fields_unavailable"
                  : "target_unavailable",
      },
    });
  });
}
