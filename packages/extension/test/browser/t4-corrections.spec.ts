import { chromium, expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

let temp: string, bundle: string, html: string, jsapi: string;
test.beforeAll(async () => {
  temp = await mkdtemp("/tmp/opencode/mpctl-t4-corrections-");
  const output = path.join(temp, "corrections.js");
  execFileSync("bun", [
    "build",
    "test/browser/fixtures/t4-corrections.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${output}`,
  ]);
  bundle = await readFile(output, "utf8");
  html = await readFile("test/browser/fixtures/bridge/index.html", "utf8");
  jsapi = await readFile("test/browser/fixtures/bridge/jsapi.js", "utf8");
});
test.afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});
async function open(page: Page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.endsWith("/corrections.js"))
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
}

test("R1 cover success publication remains codec-valid at final-guard microtask and through Nexus", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await open(page);
    const result = await page.evaluate(async () => {
      const moduleUrl = "https://mp.weixin.qq.com/corrections.js";
      const {
        createEditorService,
        createArticleCoverPageService,
        coverReceiptResultCodec,
        Nexus,
        createPageEndpoint,
        pageEditorToken,
        protocolVersion,
      } = await import(moduleUrl);
      const provider = createArticleCoverPageService(document, () => true);
      const expectedCoverHash = (await provider.read()).value;
      const body =
        '<img class="rich_pages wxw-img" data-src="https://mmbiz.qpic.cn/mmbiz_png/publication/0" data-imgfileid="123" data-type="png" data-ratio="0.5625" data-w="640">';
      const expectedBodyHash = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
      ]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      let gets = 0,
        covers = 0,
        scheduled = false;
      const operationId = `op:${crypto.randomUUID()}:${crypto.randomUUID()}`;
      const observed: any[] = [],
        queries: Promise<unknown>[] = [];
      const serialize = coverReceiptResultCodec.serialize;
      coverReceiptResultCodec.serialize = (value: any) => {
        if (value.isOk() && value.value) observed.push(structuredClone(value.value));
        return serialize(value);
      };
      const editor = createEditorService({
        document,
        validateTarget() {
          if (gets === 3 && !scheduled) {
            scheduled = true;
            queueMicrotask(() => {
              queries.push(
                editor.getCoverReceipt(operationId).then(
                  (wire: unknown) => wire,
                  (error: unknown) => ({ thrown: String(error) }),
                ),
              );
            });
          }
          return true;
        },
        invoke(request: any) {
          if (request.apiName === "mp_editor_get_isready")
            request.sucCb({ isReady: true, isNew: true });
          else if (request.apiName === "mp_editor_get_content") {
            gets++;
            request.sucCb({ content: body });
          } else {
            covers++;
            request.sucCb({});
          }
        },
      });
      const target = new EventTarget(),
        channelId = crypto.randomUUID();
      const endpoints = ["main", "isolated"].map((side) =>
        createPageEndpoint({
          target,
          channelId,
          side,
          eventNames: { fromMain: channelId + ":out", fromIsolated: channelId + ":in" },
        }),
      );
      const server = new Nexus()
        .configure({
          endpoint: { implementation: endpoints[0], meta: { app: { protocolVersion } } },
        })
        .provide(pageEditorToken, editor);
      const client = new Nexus().configure({
        endpoint: { implementation: endpoints[1], meta: { app: { protocolVersion } } },
      });
      try {
        await Promise.all([server.ready(), client.ready()]);
        const connection = await client.connect({ target: {} });
        const remote = connection.get(pageEditorToken);
        const executorId = (await remote.ready()).value.executorId;
        const first = await remote.setCoverFromBody({
          operationId,
          executorId,
          bodyImage: 1,
          expectedBodyHash,
          expectedCoverHash,
        });
        const during = await Promise.all(queries);
        const before = { gets, covers };
        const final = await remote.getCoverReceipt(operationId);
        const after = { gets, covers };
        connection.disconnect();
        return { first, during, final, observed, before, after, scheduled };
      } finally {
        coverReceiptResultCodec.serialize = serialize;
        endpoints.forEach((endpoint: any) => endpoint.close());
      }
    });
    expect(result.scheduled).toBe(true);
    expect(result.during).toHaveLength(1);
    for (const wire of [...result.during, result.final] as any[])
      expect(wire).toMatchObject({
        status: "ok",
        value: { ended: true, effect: { outcome: "confirmed" }, result: { status: "ok" } },
      });
    for (const receipt of result.observed as any[])
      expect(
        receipt.result?.status !== "ok" ||
          (receipt.ended && receipt.effect.outcome === "confirmed"),
      ).toBe(true);
    expect(result.final.value).toEqual(result.first.value);
    expect(result.before).toEqual({ gets: 3, covers: 1 });
    expect(result.after).toEqual(result.before);
  } finally {
    await browser.close();
  }
});

