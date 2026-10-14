import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

let temp: string;
let bundle: string;
let html: string;
let jsapi: string;
let editorBundle: string;
test.beforeAll(async () => {
  temp = await mkdtemp("/tmp/opencode/mpctl-cover-save-");
  const output = path.join(temp, "provider.js");
  execFileSync("bun", [
    "build",
    "entrypoints/mp.content.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${output}`,
  ]);
  bundle = await readFile(output, "utf8");
  const editorOutput = path.join(temp, "editor.js");
  execFileSync("bun", [
    "build",
    "src/mp/jsapi.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${editorOutput}`,
  ]);
  editorBundle = await readFile(editorOutput, "utf8");
  html = await readFile("test/browser/fixtures/bridge/index.html", "utf8");
  jsapi = await readFile("test/browser/fixtures/bridge/jsapi.js", "utf8");
});

test("native document coordination survives editor replacement and isolates independent documents", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => {
      if (route.request().url().endsWith("/editor.js"))
        return route.fulfill({ contentType: "text/javascript", body: editorBundle });
      if (route.request().url().endsWith("/provider.js"))
        return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (route.request().url().includes("jsapi.js"))
        return route.fulfill({ contentType: "text/javascript", body: jsapi });
      return route.fulfill({ contentType: "text/html", body: html });
    });
    await page.goto(
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=fixture&token=synthetic",
    );
    const result = await page.evaluate(async () => {
      const url = "https://mp.weixin.qq.com/editor.js";
      const { createEditorService } = await import(url);
      const providerUrl = "https://mp.weixin.qq.com/provider.js";
      const { createArticleCoverPageService } = await import(providerUrl);
      const digest = async (text: string) =>
        [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      const body =
        '<img class="rich_pages wxw-img" data-src="https://mmbiz.qpic.cn/mmbiz_png/fixture/0" data-imgfileid="123" data-type="png" data-ratio="0.5" data-w="640">';
      const hash = await digest(body);
      const coverHash = (await createArticleCoverPageService(document, () => true).read()).value;
      const callbacks: Array<() => void> = [];
      let nativeCalls = 0;
      const makeEditor = (target: Document, hold: boolean) =>
        createEditorService({
          document: target,
          timeoutMs: 15,
          invoke(request: any) {
            if (request.apiName === "mp_editor_get_isready")
              request.sucCb({ isReady: true, isNew: true });
            else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: body });
            else {
              nativeCalls++;
              if (hold) callbacks.push(() => request.sucCb({}));
              else request.sucCb({});
            }
          },
        });
      const first = makeEditor(document, true);
      const originalId = (await first.ready()).value.executorId;
      const cover = await first.setCoverFromBody({
        operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        executorId: originalId,
        bodyImage: 1,
        expectedBodyHash: hash,
        expectedCoverHash: coverHash,
      });
      const replacement = makeEditor(document, true);
      const replacementId = (await replacement.ready()).value.executorId;
      const input = () => ({
        operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        executorId: replacementId,
      });
      const blocked = await replacement.setContent(body, hash, input());
      const staleInstance = await replacement.setContent(body, hash, {
        ...input(),
        executorId: originalId,
      });
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const independent = makeEditor(frame.contentDocument!, false);
      const independentResult = await independent.setContent(body, hash, {
        operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        executorId: (await independent.ready()).value.executorId,
      });
      const beforeRelease = nativeCalls;
      callbacks[0]!();
      const next = await replacement.setContent(body, hash, input());
      // A duplicate late callback from the prior owner cannot free this native write.
      callbacks[0]!();
      const stillBlocked = await replacement.setContent(body, hash, input());
      callbacks[1]!();
      const finalEditor = makeEditor(document, false);
      const final = await finalEditor.setContent(body, hash, {
        operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        executorId: (await finalEditor.ready()).value.executorId,
      });
      return {
        cover,
        blocked,
        staleInstance,
        independentResult,
        beforeRelease,
        next,
        stillBlocked,
        final,
        nativeCalls,
      };
    });
    expect(result.cover).toMatchObject({
      status: "ok",
      value: { ended: false, effect: { outcome: "unknown" } },
    });
    expect(result.blocked).toMatchObject({
      status: "ok",
      value: {
        effect: { outcome: "not_dispatched" },
        result: { status: "error", error: { code: "operation_blocked" } },
      },
    });
    expect(result.staleInstance).toMatchObject({
      status: "error",
      error: { code: "executor_mismatch" },
    });
    expect(result.independentResult).toMatchObject({
      status: "ok",
      value: { result: { status: "ok" } },
    });
    expect(result.beforeRelease).toBe(2);
    expect(result.next).toMatchObject({
      status: "ok",
      value: { ended: false, effect: { outcome: "unknown" } },
    });
    expect(result.stillBlocked).toMatchObject({
      status: "ok",
      value: { result: { status: "error", error: { code: "operation_blocked" } } },
    });
    expect(result.final).toMatchObject({ status: "ok", value: { result: { status: "ok" } } });
    expect(result.nativeCalls).toBe(4);
  } finally {
    await browser.close();
  }
});

