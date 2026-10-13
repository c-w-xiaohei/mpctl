import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

let temp: string;
let bundle: string;
test.beforeAll(async () => {
  temp = await mkdtemp("/tmp/opencode/mpctl-upload-idempotency-");
  const output = path.join(temp, "upload.js");
  execFileSync("bun", [
    "build",
    "test/browser/fixtures/upload-dom.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${output}`,
  ]);
  bundle = await readFile(output, "utf8");
});
test.afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

for (const mode of [
  "accepted-identity-loss",
  "issued-connect-loss",
  "issued-acquire-loss",
  "issued-call-version",
] as const) {
  test(`correction F1a/F1b ${mode}: actual zero invoke and native IDB ended refusal`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("upload.js")
          ? route.fulfill({ contentType: "text/javascript", body: bundle })
          : route.fulfill({ contentType: "text/html", body: html }),
      );
      await page.goto(
        "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
      );
      const outcome = await page.evaluate(async (mode) => {
        const url = "https://mp.weixin.qq.com/upload.js";
        const module = await import(url);
        const f = await module.lostUploadReplyFixture(document, false);
        let uploads = 0;
        const upload = f.material.upload.bind(f.material);
        f.material.upload = (...args: Parameters<typeof upload>) => {
          uploads++;
          return upload(...args);
        };
        if (mode === "accepted-identity-loss")
          f.material.identity = async () => {
            throw new Error("private identity failure");
          };
        let issuedSeen = false;
        const get = f.connection.safeGet.bind(f.connection);
        const connect = f.pages.connectContent.bind(f.pages);
        const originalUpload = f.pages.uploadMaterial.bind(f.pages);
        f.pages.uploadMaterial = async (
          ...args: Parameters<
            ReturnType<typeof import("../../src/pages").createPageManager>["uploadMaterial"]
          >
        ) => {
          const record = (await f.operations.record(args[2].operationId)).unwrap();
          issuedSeen = record.snapshot.state === "issued";
          if (mode === "issued-connect-loss")
            f.pages.connectContent = async () => {
              throw new module.NexusError("private connect failure", "E_CONN_CLOSED");
            };
          else if (mode === "issued-acquire-loss")
            f.connection.safeGet = () => get(new module.Token("fixture.missing-material"));
          else if (mode === "issued-call-version")
            f.connection.safeGet = (...args: Parameters<typeof get>) => {
              const result = get(...args);
              f.connection.contextMeta.app.protocolVersion = "0.9.0";
              return result;
            };
          return originalUpload(...args);
        };
        try {
          const request = {
            article: f.article.article,
            operationId: module.createOperationId(f.operations.ledgerId),
            blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
              type: "image/png",
            }),
            filename: "native.png",
            mimeType: "image/png",
          };
          const first = await f.workspace.uploadAsset(request);
          const repeated = await f.workspace.uploadAsset(request);
          const status = await f.workspace.getOperation(request.operationId);
          const pending = (await f.operations.pending()).unwrap().length;
          const maintenance = await f.operations.maintenance(async () => "released");
          return {
            first,
            repeated,
            status,
            issuedSeen,
            uploads,
            pending,
            maintenance: maintenance.status,
            files: document.querySelector<HTMLInputElement>("input[type=file]")!.files!.length,
          };
        } finally {
          f.connection.safeGet = get;
          f.pages.connectContent = connect;
          f.close();
        }
      }, mode);
      expect(outcome.first.value.snapshot).toMatchObject({
        state: "settled",
        effect: { outcome: "not_dispatched" },
        result: { status: "error" },
      });
      expect(outcome.first.value.snapshot.result.error.cause).toMatchObject({
        at:
          mode === "issued-connect-loss"
            ? "bg.page_connect"
            : mode === "issued-acquire-loss"
              ? "bg.page_acquire"
              : "bg.page_call",
        kind: mode === "issued-call-version" ? "protocol" : "nexus",
        code:
          mode === "accepted-identity-loss"
            ? "E_REMOTE_EXCEPTION"
            : mode === "issued-acquire-loss"
              ? "E_SERVICE_UNAVAILABLE"
              : mode === "issued-call-version"
                ? "version_mismatch"
                : "E_CONN_CLOSED",
      });
      expect(outcome.repeated).toEqual(outcome.first);
      expect(outcome.status).toEqual(outcome.first);
      expect(outcome.issuedSeen).toBe(mode !== "accepted-identity-loss");
      expect({
        uploads: outcome.uploads,
        files: outcome.files,
        pending: outcome.pending,
        maintenance: outcome.maintenance,
      }).toEqual({ uploads: 0, files: 0, pending: 0, maintenance: "ok" });
      expect(outcome.first.value.snapshot.result.error).not.toHaveProperty("notInvoked");
    } finally {
      await browser.close();
    }
  });
}