for (const mode of ["index", "all-inputs"] as const)
  test(`R3 body cover local aliases ${mode} cannot change accepted intent during workspace preflight`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await open(page);
      const result = await page.evaluate(async (mode) => {
        const moduleUrl = "https://mp.weixin.qq.com/corrections.js";
        const { fixture, operationResultCodec, bodyCoverRequestDigest } = await import(moduleUrl);
        const f = await fixture();
        try {
          const body = ["first", "second"]
            .map(
              (name, index) =>
                `<img class="rich_pages wxw-img" data-src="https://mmbiz.qpic.cn/mmbiz_png/alias-${name}/0" data-imgfileid="${index + 1}" data-type="png" data-ratio="0.5625" data-w="640">`,
            )
            .join("");
          await new Promise<void>((resolve) =>
            (window as any).__MP_Editor_JSAPI__.invoke({
              apiName: "mp_editor_set_content",
              apiParam: { content: body },
              sucCb: resolve,
            }),
          );
          const article = (await f.workspace.currentArticle()).value;
          const expectedCoverHash = (await f.workspace.readArticleCover(article.article)).value
            .coverHash;
          const initial = {
            operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
            article: article.article,
            bodyImage: 1,
            expectedBodyHash: article.bodyHash,
            expectedCoverHash,
          };
          const alias = { ...initial };
          const read = f.pages.readArticleCover;
          let release!: () => void, entered!: () => void;
          const gate = new Promise<void>((done) => {
              release = done;
            }),
            reached = new Promise<void>((done) => {
              entered = done;
            });
          f.pages.readArticleCover = async () => {
            entered();
            await gate;
            return read();
          };
          const task = f.workspace.setArticleCover(alias);
          await reached;
          Object.assign(
            alias,
            mode === "index"
              ? { bodyImage: 2 }
              : {
                  article: "ephemeral:wrong-local-alias",
                  bodyImage: 2,
                  expectedBodyHash: "a".repeat(64),
                  expectedCoverHash: "b".repeat(64),
                },
          );
          release();
          const first = (await operationResultCodec.deserialize(await task)).unwrap();
          const record = (await f.operations.record(initial.operationId)).unwrap();
          const before = structuredClone((window as any).__mpctlFixtureCalls);
          const replay = (
            await operationResultCodec.deserialize(await f.workspace.setArticleCover(initial))
          ).unwrap();
          const conflicts = [];
          for (const changed of [
            { bodyImage: 2 },
            { expectedBodyHash: "a".repeat(64) },
            { expectedCoverHash: "b".repeat(64) },
            { article: "ephemeral:wrong-local-alias" },
          ])
            conflicts.push(await f.workspace.setArticleCover({ ...initial, ...changed }));
          return {
            first,
            replay,
            conflicts,
            record,
            digest: await bodyCoverRequestDigest(initial),
            before,
            after: (window as any).__mpctlFixtureCalls,
            native: (window as any).__mpctlFixtureResults.filter(
              (x: any) => x.apiName === "mp_editor_change_cover",
            ),
          };
        } finally {
          f.close();
        }
      }, mode);
      expect(result.first.snapshot).toMatchObject({
        operation: "cover",
        state: "settled",
        effect: { outcome: "confirmed" },
        result: { status: "ok" },
      });
      expect(result.record.localRequestDigest).toBe(result.digest);
      expect(result.native).toEqual([
        {
          apiName: "mp_editor_change_cover",
          apiParam: { oriImgUrl: "https://mmbiz.qpic.cn/mmbiz_png/alias-first/0" },
        },
      ]);
      expect(result.replay.snapshot).toEqual(result.first.snapshot);
      expect(result.after).toEqual(result.before);
      for (const conflict of result.conflicts)
        expect(conflict).toMatchObject({
          status: "error",
          error: { failure: { code: "operation_conflict" } },
        });
    } finally {
      await browser.close();
    }
  });