for (const mode of [
  "success",
  "same-cover",
  "stale-body",
  "stale-cover",
  "index",
  "malformed",
  "metadata",
  "src-only",
  "separator",
  "unsupported-route",
  "body-drift",
  "fields-drift",
  "guard-cover-drift",
  "guard-body-drift",
  "target-loss",
  "invalid-preview",
  "timeout",
  "err",
  "throw",
  "success-throw",
  "err-throw",
  "throw-late",
  "err-during-readback",
  "err-success",
  "success-err",
  "late",
] as const) {
  test(`body image cover MAIN ${mode} uses inert native BODY and original receipt`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.endsWith("/editor.js"))
          return route.fulfill({ contentType: "text/javascript", body: editorBundle });
        if (url.endsWith("/provider.js"))
          return route.fulfill({ contentType: "text/javascript", body: bundle });
        if (url.includes("jsapi.js"))
          return route.fulfill({ contentType: "text/javascript", body: jsapi });
        if (url.startsWith("https://mp.weixin.qq.com/cgi-bin/appmsg"))
          return route.fulfill({ contentType: "text/html", body: html });
        return route.abort();
      });
      await page.goto(
        "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=fixture-group-1&token=synthetic-context",
      );
      const result = await page.evaluate(async (mode) => {
        const editorUrl = "https://mp.weixin.qq.com/editor.js",
          providerUrl = "https://mp.weixin.qq.com/provider.js";
        const { createEditorService } = await import(editorUrl);
        const { createArticleCoverPageService } = await import(providerUrl);
        const source =
          "https://mmbiz.qpic.cn/mmbiz_png/synthetic-body-original/0?wx_fmt=png&from=synthetic";
        let body = `<p>synthetic正文</p><img class="separator" data-type="separator"><img class="rich_pages wxw-img" data-src="${source.replace(/&/g, "&amp;")}" data-imgfileid="123" data-type="png" data-ratio="0.5625" data-w="640">`;
        if (mode === "malformed")
          body = body.replace("mmbiz.qpic.cn", "mmbiz.qpic.cn.evil.invalid");
        if (mode === "src-only") body = body.replace("data-src=", "src=");
        if (mode === "metadata") body = body.replace('data-w="640"', 'data-w="bad"');
        if (mode === "separator")
          body = '<img class="separator" data-src="https://mmbiz.qpic.cn/mmbiz_png/separator/0">';
        const digest = async (text: string) =>
          [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
            .map((x) => x.toString(16).padStart(2, "0"))
            .join("");
        const provider = createArticleCoverPageService(document, () => true);
        const beforeCover = (await provider.read()).value;
        if (mode === "unsupported-route")
          history.replaceState(null, "", "/cgi-bin/appmsg?action=edit&type=10");
        const expectedBodyHash = await digest(body);
        const fieldsBefore = [
          document.querySelector<HTMLElement>('[data-placeholder="请在这里输入标题"]')!.innerText,
          (document.querySelector("#author") as HTMLInputElement).value,
          (document.querySelector("#js_description") as HTMLTextAreaElement).value,
        ];
        let gets = 0;
        const native: Array<{ apiName: string; apiParam: unknown }> = [];
        let callback: (() => void) | undefined;
        let errorCallback: (() => void) | undefined;
        const editor = createEditorService({
          document,
          timeoutMs: 20,
          validateTarget: () => mode !== "target-loss" || gets < 2,
          invoke(request: any) {
            if (request.apiName === "mp_editor_get_isready")
              return request.sucCb({ isReady: true, isNew: true });
            if (request.apiName === "mp_editor_get_content") {
              gets++;
              if (mode === "err-during-readback" && gets === 3) {
                errorCallback?.();
                request.errCb({ opaque: "readback failure after native callback error" });
                return;
              }
              if (mode === "guard-cover-drift" && gets === 2)
                document.querySelector<HTMLElement>(
                  ".js_cover_preview_new",
                )!.style.backgroundImage = 'url("https://mmbiz.qpic.cn/mmbiz_png/drift/0")';
              if (mode === "guard-body-drift" && gets === 2) body += "<p>pre-dispatch drift</p>";
              return request.sucCb({ content: body });
            }
            native.push({ apiName: request.apiName, apiParam: request.apiParam });
            callback = () => request.sucCb({});
            errorCallback = () => request.errCb({ opaque: true });
            if (mode === "timeout" || mode === "late") return;
            if (mode === "throw" || mode === "throw-late")
              throw new Error("private raw native payload must not escape");
            if (mode === "err-throw") {
              request.errCb({ opaque: true });
              throw new Error("private raw native payload must not escape");
            }
            if (mode === "err" || mode === "err-success") {
              request.errCb({ raw: "https://private.invalid/secret" });
              if (mode === "err-success") request.sucCb({});
              return;
            }
            if (mode === "success-err") {
              request.sucCb({});
              request.errCb({ opaque: true });
              return;
            }
            if (mode !== "same-cover")
              document.querySelector<HTMLElement>(".js_cover_preview_new")!.style.backgroundImage =
                `url("${source}")`; // Synthetic preview mutation, not platform acceptance.
            if (mode === "body-drift") body += "<p>unwanted body change</p>";
            if (mode === "fields-drift")
              (document.querySelector("#author") as HTMLInputElement).value = "changed";
            if (mode === "invalid-preview")
              document.querySelector<HTMLElement>(".js_cover_preview_new")!.style.backgroundImage =
                'url("https://unsupported.invalid/preview")';
            request.sucCb({});
            if (mode === "success-throw")
              throw new Error("private raw native payload must not escape");
          },
        });
        const executorId = (await editor.ready()).value.executorId;
        const input = {
          operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
          executorId,
          bodyImage: mode === "index" ? 2 : 1,
          expectedBodyHash: mode === "stale-body" ? "a".repeat(64) : expectedBodyHash,
          expectedCoverHash: mode === "stale-cover" ? "b".repeat(64) : beforeCover,
        };
        const task = editor.setCoverFromBody(input);
        const duplicate = editor.setCoverFromBody(input);
        const conflict = await editor.setCoverFromBody({
          ...input,
          bodyImage: input.bodyImage + 1,
        });
        const first = await task;
        const repeated = await duplicate;
        const getCount = gets;
        const firstSnapshot = structuredClone(first);
        if (mode === "late" || mode === "throw-late") callback?.();
        const receipt = await editor.getCoverReceipt(input.operationId);
        const repeatAfter = await editor.setCoverFromBody(input);
        return {
          source,
          input,
          first: firstSnapshot,
          repeated,
          repeatAfter,
          receipt,
          conflict,
          native,
          getCount,
          gets,
          fieldsBefore,
          fieldsAfter: [
            document.querySelector<HTMLElement>('[data-placeholder="请在这里输入标题"]')!.innerText,
            (document.querySelector("#author") as HTMLInputElement).value,
            (document.querySelector("#js_description") as HTMLTextAreaElement).value,
          ],
        };
      }, mode);
      expect(result.conflict).toMatchObject({
        status: "error",
        error: { code: "operation_conflict" },
      });
      expect(result.first).toMatchObject({
        status: "ok",
        value: { operationId: result.input.operationId, executorId: result.input.executorId },
      });
      const notDispatched = [
        "stale-body",
        "stale-cover",
        "index",
        "malformed",
        "metadata",
        "src-only",
        "separator",
        "unsupported-route",
        "guard-cover-drift",
        "guard-body-drift",
        "target-loss",
      ].includes(mode);
      expect(result.native).toHaveLength(notDispatched ? 0 : 1);
      if (!notDispatched)
        expect(result.native[0]).toEqual({
          apiName: "mp_editor_change_cover",
          apiParam: { oriImgUrl: result.source },
        });
      expect(result.gets).toBe(result.getCount); // Original receipt and same-key replay are API-free.
      if (mode === "success" || mode === "same-cover") {
        expect(result.first.value).toMatchObject({
          ended: true,
          effect: { cover: true, outcome: "confirmed" },
          result: { status: "ok" },
        });
        expect(result.fieldsAfter).toEqual(result.fieldsBefore);
        if (mode === "same-cover")
          expect(result.first.value.effect.coverHash).toBe(result.input.expectedCoverHash);
      } else {
        expect(result.first.value).toMatchObject({
          effect: { outcome: notDispatched ? "not_dispatched" : "unknown" },
          result: { status: "error" },
        });
        if (["timeout", "late", "err", "throw", "err-throw", "throw-late"].includes(mode))
          expect(result.first.value.ended).toBe(false);
        else expect(result.first.value.ended).toBe(true);
        if (mode === "late" || mode === "throw-late") {
          expect(result.receipt.value.ended).toBe(true);
          expect(result.receipt.value.result).toEqual(result.first.value.result);
        }
        if (["success-throw", "throw-late", "err-throw"].includes(mode)) {
          expect(result.first.value.result.error).toMatchObject({
            code: "cover_update_unknown",
            cause:
              mode === "err-throw"
                ? { at: "main.jsapi_callback", code: "opaque_callback_error" }
                : { at: "main.execution", code: "native_invoke_threw" },
          });
          expect(result.getCount).toBe(2); // A native-boundary failure never enters readback.
          expect(result.receipt.value.result).toEqual(result.first.value.result);
          expect(result.repeatAfter.value).toEqual(result.receipt.value);
        }
        if (mode === "err-during-readback")
          expect(result.first.value.result.error).toMatchObject({
            code: "cover_update_unknown",
            cause: { at: "main.jsapi_callback", code: "opaque_callback_error" },
          });
        expect(JSON.stringify(result.first)).not.toContain("private.invalid");
      }
    } finally {
      await browser.close();
    }
  });
}
test.afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