for (const mode of [
  "cleanup-query-throw",
  "cleanup-guard-throw",
  "cleanup-postcancel-guard-throw",
  "main-error-cleanup-throw",
  "menu-observed-refusal",
  "menu-unobserved",
  "toolbar-replaced",
  "choice-replaced",
  "choice-pending",
] as const) {
  test(`correction F2/Q1 ${mode}: actual original native end, IDB conflict release and duplicate receipt`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("upload.js")
          ? route.fulfill({ contentType: "text/javascript", body: bundle })
          : route.fulfill({
              contentType: "text/html; charset=utf-8",
              body: `<!doctype html><style>[hidden]{display:none!important}</style><li id="js_editor_insertimage"><button>图片</button><div hidden><button class="js_img_from_local">从图片库选择</button></div></li><div class="weui-desktop-dialog" hidden><h2>选择图片</h2><button class="weui-desktop-dialog__close-btn">×</button><section></section><div class="weui-desktop-upload_global-media"><input type="file" multiple hidden accept="image/bmp,image/png,image/jpeg,image/gif,image/webp"></div><button>确定</button><button>取消</button></div>`,
            }),
      );
      await page.goto(
        "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
      );
      const result = await page.evaluate(async (mode) => {
        const url = "https://mp.weixin.qq.com/upload.js";
        const module = await import(url);
        const menu = document.querySelector<HTMLElement>("li")!;
        const dropdown = menu.querySelector<HTMLElement>("div")!;
        const choice = menu.querySelector<HTMLElement>(".js_img_from_local")!;
        const dialog = document.querySelector<HTMLElement>(".weui-desktop-dialog")!;
        const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
        const counts = { menu: 0, choice: 0, assign: 0, change: 0, cancel: 0, cardReads: 0 };
        let observedOriginal = false;
        let cleanupReached = false;
        let choicePending = false;
        const choiceRects = choice.getClientRects.bind(choice);
        choice.getClientRects = () => {
          const rects = choiceRects();
          if (counts.menu === 1 && rects.length > 0 && choice.isConnected && menu.isConnected)
            observedOriginal = true;
          return rects;
        };
        let valid = true;
        const query = dialog.querySelectorAll.bind(dialog);
        let nativeConfirmed = false;
        dialog.querySelectorAll = ((selector: string) => {
          if (selector === ".weui-desktop-img-picker__item") {
            counts.cardReads++;
            if (counts.change === 1) nativeConfirmed = true;
          }
          if (
            selector === "button" &&
            ((nativeConfirmed && mode === "cleanup-query-throw") ||
              (counts.change === 1 && mode === "main-error-cleanup-throw"))
          ) {
            cleanupReached = true;
            throw new Error("private cleanup query");
          }
          return query(selector);
        }) as typeof dialog.querySelectorAll;
        const files = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")!;
        Object.defineProperty(input, "files", {
          ...files,
          set(value) {
            counts.assign++;
            files.set!.call(this, value);
          },
        });
        input.addEventListener("change", () => {
          counts.change++;
          dialog.querySelector("section")!.innerHTML =
            '<article class="weui-desktop-img-picker__item"><span class="weui-desktop-img-picker__img-title">native.png</span><span class="weui-desktop-img-picker__img-thumb" style=\'background-image: url("https://mmbiz.qpic.cn/mmbiz_png/test/300")\'></span></article>';
          if (mode === "main-error-cleanup-throw") valid = false;
        });
        dialog.querySelectorAll("button")[2]!.addEventListener("click", () => {
          counts.cancel++;
          if (mode !== "cleanup-postcancel-guard-throw") dialog.hidden = true;
        });
        choice.addEventListener("click", () => {
          counts.choice++;
          if (mode === "choice-pending") {
            choicePending = true;
            valid = false;
          } else dialog.hidden = false;
        });
        menu.addEventListener("click", (event) => {
          if (event.target !== menu) return;
          counts.menu++;
          if (mode === "menu-unobserved") {
            valid = false;
            return;
          }
          dropdown.hidden = false; // Original, initially hidden native dropdown becomes visible.
          if (mode === "toolbar-replaced") menu.replaceWith(menu.cloneNode(true));
          if (mode === "choice-replaced") choice.replaceWith(choice.cloneNode(true));
        });
        const f = await module.lostUploadReplyFixture(document, false, () => {
          if (mode === "menu-observed-refusal" && observedOriginal) valid = false;
          if (mode === "cleanup-guard-throw" && cleanupReached)
            throw new Error("private cleanup guard");
          if (mode === "cleanup-postcancel-guard-throw" && counts.cancel === 1) {
            cleanupReached = true;
            throw new Error("private postcancel guard");
          }
          return valid;
        });
        // Throw only after the native confirmation's final guard, not during its read.
        if (mode === "cleanup-guard-throw") {
          const cancel = dialog.querySelectorAll("button")[2]!;
          const text = cancel.textContent;
          Object.defineProperty(cancel, "textContent", {
            get() {
              if (nativeConfirmed) cleanupReached = true;
              return text;
            },
          });
        }
        try {
          const request = {
            article: f.article.article,
            operationId: module.createOperationId(f.operations.ledgerId),
            blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
              type: "image/png",
            }),
            filename: "native.png",
            mimeType: "image/png",
          };
          const first = await f.workspace.uploadAsset(request);
          const before = { ...counts };
          const receipt = await f.material.getReceipt(request.operationId);
          const status = await f.workspace.getOperation(request.operationId);
          const repeated = await f.workspace.uploadAsset(request);
          const afterReplay = { ...counts };
          const pending = (await f.operations.pending()).unwrap().length;
          const maintenance = await f.operations.maintenance(async () => "released");
          const cover = await f.workspace.setArticleCover({
            operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
            article: f.article.article,
            asset: "unavailable-current-handle",
            expectedCoverHash: "0".repeat(64),
          });
          return {
            first,
            receipt,
            status,
            repeated,
            before,
            afterReplay,
            pending,
            maintenance: maintenance.status,
            cover,
            observedOriginal,
            cleanupReached,
            choicePending,
          };
        } finally {
          f.close();
        }
      }, mode);
      const settled =
        mode === "cleanup-query-throw" ||
        mode === "cleanup-guard-throw" ||
        mode === "menu-observed-refusal";
      expect(result.first.value.snapshot.state).toBe(settled ? "settled" : "unresolved");
      expect(result.receipt.value.ended).toBe(settled);
      expect(result.status.value.snapshot).toEqual(result.first.value.snapshot);
      expect(result.repeated.value.snapshot).toEqual(result.first.value.snapshot);
      expect(result.afterReplay).toEqual(result.before);
      expect(result.pending).toBe(settled ? 0 : 1);
      expect(result.maintenance).toBe(settled ? "ok" : "error");
      expect(result.cover).toMatchObject({
        value: {
          snapshot: {
            result: {
              status: "error",
              error: { code: settled ? "target_unavailable" : "operation_blocked" },
            },
          },
        },
      });
      const native = mode.startsWith("cleanup-") || mode === "main-error-cleanup-throw";
      expect({
        menu: result.before.menu,
        choice: result.before.choice,
        assign: result.before.assign,
        change: result.before.change,
        cancel: result.before.cancel,
      }).toEqual({
        menu: 1,
        choice: native || mode === "choice-pending" ? 1 : 0,
        assign: native ? 1 : 0,
        change: native ? 1 : 0,
        cancel: mode === "cleanup-postcancel-guard-throw" ? 1 : 0,
      });
      if (mode.startsWith("cleanup-")) {
        expect(result.cleanupReached).toBe(true);
        expect(result.first.value.snapshot).toMatchObject({
          effect: { outcome: "confirmed" },
          result: {
            error: {
              code: "cleanup_failed",
              cause: {
                at: "content.library_cleanup",
                kind: "runtime",
                code: "unexpected_exception",
              },
            },
          },
        });
      }
      if (mode === "main-error-cleanup-throw")
        expect(result.first.value.snapshot).toMatchObject({
          effect: { outcome: "unknown" },
          result: {
            error: {
              code: "asset_upload_unknown",
              cause: { code: "target_unavailable" },
              cleanup: {
                at: "content.library_cleanup",
                kind: "runtime",
                code: "unexpected_exception",
              },
            },
          },
        });
      if (mode === "menu-observed-refusal") {
        expect(result.observedOriginal).toBe(true);
        expect(result.first.value.snapshot.effect.outcome).toBe("not_dispatched");
      }
      if (mode === "choice-pending") expect(result.choicePending).toBe(true);
    } finally {
      await browser.close();
    }
  });
}
const html = `<!doctype html><meta charset="utf-8"><li id="js_editor_insertimage">图片<a class="js_img_from_local">从图片库选择</a></li>
<div class="weui-desktop-dialog"><h2>选择图片</h2><button class="weui-desktop-dialog__close-btn">×</button>
<section class="weui-desktop-img-picker__list"></section><div class="weui-desktop-upload_global-media"><input type="file" multiple hidden accept="image/bmp,image/png,image/jpeg,image/gif,image/webp"></div><button>确定</button><button>取消</button></div>`;