for (const mode of ["success", "timeout"] as const)
  test(`body cover native IDB restart ${mode} forwards original MAIN receipt with zero native APIs`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await open(page);
      const result = await page.evaluate(async (mode) => {
        const moduleUrl = "https://mp.weixin.qq.com/corrections.js";
        const { fixture, createOperations, createWorkspace, operationResultCodec, Result } =
          await import(moduleUrl);
        const f = await fixture();
        try {
          const body =
            '<img class="rich_pages wxw-img" data-src="https://mmbiz.qpic.cn/mmbiz_png/synthetic-idb-body/0?wx_fmt=png" data-imgfileid="123" data-type="png" data-ratio="0.5625" data-w="640">';
          await new Promise<void>((resolve) =>
            (window as any).__MP_Editor_JSAPI__.invoke({
              apiName: "mp_editor_set_content",
              apiParam: { content: body },
              sucCb: resolve,
            }),
          );
          const hash = [
            ...new Uint8Array(
              await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
            ),
          ]
            .map((x) => x.toString(16).padStart(2, "0"))
            .join("");
          const current = (await f.workspace.currentArticle()).value;
          const expected = (await f.workspace.readArticleCover(current.article)).value.coverHash;
          document.documentElement.dataset.mpctlBodyCoverMode = mode;
          const input = {
            operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
            article: current.article,
            bodyImage: 1,
            expectedBodyHash: hash,
            expectedCoverHash: expected,
          };
          const first = (
            await operationResultCodec.deserialize(await f.workspace.setArticleCover(input))
          ).unwrap();
          const record = (await f.operations.record(input.operationId)).unwrap();
          const before = structuredClone((window as any).__mpctlFixtureCalls);
          const directReceipt = await f.provider.getReceipt(input.operationId);
          // Use the original ledger instance's existing durable database name exposed by the fixture.
          const operations = (await createOperations(f.databaseName)).unwrap();
          const workspace = createWorkspace({
            pages: f.pages,
            operations: Promise.resolve(Result.ok(operations)),
          });
          const status = (
            await operationResultCodec.deserialize(await workspace.getOperation(input.operationId))
          ).unwrap();
          const replay = (
            await operationResultCodec.deserialize(await workspace.setArticleCover(input))
          ).unwrap();
          const corrupted: unknown[] = [];
          if (mode === "timeout") {
            const original = f.pages.getExecutionReceipt;
            for (const changed of [
              { executorId: crypto.randomUUID() },
              { requestDigest: "a".repeat(64) },
              { operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}` },
            ]) {
              f.pages.getExecutionReceipt = async (...args: unknown[]) =>
                (await original(...args)).map((receipt: any) => ({ ...receipt, ...changed }));
              corrupted.push(
                (
                  await operationResultCodec.deserialize(
                    await workspace.getOperation(input.operationId),
                  )
                ).unwrap(),
              );
            }
            f.pages.getExecutionReceipt = original;
          }
          return {
            first,
            status,
            replay,
            record,
            directReceipt,
            corrupted,
            before,
            after: (window as any).__mpctlFixtureCalls,
            counts: f.stats(),
          };
        } finally {
          f.close();
        }
      }, mode);
      expect(result.record).toMatchObject({
        schemaVersion: 3,
        snapshot: { operation: "cover" },
      });
      expect(result.status.snapshot).toEqual(result.first.snapshot);
      expect(result.replay.snapshot).toEqual(result.first.snapshot);
      expect(result.before).toEqual(result.after);
      for (const query of result.corrupted as any[]) {
        expect(query.snapshot).toEqual(result.first.snapshot);
        expect(query.issue.failure.code).toBe("evidence_conflict");
      }
      expect(result.counts).toMatchObject({ attach: 0, move: 0, detach: 0, save: 0, set: 0 });
      expect(result.first.snapshot).toMatchObject({
        operation: "cover",
        state: "settled",
        effect: { cover: true, outcome: mode === "success" ? "confirmed" : "unknown" },
      });
    } finally {
      await browser.close();
    }
  });

for (const mode of ["completed", "readback-failure", "readback-guard-loss"] as const)
  test(`F1-R1 ${mode} held post-confirm digest keeps original receipt valid and read-only`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await open(page);
      const result = await page.evaluate(async (mode) => {
        const url = "https://mp.weixin.qq.com/corrections.js";
        const { fixture } = await import(url);
        const f = await fixture();
        const executorId = (await f.provider.identity()).value.executorId;
        const expected = (await f.provider.read()).value;
        const execution = {
          operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
          executorId,
          asset: "original",
        };
        const candidate = {
          filename: "saved-cover-candidate.png",
          thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/synthetic-library-card/300?wx_fmt=png",
        };
        document
          .querySelector(".js_cover_preview_new .js_chooseCoverWrap")!
          .classList.add("fixture-menu-visible");
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        const query = document.querySelector.bind(document);
        const queries = document.querySelectorAll.bind(document);
        let release!: () => void, reached!: () => void;
        const gate = new Promise<void>((done) => {
          release = done;
        });
        const entered = new Promise<void>((done) => {
          reached = done;
        });
        let hashes = 0,
          postConfirmHashes = 0,
          domReads = 0;
        document.querySelector = ((...args: Parameters<typeof query>) => {
          domReads++;
          return query(...args);
        }) as typeof document.querySelector;
        document.querySelectorAll = ((...args: Parameters<typeof queries>) => {
          domReads++;
          return queries(...args);
        }) as typeof document.querySelectorAll;
        crypto.subtle.digest = async (...args) => {
          hashes++;
          if ((window as any).__mpctlFixtureAssets.coverConfirms === 1) {
            postConfirmHashes++;
            reached();
            await gate;
            if (mode === "readback-failure")
              throw new Error("original cover readback hash rejected");
            const hash = await digest(...args);
            if (mode === "readback-guard-loss")
              history.replaceState(
                null,
                "",
                location.href.replace("fixture-group-1", "other-group"),
              );
            return hash;
          }
          return digest(...args);
        };
        const stats = () => ({
          hashes,
          postConfirmHashes,
          domReads,
          confirms: (window as any).__mpctlFixtureAssets.coverConfirms,
        });
        let pending: Promise<any> | undefined;
        try {
          pending = f.provider.set(candidate, expected, execution);
          await entered;
          // The actual crop has already closed and original readback is suspended.
          const cropHidden = (query("#synthetic-cover-crop") as HTMLElement).hidden;
          const before = stats();
          const repeated = f.provider.set(candidate, expected, execution);
          const sameTask = repeated === pending;
          const during = await f.provider.getReceipt(execution.operationId);
          const duringAgain = await f.provider.getReceipt(execution.operationId);
          const after = stats();
          release();
          const final = await pending;
          const repeatedFinal = await repeated;
          const beforeFinalQuery = stats();
          const finalReceipt = await f.provider.getReceipt(execution.operationId);
          const replay = await f.provider.set(candidate, expected, execution);
          const afterFinalQuery = stats();
          return {
            during,
            duringAgain,
            final,
            repeatedFinal,
            finalReceipt,
            replay,
            sameTask,
            cropHidden,
            before,
            after,
            beforeFinalQuery,
            afterFinalQuery,
            trace: [...(window as any).__mpctlFixtureAssets.coverTrace],
          };
        } finally {
          release();
          if (pending) await pending;
          crypto.subtle.digest = digest;
          document.querySelector = query;
          document.querySelectorAll = queries;
          f.close();
        }
      }, mode);
      expect(result.cropHidden).toBe(true);
      expect(result.before.confirms).toBe(1);
      expect(result.before.postConfirmHashes).toBe(1);
      expect(result.sameTask).toBe(true);
      expect(result.during.status).toBe("ok");
      expect(result.during.value).toMatchObject({
        effect: { cover: true, outcome: "unknown" },
        ended: false,
      });
      expect(result.during.value.result).toBeUndefined();
      expect(result.duringAgain).toEqual(result.during);
      expect(result.after).toEqual(result.before);
      expect(result.final.status).toBe("ok");
      expect(result.final.value.ended).toBe(true);
      if (mode === "readback-failure") {
        expect(result.final.value.effect).toEqual(result.during.value.effect);
        expect(result.final.value.result).toEqual({
          status: "error",
          error: {
            code: "cover_unavailable",
            cause: { at: "content.cover_confirm", kind: "domain", code: "cover_unavailable" },
          },
        });
      } else {
        expect(result.final.value.effect).toMatchObject({
          cover: true,
          outcome: "confirmed",
          coverHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        expect(result.final.value.effect.coverHash).not.toBe(
          result.during.value.effect.baselineHash,
        );
        expect(result.final.value.result).toEqual(
          mode === "completed"
            ? { status: "ok", value: {} }
            : {
                status: "error",
                error: {
                  code: "route_changed",
                  cause: { at: "content.cover_confirm", kind: "domain", code: "route_changed" },
                },
              },
        );
      }
      expect(result.repeatedFinal).toEqual(result.final);
      expect(result.finalReceipt.value).toEqual(result.final.value);
      expect(result.replay).toEqual(result.final);
      expect(result.afterFinalQuery).toEqual(result.beforeFinalQuery);
      expect(result.afterFinalQuery.confirms).toBe(1);
      expect(result.trace).toEqual(["library-menu", "card", "next", "crop-image:1x1", "confirm"]);
    } finally {
      await browser.close();
    }
  });

test("F1-R1 SAVE restore microtask sees a valid original receipt before final result publication", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await open(page);
    const result = await page.evaluate(async () => {
      const url = "https://mp.weixin.qq.com/corrections.js";
      const { fixture } = await import(url);
      const f = await fixture();
      const executorId = (await f.provider.identity()).value.executorId;
      const state = (await f.workspace.inspectArticle(f.article.article, { all: true })).value;
      const execution = {
        operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
        executorId,
        expectedBodyHash: state.bodyHash,
        expectedFieldsHash: state.fieldsHash,
        expectedCoverHash: state.coverHash,
      };
      let toggles = 0;
      const query = document.querySelector.bind(document),
        queries = document.querySelectorAll.bind(document);
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let hashes = 0,
        domReads = 0;
      document.querySelector = ((...args: Parameters<typeof query>) => {
        domReads++;
        return query(...args);
      }) as typeof document.querySelector;
      document.querySelectorAll = ((...args: Parameters<typeof queries>) => {
        domReads++;
        return queries(...args);
      }) as typeof document.querySelectorAll;
      crypto.subtle.digest = async (...args) => {
        hashes++;
        return digest(...args);
      };
      const stats = () => ({
        hashes,
        domReads,
        toggles,
        saves: (window as any).__mpctlFixtureAssets.nativeSaveCount,
      });
      let captured!: (value: any) => void;
      const capture = new Promise<any>((done) => {
        captured = done;
      });
      let pending: Promise<any> | undefined;
      const original = document.getElementById("history_bt")!;
      const replacement = original.cloneNode(true) as HTMLElement;
      original.replaceWith(replacement);
      replacement.addEventListener("click", () => {
        toggles++;
        original.click();
        if (toggles === 3)
          queueMicrotask(() => {
            const before = stats();
            const sameTask = f.provider.save(execution) === pending;
            const receipt = f.provider.getReceipt(execution.operationId);
            const after = stats();
            void receipt.then((during: any) => captured({ during, before, after, sameTask }));
          });
      });
      try {
        pending = f.provider.save(execution);
        const final = await pending;
        const observation = await capture;
        const finalReceipt = await f.provider.getReceipt(execution.operationId);
        return {
          ...observation,
          final,
          finalReceipt,
          replay: await f.provider.save(execution),
          finalCounts: stats(),
        };
      } finally {
        if (pending) await pending;
        crypto.subtle.digest = digest;
        document.querySelector = query;
        document.querySelectorAll = queries;
        f.close();
      }
    });
    expect(result.during.status).toBe("ok");
    expect(result.during.value).toMatchObject({
      effect: { outcome: "confirmed", persistence: "unverified" },
      ended: false,
    });
    expect(result.during.value.result).toBeUndefined();
    expect(result.sameTask).toBe(true);
    expect(result.before.saves).toBe(1);
    expect(result.before.toggles).toBe(3);
    expect(result.after).toEqual(result.before);
    expect(result.final.value).toMatchObject({
      effect: { outcome: "confirmed", persistence: "unverified" },
      ended: true,
      result: { status: "ok", value: {} },
    });
    expect(result.finalReceipt.value).toEqual(result.final.value);
    expect(result.replay).toEqual(result.final);
    expect(result.finalCounts.saves).toBe(1);
    expect(result.finalCounts.toggles).toBe(3);
  } finally {
    await browser.close();
  }
});

for (const mode of ["normal", "initial-open", "reopen-held", "restore-held"] as const)
  test(`correction F2 ${mode} history owner observes each dispatched transition`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await open(page);
      const result = await page.evaluate(async (mode) => {
        const url = "https://mp.weixin.qq.com/corrections.js";
        const { fixture } = await import(url);
        const f = await fixture();
        const original = document.getElementById("history_bt")!;
        if (mode === "initial-open") original.click();
        const replacement = original.cloneNode(true) as HTMLElement;
        original.replaceWith(replacement);
        let release!: () => void;
        const gate = new Promise<void>((done) => {
          release = done;
        });
        let toggles = 0,
          completed = 0;
        replacement.addEventListener("click", async () => {
          toggles++;
          if (
            (mode === "reopen-held" && toggles === 2) ||
            (mode === "restore-held" && toggles === 3)
          )
            await gate;
          original.click();
          completed++;
          document.dispatchEvent(new Event("history-transition-completed"));
        });
        const executorId = (await f.provider.identity()).value.executorId;
        const state = (await f.workspace.inspectArticle(f.article.article, { all: true })).value;
        const input = {
          operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
          article: f.article.article,
          expectedBodyHash: state.bodyHash,
          expectedFieldsHash: state.fieldsHash,
          expectedCoverHash: state.coverHash,
        };
        const { article: _article, ...hashes } = input;
        const execution = { ...hashes, executorId };
        try {
          const first = await f.provider.save(execution);
          const before = {
            toggles,
            completed,
            saves: (window as any).__mpctlFixtureAssets.nativeSaveCount,
            visible: !document.getElementById("history_pop")?.hidden,
          };
          const repeated = await f.provider.save(execution);
          const receipt = await f.provider.getReceipt(input.operationId);
          const afterQuery = {
            toggles,
            completed,
            saves: (window as any).__mpctlFixtureAssets.nativeSaveCount,
          };
          if (mode.endsWith("held")) {
            const transition = new Promise<void>((done) =>
              document.addEventListener("history-transition-completed", () => done(), {
                once: true,
              }),
            );
            release();
            await transition;
          }
          return {
            first,
            repeated,
            receipt,
            before,
            afterQuery,
            afterRelease: {
              toggles,
              completed,
              saves: (window as any).__mpctlFixtureAssets.nativeSaveCount,
              visible: !document.getElementById("history_pop")?.hidden,
            },
          };
        } finally {
          release();
          f.close();
        }
      }, mode);
      const held = mode.endsWith("held");
      expect(result.first.value.ended).toBe(!held);
      expect(result.first.value.effect.outcome).toBe(
        mode === "reopen-held" ? "unknown" : "confirmed",
      );
      expect(result.before.saves).toBe(1);
      expect(result.afterRelease.saves).toBe(1);
      expect(result.repeated).toEqual(result.first);
      expect(result.receipt.value).toEqual(result.first.value);
      expect(result.afterQuery).toEqual({
        toggles: result.before.toggles,
        completed: result.before.completed,
        saves: 1,
      });
      expect(result.before.toggles).toBe(
        mode === "initial-open" ? 1 : mode === "reopen-held" ? 2 : 3,
      );
      expect(result.afterRelease.completed).toBe(result.before.completed + (held ? 1 : 0));
      expect(result.afterRelease.visible).toBe(mode === "initial-open" || mode === "reopen-held");
    } finally {
      await browser.close();
    }
  });

for (const mode of ["library-cancel", "crop-cancel"] as const)
  test(`correction F1 ${mode} observed transition and owned cancellation reliably end`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await open(page);
      const result = await page.evaluate(async (mode) => {
        const url = "https://mp.weixin.qq.com/corrections.js";
        const { fixture } = await import(url);
        const f = await fixture();
        const originalDecode = HTMLImageElement.prototype.decode;
        let cancels = 0;
        const library = document.getElementById("synthetic-cover-library")!;
        if (mode === "library-cancel") {
          library.querySelector(".weui-desktop-img-picker__list")!.addEventListener("click", () => {
            (library.querySelector("button") as HTMLButtonElement).disabled = true;
          });
          [...library.querySelectorAll("button")]
            .find((button) => button.textContent?.trim() === "取消")!
            .addEventListener("click", () => {
              cancels++;
              library.remove();
            });
        } else {
          HTMLImageElement.prototype.decode = async function () {
            await originalDecode.call(this);
            if (this.classList.contains("crop-img")) this.src = "https://mp.weixin.qq.com/not-qpic";
          };
          const crop = document.getElementById("synthetic-cover-crop")!;
          crop.querySelector(".weui-desktop-dialog__close-btn")!.addEventListener("click", () => {
            cancels++;
            crop.remove();
          });
        }
        document
          .querySelector(".js_cover_preview_new .js_chooseCoverWrap")!
          .classList.add("fixture-menu-visible");
        const executorId = (await f.provider.identity()).value.executorId;
        const expected = (await f.provider.read()).value;
        const execution = {
          operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
          executorId,
          asset: "original",
        };
        const candidate = {
          filename: "saved-cover-candidate.png",
          thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/synthetic-library-card/300?wx_fmt=png",
        };
        try {
          const first = await f.provider.set(candidate, expected, execution);
          const repeated = await f.provider.set(candidate, expected, execution);
          const receipt = await f.provider.getReceipt(execution.operationId);
          return {
            first,
            repeated,
            receipt,
            cancels,
            confirms: (window as any).__mpctlFixtureAssets.coverConfirms ?? 0,
            trace: (window as any).__mpctlFixtureAssets.coverTrace,
          };
        } finally {
          HTMLImageElement.prototype.decode = originalDecode;
          f.close();
        }
      }, mode);
      expect(result.first.value.ended).toBe(true);
      expect(result.first.value.effect).toEqual({ cover: true, outcome: "not_dispatched" });
      expect(result.cancels).toBe(1);
      expect(result.confirms).toBe(0);
      expect(result.repeated).toEqual(result.first);
      expect(result.receipt.value).toEqual(result.first.value);
      expect(result.trace.filter((step: string) => step === "next")).toHaveLength(
        mode === "crop-cancel" ? 1 : 0,
      );
    } finally {
      await browser.close();
    }
  });

for (const operation of ["cover", "save"] as const)
  test(`correction F${operation === "cover" ? 1 : 2} late native ${operation} UI stays pending after provider timeout`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await open(page);
      const result = await page.evaluate(async (operation) => {
        const url = "https://mp.weixin.qq.com/corrections.js";
        const { fixture, operationResultCodec } = await import(url);
        const f = await fixture();
        let release!: () => void, reached!: () => void;
        const gate = new Promise<void>((done) => {
          release = done;
        });
        const entered = new Promise<void>((done) => {
          reached = done;
        });
        const originalDecode = HTMLImageElement.prototype.decode;
        let toggles = 0;
        if (operation === "cover") {
          document
            .querySelector(".js_cover_preview_new .js_chooseCoverWrap")!
            .classList.add("fixture-menu-visible");
          HTMLImageElement.prototype.decode = async function () {
            if (this.classList.contains("crop-img")) {
              reached();
              await gate;
            }
            return originalDecode.call(this);
          };
        } else {
          const original = document.getElementById("history_bt")!;
          const replacement = original.cloneNode(true) as HTMLElement;
          original.replaceWith(replacement);
          replacement.addEventListener("click", async () => {
            toggles++;
            reached();
            await gate;
            original.click();
          });
        }
        const secondArticle = (await f.workspace.currentArticle()).value.article;
        const fields = (await f.workspace.inspectArticle(f.article.article)).value;
        const coverHash = (await f.workspace.readArticleCover(f.article.article)).value.coverHash;
        const asset =
          operation === "cover"
            ? (await f.workspace.listAssets(f.article.article)).value.cards[0].asset
            : "";
        const input =
          operation === "cover"
            ? {
                operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
                article: f.article.article,
                asset,
                expectedCoverHash: coverHash,
              }
            : {
                operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
                article: f.article.article,
                expectedBodyHash: f.article.bodyHash,
                expectedFieldsHash: fields.fieldsHash,
                expectedCoverHash: coverHash,
              };
        const submit = (request = input) =>
          operation === "cover"
            ? f.workspace.setArticleCover(request)
            : f.workspace.saveArticle(request);
        try {
          const first = submit();
          await entered;
          const reply = (await operationResultCodec.deserialize(await first)).unwrap();
          const receipt = (await f.provider.getReceipt(input.operationId)).value;
          const before = f.stats();
          let domReads = 0;
          const query = document.querySelector.bind(document),
            queries = document.querySelectorAll.bind(document);
          document.querySelector = ((...args: Parameters<typeof query>) => {
            domReads++;
            return query(...args);
          }) as typeof document.querySelector;
          document.querySelectorAll = ((...args: Parameters<typeof queries>) => {
            domReads++;
            return queries(...args);
          }) as typeof document.querySelectorAll;
          const repeat = (await operationResultCodec.deserialize(await submit())).unwrap();
          const status = (
            await operationResultCodec.deserialize(
              await f.workspace.getOperation(input.operationId),
            )
          ).unwrap();
          const afterQueries = f.stats();
          const queryDomReads = domReads;
          document.querySelector = query;
          document.querySelectorAll = queries;
          const successor = (
            await operationResultCodec.deserialize(
              await submit({
                ...input,
                article: operation === "cover" ? input.article : secondArticle,
                operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
              }),
            )
          ).unwrap();
          const lateNode = () =>
            operation === "cover"
              ? !document.querySelector<HTMLElement>("#synthetic-cover-crop")!.hidden
              : !!document.getElementById("history_pop");
          const beforeRelease = {
            late: lateNode(),
            libraryConnected: !!document.getElementById("synthetic-cover-library"),
            trace: [...(window as any).__mpctlFixtureAssets.coverTrace],
            toggles,
          };
          const shown = new Promise<void>((done) => {
            const observer = new MutationObserver(() => {
              if (lateNode()) {
                observer.disconnect();
                done();
              }
            });
            observer.observe(document.body, { attributes: true, childList: true, subtree: true });
          });
          release();
          await shown;
          const afterRelease = {
            late: lateNode(),
            trace: [...(window as any).__mpctlFixtureAssets.coverTrace],
            saves: (window as any).__mpctlFixtureAssets.nativeSaveCount,
            confirms: (window as any).__mpctlFixtureAssets.coverConfirms ?? 0,
            toggles,
          };
          domReads = 0;
          document.querySelector = ((...args: Parameters<typeof query>) => {
            domReads++;
            return query(...args);
          }) as typeof document.querySelector;
          document.querySelectorAll = ((...args: Parameters<typeof queries>) => {
            domReads++;
            return queries(...args);
          }) as typeof document.querySelectorAll;
          const statusLate = (
            await operationResultCodec.deserialize(
              await f.workspace.getOperation(input.operationId),
            )
          ).unwrap();
          const repeatLate = (await operationResultCodec.deserialize(await submit())).unwrap();
          const lateQueryDomReads = domReads;
          document.querySelector = query;
          document.querySelectorAll = queries;
          return {
            reply,
            receipt,
            before,
            afterQueries,
            repeat,
            status,
            successor,
            beforeRelease,
            afterRelease,
            statusLate,
            repeatLate,
            final: f.stats(),
            queryDomReads,
            lateQueryDomReads,
          };
        } finally {
          release();
          HTMLImageElement.prototype.decode = originalDecode;
          f.close();
        }
      }, operation);
      expect(result.receipt.ended).toBe(false);
      expect(result.reply.snapshot.state).toBe("settled");
      expect(result.repeat.snapshot).toEqual(result.reply.snapshot);
      expect(result.status.snapshot).toEqual(result.reply.snapshot);
      expect(result.afterQueries).toEqual({
        ...result.before,
        receipts:
          result.before.receipts +
          (result.reply.snapshot.effect.outcome === "not_dispatched" ? 0 : 1),
      });
      expect(result.queryDomReads).toBe(0);
      expect(result.lateQueryDomReads).toBe(0);
      expect(result.successor.snapshot.result.error).toMatchObject({
        code: "operation_blocked",
        blockingOperationId: result.reply.snapshot.operationId,
      });
      expect(result.beforeRelease.late).toBe(false);
      expect(result.afterRelease.late).toBe(true);
      expect(result.afterRelease.saves).toBe(0);
      expect(result.afterRelease.confirms).toBe(0);
      expect(result.statusLate.snapshot).toEqual(result.reply.snapshot);
      expect(result.repeatLate.snapshot).toEqual(result.reply.snapshot);
      // The provider receives the competing call and refuses it at the shared
      // document owner; no second native UI action is dispatched.
      expect(result.final.set).toBe(operation === "cover" ? 2 : 0);
      expect(result.final.save).toBe(operation === "save" ? 2 : 0);
      if (operation === "cover") {
        expect(result.beforeRelease.libraryConnected).toBe(false);
        expect(result.beforeRelease.trace).toEqual(["library-menu", "card", "next"]);
        expect(result.afterRelease.trace.filter((x: string) => x === "next")).toHaveLength(1);
      } else {
        expect(result.beforeRelease.toggles).toBe(1);
        expect(result.afterRelease.toggles).toBe(1);
      }
    } finally {
      await browser.close();
    }
  });

for (const mode of ["native-ok", "contradictory-cause", "contradictory-hash"] as const)
  test(`legacy pending BG ${mode} keeps first cause and refuses contradictory receipts`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await open(page);
      const result = await page.evaluate(async (mode) => {
        const url = "https://mp.weixin.qq.com/corrections.js";
        const { Result, createOperations, createWorkspace, operationResultCodec } = await import(
          url
        );
        const operations = (await createOperations()).unwrap();
        const id = `op:${operations.ledgerId}:${crypto.randomUUID()}`;
        const input = {
          operationId: id,
          article: "expired",
          asset: "expired",
          expectedCoverHash: "a".repeat(64),
        };
        const binding = {
          tabId: 1,
          documentId: "doc",
          route: "saved",
          executorId: crypto.randomUUID(),
        };
        const primary = {
          code: "content_conflict",
          cause: { at: "content.preflight", kind: "domain", code: "content_conflict" },
        };
        const cleanup = {
          at: "bg.pointer_cleanup",
          kind: "runtime",
          code: "pointer_cleanup_unknown",
        };
        const initialEffect =
          mode === "contradictory-cause"
            ? { cover: true, outcome: "not_dispatched" }
            : mode === "contradictory-hash"
              ? { cover: true, outcome: "confirmed", coverHash: "b".repeat(64) }
              : { cover: true, outcome: "unknown" };
        const previous = { ...primary, cleanup };
        await operations.claim({
          operationId: id,
          operation: "cover",
          requestDigest: "a".repeat(64),
          localRequestDigest: "b".repeat(64),
          effect: { cover: true, outcome: "not_dispatched" },
        });
        await operations.bind(id, binding);
        const first = (
          await operations.finish(id, initialEffect, { status: "error", error: previous })
        ).unwrap();
        const row = (await operations.record(id)).unwrap();
        const db = await new Promise<IDBDatabase>((resolve) => {
          const request = indexedDB.open("mpctl.operations", 1);
          request.onsuccess = () => resolve(request.result);
        });
        await new Promise<void>((resolve) => {
          const tx = db.transaction("operations", "readwrite");
          tx.objectStore("operations").put({ ...row, schemaVersion: 2, bgEffects: "pending" });
          tx.oncomplete = () => resolve();
        });
        db.close();
        let reads = 0;
        const nativeEffect =
          mode !== "contradictory-cause"
            ? { cover: true, outcome: "confirmed", coverHash: "c".repeat(64) }
            : row.snapshot.effect;
        const nativeResult =
          mode === "native-ok"
            ? { status: "ok", value: {} }
            : {
                status: "error",
                error:
                  mode === "contradictory-cause"
                    ? {
                        code: "target_unavailable",
                        cause: { ...primary.cause, code: "target_unavailable" },
                      }
                    : primary,
              };
        const workspace = createWorkspace({
          operations: Promise.resolve(Result.ok(operations)),
          pages: {
            getExecutionReceipt: async () => {
              reads++;
              return Result.ok({
                operationId: id,
                executorId: binding.executorId,
                requestDigest: row.localRequestDigest,
                effect: nativeEffect,
                ended: true,
                result: nativeResult,
              });
            },
          } as never,
        });
        const after = (
          await operationResultCodec.deserialize(await workspace.getOperation(id))
        ).unwrap();
        const again = (
          await operationResultCodec.deserialize(await workspace.getOperation(id))
        ).unwrap();
        const repeated = (await operations.get(input.operationId)).unwrap();
        return {
          first,
          after,
          again,
          row: (await operations.record(id)).unwrap(),
          reads,
          repeated,
        };
      }, mode);
      if (mode.startsWith("contradictory")) {
        expect(result.after.snapshot).toEqual(result.first.snapshot);
        expect(result.after.issue).toBeUndefined();
        expect(result.again.issue).toBeUndefined();
      } else {
        expect(result.after.snapshot.result.error).toEqual({
          code: "content_conflict",
          cause: { at: "content.preflight", kind: "domain", code: "content_conflict" },
          cleanup: {
            at: "bg.pointer_cleanup",
            kind: "runtime",
            code: "pointer_cleanup_unknown",
          },
        });
        expect(result.after.snapshot).toEqual(result.first.snapshot);
      }
      expect(result.again.snapshot).toEqual(result.after.snapshot);
      expect(result.row.snapshot).toEqual(result.after.snapshot);
      expect(result.row.bgEffects).toBe("pending");
      expect(result.reads).toBe(0);
      expect(result.repeated.snapshot).toEqual(result.row.snapshot);
    } finally {
      await browser.close();
    }
  });