for (const operation of ["cover", "save"] as const) {
  test(`B-C1/B-S1/V3 ${operation} actual provider occupies key before first await and rejects replacement`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", async (route) => {
        const url = route.request().url();
        if (url.endsWith("/provider.js"))
          return route.fulfill({ contentType: "text/javascript", body: bundle });
        if (url.includes("jsapi.js"))
          return route.fulfill({ contentType: "text/javascript", body: jsapi });
        if (url.startsWith("https://mmbiz.qpic.cn/"))
          return route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK0sAAAAASUVORK5CYII=",
              "base64",
            ),
          });
        if (url.startsWith("https://mp.weixin.qq.com/cgi-bin/appmsg"))
          return route.fulfill({ contentType: "text/html", body: html });
        return route.abort();
      });
      await page.goto(
        "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=fixture-group-1&token=synthetic-context",
      );
      const result = await page.evaluate(async (operation) => {
        const moduleUrl = "https://mp.weixin.qq.com/provider.js";
        const { createArticleCoverPageService } = await import(moduleUrl);
        let valid = true;
        const provider = createArticleCoverPageService(document, () => valid);
        const identity = (await provider.identity()).value;
        const id = `op:${crypto.randomUUID()}:${crypto.randomUUID()}`;
        const candidate = {
          filename: "existing.png",
          thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/existing/300",
        };
        const expected = (await provider.read()).value;
        const execution =
          operation === "cover"
            ? { operationId: id, executorId: identity.executorId, asset: "original" }
            : {
                operationId: id,
                executorId: identity.executorId,
                expectedBodyHash: "a".repeat(64),
                expectedFieldsHash: "b".repeat(64),
                expectedCoverHash: expected,
              };
        // Key occupation is tested while asynchronous hash is pending, before any DOM action.
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        let release!: () => void;
        const gate = new Promise<void>((done) => {
          release = done;
        });
        crypto.subtle.digest = async (...args) => {
          await gate;
          return digest(...args);
        };
        const submit = () =>
          operation === "cover"
            ? provider.set(candidate, expected, execution)
            : provider.save(execution);
        const first = submit();
        const duplicate = submit();
        const conflict =
          operation === "cover"
            ? await provider.set(candidate, "f".repeat(64), execution)
            : await provider.save({ ...execution, expectedBodyHash: "f".repeat(64) });
        const otherType =
          operation === "cover"
            ? await provider.save({
                operationId: id,
                executorId: identity.executorId,
                expectedBodyHash: "a".repeat(64),
                expectedFieldsHash: "b".repeat(64),
                expectedCoverHash: expected,
              })
            : await provider.set(candidate, expected, {
                operationId: id,
                executorId: identity.executorId,
                asset: "original",
              });
        const counts = () => ({
          saves: (window as any).__mpctlFixtureAssets.nativeSaveCount,
          confirms: (window as any).__mpctlFixtureAssets.coverConfirms ?? 0,
        });
        const before = counts();
        release();
        crypto.subtle.digest = digest;
        const result = await first;
        const repeated = await duplicate;
        valid = false;
        const old = await submit();
        const receipt = await provider.getReceipt(id);
        const after = counts();
        const replacement = createArticleCoverPageService(document, () => true);
        const refused =
          operation === "cover"
            ? await replacement.set(candidate, expected, execution)
            : await replacement.save(execution);
        return { before, after, result, repeated, old, receipt, refused, conflict, otherType };
      }, operation);
      expect(result.before).toEqual({ saves: 0, confirms: 0 });
      expect(result.repeated).toEqual(result.result);
      expect(result.old).toEqual(result.result);
      expect(result.receipt.value).toEqual(result.result.value);
      expect(result.refused).toEqual({ status: "error", error: { code: "executor_mismatch" } });
      expect(result.conflict).toEqual({ status: "error", error: { code: "operation_conflict" } });
      expect(result.otherType).toEqual({ status: "error", error: { code: "operation_conflict" } });
      if (operation === "save") {
        expect(result.after).toEqual({ saves: 1, confirms: 0 });
        expect(result.result.value).toMatchObject({
          effect: { outcome: "confirmed", persistence: "unverified" },
          ended: true,
        });
      } else {
        // The unexposed menu is a native preflight refusal, not a synthetic confirmation.
        expect(result.after).toEqual({ saves: 0, confirms: 0 });
        expect(result.result.value.effect).toEqual({ cover: true, outcome: "not_dispatched" });
      }
    } finally {
      await browser.close();
    }
  });
}