for (const mode of [
  "before-assignment",
  "assignment-before-change",
  "change",
  "confirmed-cleanup",
  "failed-cleanup",
  "malformed",
  "no-thumbnail",
  "ambiguous",
  "input-replaced",
  "snapshot-exception",
  "dialog-replaced",
  "opening-pending",
] as const) {
  test(`B-U1/B-U3/V3 actual native ${mode}: duplicate adds zero files/change/UI and pure receipt reads`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("upload.js")
          ? route.fulfill({ contentType: "text/javascript", body: bundle })
          : route.fulfill({ contentType: "text/html", body: html }),
      );
      await page.goto(
        "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
      );
      const outcome = await page.evaluate(async (mode) => {
        const url = "https://mp.weixin.qq.com/upload.js";
        const module = await import(url);
        const dialog = document.querySelector<HTMLElement>(".weui-desktop-dialog")!;
        const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
        const list = dialog.querySelector("section")!;
        const counts = { assign: 0, change: 0, menu: 0, cleanup: 0, cards: 0 };
        let valid = true;
        const service = module.createMaterialPageService(document, () => valid);
        const identity = await service.identity();
        const execution = {
          operationId: module.createOperationId(crypto.randomUUID()),
          executorId: identity.value.executorId,
        };
        const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 42]);
        const payload = () => ({
          blob: new Blob([bytes], { type: "image/png" }),
          filename: "native.png",
          mimeType: "image/png",
        });
        const files = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")!;
        let duplicate: Promise<any> | undefined;
        Object.defineProperty(input, "files", {
          ...files,
          set(value) {
            counts.assign++;
            files.set!.call(this, value);
            duplicate = service.upload(payload(), execution);
            if (mode === "assignment-before-change") valid = false;
          },
        });
        const query = dialog.querySelectorAll.bind(dialog);
        dialog.querySelectorAll = ((selector: string) => {
          if (selector === ".weui-desktop-img-picker__item") {
            counts.cards++;
            if (mode === "snapshot-exception" && counts.cards === 2) {
              valid = false;
              throw new Error("private card failure");
            }
            if (mode === "before-assignment") valid = false;
            if (counts.cards === 2 && (mode === "malformed" || mode === "no-thumbnail"))
              advance = true;
          }
          return query(selector);
        }) as typeof dialog.querySelectorAll;
        const now = Date.now;
        let advance = false;
        Date.now = () => now() + (advance ? 20_000 : 0);
        input.addEventListener("change", () => {
          counts.change++;
          if (mode === "change" || mode === "failed-cleanup") {
            valid = false;
            return;
          }
          if (mode === "input-replaced") {
            input.replaceWith(input.cloneNode());
            return;
          }
          if (mode === "dialog-replaced") {
            dialog.replaceWith(dialog.cloneNode(true));
            return;
          }
          const card = document.createElement("article");
          card.className = "weui-desktop-img-picker__item";
          card.innerHTML = `<span class="weui-desktop-img-picker__img-title">${mode === "malformed" ? "" : "native.png"}</span><span class="weui-desktop-img-picker__img-thumb" style='background-image: url("${mode === "no-thumbnail" ? "https://invalid.test/image" : "https://mmbiz.qpic.cn/mmbiz_png/test/300"}")'></span>`;
          list.append(card);
          if (mode === "ambiguous") list.append(card.cloneNode(true));
        });
        dialog.querySelectorAll("button")[2]!.addEventListener("click", () => {
          counts.cleanup++;
        });
        if (mode === "confirmed-cleanup" || mode === "failed-cleanup") {
          dialog.hidden = true;
          document.querySelector(".js_img_from_local")!.addEventListener("click", () => {
            dialog.hidden = false;
          });
          // Missing cancel proves no cleanup native dispatch; confirmed creation still fails its command.
          input.addEventListener("change", () => {
            dialog.querySelectorAll("button")[2]!.remove();
          });
        }
        document.querySelector("li")!.addEventListener("click", (event) => {
          if (event.target === document.querySelector("li")) {
            counts.menu++;
            if (mode === "opening-pending") valid = false;
          }
        });
        if (mode === "opening-pending") dialog.hidden = true;
        try {
          const first = await service.upload(payload(), execution);
          const repeated = await (duplicate ?? service.upload(payload(), execution));
          const bytesChanged = Uint8Array.from(bytes);
          bytesChanged[8] = 43;
          const conflict = await service.upload(
            { ...payload(), blob: new Blob([bytesChanged], { type: "image/png" }) },
            execution,
          );
          const renamed = await service.upload({ ...payload(), filename: "other.png" }, execution);
          const before = { ...counts };
          const receipt = await service.getReceipt(execution.operationId);
          const after = { ...counts };
          const replaced = module.createMaterialPageService(document, () => true);
          const oldExecution = await replaced.upload(payload(), execution);
          return { first, repeated, receipt, before, after, oldExecution, conflict, renamed };
        } finally {
          Date.now = now;
        }
      }, mode);
      const receipt = outcome.first.value;
      expect(outcome.repeated).toEqual(outcome.first);
      expect(outcome.receipt.value).toEqual(receipt);
      expect(outcome.after).toEqual(outcome.before);
      expect(outcome.oldExecution).toEqual({
        status: "error",
        error: { code: "executor_mismatch" },
      });
      expect(outcome.conflict).toEqual({ status: "error", error: { code: "operation_conflict" } });
      expect(outcome.renamed).toEqual({ status: "error", error: { code: "operation_conflict" } });
      const noFile = mode === "before-assignment" || mode === "opening-pending";
      expect(outcome.before.assign).toBe(noFile ? 0 : 1);
      expect(outcome.before.change).toBe(noFile || mode === "assignment-before-change" ? 0 : 1);
      expect(outcome.before.cleanup).toBe(0);
      expect(receipt.effect.outcome).toBe(
        mode === "confirmed-cleanup" ? "confirmed" : noFile ? "not_dispatched" : "unknown",
      );
      expect(receipt.ended).toBe(mode === "before-assignment" || mode === "confirmed-cleanup");
      if (mode === "confirmed-cleanup")
        expect(receipt.result.error).toMatchObject({
          code: "cleanup_failed",
          cause: { code: "dialog_changed" },
        });
      if (mode === "failed-cleanup")
        expect(receipt.result.error).toMatchObject({
          code: "asset_upload_unknown",
          cause: { at: "content.upload_confirm", code: "target_unavailable" },
          cleanup: { at: "content.library_cleanup", code: "dialog_changed" },
        });
      if (mode === "opening-pending") expect(outcome.before.menu).toBe(1);
    } finally {
      await browser.close();
    }
  });
}

test("R1/R7/K3 actual Nexus Blob lost upload receipt recovers via IDB status with zero native rereads", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("upload.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: html }),
    );
    await page.goto(
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
    );
    const result = await page.evaluate(async () => {
      const url = "https://mp.weixin.qq.com/upload.js";
      const module = await import(url);
      const counts = { assign: 0, change: 0, reads: 0 };
      const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
      const files = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")!;
      Object.defineProperty(input, "files", {
        ...files,
        set(value) {
          counts.assign++;
          files.set!.call(this, value);
        },
      });
      const dialog = document.querySelector<HTMLElement>(".weui-desktop-dialog")!;
      const query = dialog.querySelectorAll.bind(dialog);
      dialog.querySelectorAll = ((selector: string) => {
        if (selector === ".weui-desktop-img-picker__item") counts.reads++;
        return query(selector);
      }) as typeof dialog.querySelectorAll;
      input.addEventListener("change", () => {
        counts.change++;
        dialog.querySelector("section")!.innerHTML =
          '<article class="weui-desktop-img-picker__item"><span class="weui-desktop-img-picker__img-title">native.png</span><span class="weui-desktop-img-picker__img-thumb" style=\'background-image: url("https://mmbiz.qpic.cn/mmbiz_png/test/300")\'></span></article>';
      });
      const f = await module.lostUploadReplyFixture(document);
      try {
        const request = {
          article: f.article.article,
          operationId: module.createOperationId(f.operations.ledgerId),
          blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
            type: "image/png",
          }),
          filename: "native.png",
          mimeType: "image/png",
        };
        const first = await f.workspace.uploadAsset(request);
        const before = { ...counts };
        const status = await f.workspace.getOperation(request.operationId);
        const repeated = await f.workspace.uploadAsset({
          ...request,
          blob: request.blob.slice(0, request.blob.size, request.mimeType),
        });
        return { first, status, repeated, before, after: counts, dropped: f.dropped() };
      } finally {
        f.close();
      }
    });
    expect(result.first.value.snapshot.state).toBe("unresolved");
    expect(result.status.value.snapshot).toMatchObject({
      operation: "upload",
      state: "settled",
      effect: { outcome: "confirmed", filename: "native.png" },
      result: { status: "ok" },
    });
    expect(result.repeated).toEqual(result.status);
    expect(result.before).toEqual({ assign: 1, change: 1, reads: 2 });
    expect(result.after).toEqual(result.before);
    expect(result.dropped).toBe(1);
  } finally {
    await browser.close();
  }
});

test("TM0/K1/R6 content reservation before hash; receipt during owned cleanup preserves confirmation without ending task", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("upload.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: html }),
    );
    await page.goto(
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
    );
    const result = await page.evaluate(async () => {
      const url = "https://mp.weixin.qq.com/upload.js";
      const module = await import(url);
      const dialog = document.querySelector<HTMLElement>(".weui-desktop-dialog")!;
      dialog.hidden = true;
      const counts = { assign: 0, change: 0, open: 0, cancel: 0, cards: 0 };
      document.querySelector(".js_img_from_local")!.addEventListener("click", () => {
        counts.open++;
        dialog.hidden = false;
      });
      const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
      const files = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")!;
      Object.defineProperty(input, "files", {
        ...files,
        set(value) {
          counts.assign++;
          files.set!.call(this, value);
        },
      });
      const query = dialog.querySelectorAll.bind(dialog);
      dialog.querySelectorAll = ((selector: string) => {
        if (selector === ".weui-desktop-img-picker__item") counts.cards++;
        return query(selector);
      }) as typeof dialog.querySelectorAll;
      input.addEventListener("change", () => {
        counts.change++;
        dialog.querySelector("section")!.innerHTML =
          '<article class="weui-desktop-img-picker__item"><span class="weui-desktop-img-picker__img-title">native.png</span><span class="weui-desktop-img-picker__img-thumb" style=\'background-image: url("https://mmbiz.qpic.cn/mmbiz_png/test/300")\'></span></article>';
      });
      let reached!: () => void;
      const cleanup = new Promise<void>((done) => {
        reached = done;
      });
      dialog.querySelectorAll("button")[2]!.addEventListener("click", () => {
        counts.cancel++;
        reached();
      });
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = (async (...args: Parameters<typeof digest>) => {
        await gate;
        return digest(...args);
      }) as typeof crypto.subtle.digest;
      const service = module.createMaterialPageService(document, () => true);
      const identity = await service.identity();
      const execution = {
        operationId: module.createOperationId(crypto.randomUUID()),
        executorId: identity.value.executorId,
      };
      const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
      const payload = () => ({
        blob: new Blob([bytes], { type: "image/png" }),
        filename: "native.png",
        mimeType: "image/png",
      });
      try {
        const first = service.upload(payload(), execution);
        const same = service.upload(payload(), execution);
        const changed = Uint8Array.from(bytes);
        changed[8] = 2;
        const different = service.upload(
          { ...payload(), blob: new Blob([changed], { type: "image/png" }) },
          execution,
        );
        const beforeHash = { ...counts };
        release();
        const conflict = await different;
        await cleanup;
        const beforeReceipt = { ...counts };
        const receipt = await service.getReceipt(execution.operationId);
        const afterReceipt = { ...counts };
        const duplicateAfterConfirmation = service.upload(payload(), execution);
        dialog.hidden = true; // External fixture acknowledgement of the original cancel only.
        const result = await first;
        return {
          beforeHash,
          conflict,
          receipt,
          beforeReceipt,
          afterReceipt,
          result,
          same: await same,
          duplicate: await duplicateAfterConfirmation,
          counts,
        };
      } finally {
        release();
        dialog.hidden = true;
        crypto.subtle.digest = digest;
      }
    });
    expect(result.beforeHash).toEqual({ assign: 0, change: 0, open: 0, cancel: 0, cards: 0 });
    expect(result.conflict).toEqual({ status: "error", error: { code: "operation_conflict" } });
    expect(result.receipt.value).toMatchObject({ ended: false, effect: { outcome: "confirmed" } });
    expect(result.afterReceipt).toEqual(result.beforeReceipt);
    expect(result.result.value).toMatchObject({
      ended: true,
      effect: { outcome: "confirmed" },
      result: { status: "ok" },
    });
    expect(result.same).toEqual(result.result);
    expect(result.duplicate).toEqual(result.result);
    expect(result.counts).toEqual({ assign: 1, change: 1, open: 1, cancel: 1, cards: 2 });
  } finally {
    await browser.close();
  }
});

for (const mode of ["issue-abort", "confirmation-abort"] as const) {
  test(`P2/P5/B-U3 real IDB ${mode}: native UI requires complete and confirmation retains cleanup first cause`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("upload.js")
          ? route.fulfill({ contentType: "text/javascript", body: bundle })
          : route.fulfill({ contentType: "text/html", body: html }),
      );
      await page.goto(
        "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
      );
      const result = await page.evaluate(async (mode) => {
        const url = "https://mp.weixin.qq.com/upload.js";
        const module = await import(url);
        const counts = { menu: 0, open: 0, assign: 0, change: 0, cancel: 0, abort: 0 };
        const dialog = document.querySelector<HTMLElement>(".weui-desktop-dialog")!;
        dialog.hidden = true;
        document.querySelector("li")!.addEventListener("click", (event) => {
          if (event.target === document.querySelector("li")) counts.menu++;
        });
        document.querySelector(".js_img_from_local")!.addEventListener("click", () => {
          counts.open++;
          dialog.hidden = false;
        });
        dialog.querySelectorAll("button")[2]!.addEventListener("click", () => {
          counts.cancel++;
        });
        const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
        const files = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")!;
        Object.defineProperty(input, "files", {
          ...files,
          set(value) {
            counts.assign++;
            files.set!.call(this, value);
          },
        });
        input.addEventListener("change", () => {
          counts.change++;
          dialog.querySelector("section")!.innerHTML =
            '<article class="weui-desktop-img-picker__item"><span class="weui-desktop-img-picker__img-title">native.png</span><span class="weui-desktop-img-picker__img-thumb" style=\'background-image: url("https://mmbiz.qpic.cn/mmbiz_png/test/300")\'></span></article>';
          dialog.querySelectorAll("button")[2]!.remove();
        });
        const f = await module.lostUploadReplyFixture(document, false);
        const put = IDBObjectStore.prototype.put;
        let failing = true;
        IDBObjectStore.prototype.put = function (value, key) {
          const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
          if (
            failing &&
            value?.snapshot?.state === (mode === "issue-abort" ? "issued" : "settled")
          ) {
            request.addEventListener("success", () => {
              counts.abort++;
              this.transaction.abort();
            });
          }
          return request;
        };
        try {
          const request = {
            article: f.article.article,
            operationId: module.createOperationId(f.operations.ledgerId),
            blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
              type: "image/png",
            }),
            filename: "native.png",
            mimeType: "image/png",
          };
          const first = await f.workspace.uploadAsset(request);
          failing = false;
          const before = { ...counts };
          const repeated = await f.workspace.uploadAsset(request);
          const status = await f.workspace.getOperation(request.operationId);
          return { first, repeated, status, before, after: counts };
        } finally {
          IDBObjectStore.prototype.put = put;
          f.close();
        }
      }, mode);
      if (mode === "issue-abort") {
        expect(result.first.value.snapshot).toMatchObject({
          state: "settled",
          effect: { outcome: "not_dispatched" },
          result: { error: { code: "operation_interrupted" } },
        });
        expect(result.before).toEqual({
          menu: 0,
          open: 0,
          assign: 0,
          change: 0,
          cancel: 0,
          abort: 1,
        });
      } else {
        expect(result.first.value.snapshot.state).toBe("unresolved");
        expect(result.first.value.issue).toMatchObject({
          failure: { code: "storage_failed" },
          uncommitted: {
            effect: { outcome: "confirmed", filename: "native.png" },
            result: {
              error: {
                code: "cleanup_failed",
                cause: { at: "content.library_cleanup", code: "dialog_changed" },
              },
            },
          },
        });
        expect(result.before).toEqual({
          menu: 1,
          open: 1,
          assign: 1,
          change: 1,
          cancel: 0,
          abort: 1,
        });
        expect(result.status.value.snapshot).toMatchObject({
          state: "settled",
          effect: { outcome: "confirmed" },
          result: { error: { code: "cleanup_failed" } },
        });
      }
      expect(result.after).toEqual(result.before);
    } finally {
      await browser.close();
    }
  });
}