for (const mode of ["completed", "readback-guard-loss"] as const)
  test(`B-C1/V3 confirmed cover ${mode} actual provider repeats zero selection/crop/confirm after original hash changes`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", async (route) => {
        const url = route.request().url();
        if (url.endsWith("/provider.js"))
          return route.fulfill({ contentType: "text/javascript", body: bundle });
        if (url.includes("jsapi.js"))
          return route.fulfill({ contentType: "text/javascript", body: jsapi });
        if (url.startsWith("https://mmbiz.qpic.cn/"))
          return route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK0sAAAAASUVORK5CYII=",
              "base64",
            ),
          });
        if (url.startsWith("https://mp.weixin.qq.com/cgi-bin/appmsg"))
          return route.fulfill({ contentType: "text/html", body: html });
        return route.abort();
      });
      await page.goto(
        "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=fixture-group-1&token=synthetic-context",
      );
      const result = await page.evaluate(async (mode) => {
        const url = "https://mp.weixin.qq.com/provider.js";
        const { createArticleCoverPageService } = await import(url);
        let valid = true;
        const provider = createArticleCoverPageService(document, () => valid);
        const executorId = (await provider.identity()).value.executorId;
        const expected = (await provider.read()).value;
        document
          .querySelector(".js_cover_preview_new .js_chooseCoverWrap")!
          .classList.add("fixture-menu-visible");
        const execution = {
          operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
          executorId,
          asset: "original-asset",
        };
        const candidate = {
          filename: "saved-cover-candidate.png",
          thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/synthetic-library-card/300?wx_fmt=png",
        };
        if (mode === "readback-guard-loss") {
          const digest = crypto.subtle.digest.bind(crypto.subtle);
          crypto.subtle.digest = async (...args) => {
            const hash = await digest(...args);
            if (
              new TextDecoder().decode(args[1] as ArrayBuffer).includes("synthetic-library-card") &&
              (window as any).__mpctlFixtureAssets.coverConfirms === 1
            )
              valid = false;
            return hash;
          };
        }
        const first = provider.set(candidate, expected, execution);
        const second = provider.set(candidate, expected, execution);
        const result = await first;
        const repeated = await second;
        const third = await provider.set(candidate, expected, execution);
        return {
          result,
          repeated,
          third,
          count: (window as any).__mpctlFixtureAssets.coverConfirms,
          trace: (window as any).__mpctlFixtureAssets.coverTrace,
        };
      }, mode);
      expect(result.result.value, JSON.stringify(result)).toMatchObject({
        effect: { cover: true, outcome: "confirmed" },
        ended: true,
      });
      expect(result.repeated).toEqual(result.result);
      expect(result.third).toEqual(result.result);
      if (mode === "readback-guard-loss")
        expect(result.result.value.result).toMatchObject({
          status: "error",
          error: {
            code: "target_unavailable",
            cause: { at: "content.cover_confirm", kind: "domain", code: "target_unavailable" },
          },
        });
      expect(result.count).toBe(1);
      expect(result.trace.filter((step: string) => step === "library-menu")).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });
