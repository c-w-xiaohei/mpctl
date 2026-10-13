import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

let temp: string;
let bundle: string;
let workspaceBundle: string;
let lifetimeBundle: string;
test.beforeAll(async () => {
  temp = await mkdtemp("/tmp/opencode/mpctl-operations-");
  const output = path.join(temp, "operations.js");
  execFileSync("bun", [
    "build",
    "src/operations.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${output}`,
  ]);
  bundle = await readFile(output, "utf8");
  const workspace = path.join(temp, "workspace.js");
  execFileSync("bun", [
    "build",
    "test/browser/fixtures/body-workspace.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${workspace}`,
  ]);
  workspaceBundle = await readFile(workspace, "utf8");
  const lifetime = path.join(temp, "lifetime.js");
  execFileSync("bun", [
    "build",
    "test/browser/fixtures/main-lifetime.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${lifetime}`,
  ]);
  lifetimeBundle = await readFile(lifetime, "utf8");
});
test.afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});
for (const mode of ["native-only", "completion-abort"] as const) {
  test(`SAVE ${mode} uses actual workspace and native IDB without post-native navigation`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("workspace.js")
          ? route.fulfill({ contentType: "text/javascript", body: workspaceBundle })
          : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
      );
      await page.goto("https://operations.test/");
      const result = await page.evaluate(async (mode) => {
        const url = "https://operations.test/workspace.js";
        const { fixture } = await import(url);
        const f = await fixture(true);
        const fields = await f.workspace.inspectArticle(f.first.article);
        const cover = await f.workspace.readArticleCover(f.first.article);
        const input = {
          operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
          article: f.first.article,
          expectedBodyHash: f.first.bodyHash,
          expectedFieldsHash: fields.value.fieldsHash,
          expectedCoverHash: cover.value.coverHash,
        };
        const put = IDBObjectStore.prototype.put;
        let aborted = 0;
        IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
          const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
          if (
            mode === "completion-abort" &&
            value.snapshot?.effect.outcome === "confirmed" &&
            value.bgEffects === "complete" &&
            value.snapshot?.operationId === input.operationId &&
            aborted === 0
          ) {
            aborted++;
            this.transaction.abort();
          }
          return request;
        };
        try {
          const first = await f.workspace.saveArticle(input);
          const before = { ...f.counters };
          const replay = await f.workspace.saveArticle(input);
          const query = await f.workspace.getOperation(input.operationId);
          const row = (await f.operations.record(input.operationId)).unwrap();
          const unchanged = JSON.stringify(before) === JSON.stringify(f.counters);
          const blocked = await f.workspace.cleanupWorkspace();
          return {
            first,
            replay,
            query,
            row,
            aborted,
            before,
            unchanged,
            blocked: blocked.status === "error" ? blocked.error.code : "ok",
          };
        } finally {
          IDBObjectStore.prototype.put = put;
        }
      }, mode);
      expect(result.first.value.snapshot).toMatchObject({
        state: mode === "native-only" ? "settled" : "unresolved",
        effect: {
          outcome: mode === "native-only" ? "confirmed" : "not_dispatched",
          persistence: "unverified",
        },
      });
      expect(result.replay.value.snapshot).toEqual(result.first.value.snapshot);
      expect(result.query.value.snapshot).toEqual(result.first.value.snapshot);
      expect(result.row.bgEffects).toBe("complete");
      // Two initial current reads for the two fixture refs, then SAVE preflight only.
      expect(result.before).toMatchObject({
        save: 1,
        reload: 0,
        get: 3,
      });
      expect(result.unchanged).toBe(true);
      expect(result.aborted).toBe(mode === "completion-abort" ? 1 : 0);
      expect(result.blocked === "operation_blocked").toBe(mode !== "native-only");
      if (mode === "completion-abort")
        expect(result.first.value.issue).toMatchObject({
          failure: { code: "storage_failed" },
          uncommitted: { effect: { outcome: "confirmed", persistence: "unverified" } },
        });
    } finally {
      await browser.close();
    }
  });
}

for (const mode of ["peer", "unavailable"] as const) {
  test(`F2/F4 Chromium mounted MAIN ${mode} before native set`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("lifetime.js")
          ? route.fulfill({ contentType: "text/javascript", body: lifetimeBundle })
          : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
      );
      await page.goto(
        "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
      );
      const result = await page.evaluate(async (mode) => {
        const url = "https://mp.weixin.qq.com/lifetime.js";
        return (await import(url)).peerClosePreflight(mode);
      }, mode);
      expect(result).toMatchObject({
        lost: mode === "peer",
        counts: { read: 1, set: 0 },
        receipt: {
          ended: true,
          effect: { outcome: "not_dispatched" },
          result: {
            status: "error",
            error: {
              code: mode === "peer" ? "target_unavailable" : "page_failed",
              cause: { code: mode === "peer" ? "target_unavailable" : "jsapi_unavailable" },
            },
          },
        },
      });
    } finally {
      await browser.close();
    }
  });
}

test("F0/F1/F2 actual workspace guards legacy writers, permits reads and independent validated article", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("workspace.js")
        ? route.fulfill({ contentType: "text/javascript", body: workspaceBundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const outcome = await page.evaluate(async () => {
      const url = "https://operations.test/workspace.js";
      const { fixture } = await import(url);
      const f = await fixture();
      const id = () => `op:${f.operations.ledgerId}:${crypto.randomUUID()}`;
      const firstId = id();
      const request = {
        article: f.first.article,
        html: "first",
        expectedHash: f.first.bodyHash,
        operationId: firstId,
      };
      const first = f.workspace.writeBody(request);
      await f.entered;
      const duplicate = f.workspace.writeBody(request);
      const independent = await f.workspace.writeBody({
        article: f.second.article,
        html: "second",
        expectedHash: f.second.bodyHash,
        operationId: id(),
      });
      const read = await f.workspace.inspectArticle(f.first.article);
      const reload = await f.operations.maintenance(async () => {
        f.counters.reload++;
      });
      const maintenance = await f.workspace.newArticle({ operationId: id() });
      f.release();
      const result = await first;
      await duplicate;
      // Persisted unresolved evidence with exact A binding, after original execution ends.
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open("mpctl.operations", 1);
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise<void>((resolve) => {
        const tx = db.transaction("operations", "readwrite");
        const store = tx.objectStore("operations");
        const get = store.get(firstId);
        get.onsuccess = () => {
          const record = get.result;
          record.snapshot.state = "unresolved";
          record.snapshot.result = { status: "error", error: { code: "operation_unresolved" } };
          store.put(record);
        };
        tx.oncomplete = () => resolve();
      });
      const blocked = await Promise.all([
        f.workspace.updateArticleFields({
          operationId: id(),
          article: f.first.article,
          fields: { title: "no" },
          expectedHash: "a".repeat(64),
        }),
        f.workspace.uploadAsset({
          article: f.first.article,
          operationId: id(),
          blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
            type: "image/png",
          }),
          filename: "x.png",
          mimeType: "image/png",
        }),
        f.workspace.saveArticle({
          operationId: id(),
          article: f.first.article,
          expectedBodyHash: "a".repeat(64),
          expectedFieldsHash: "b".repeat(64),
          expectedCoverHash: "c".repeat(64),
        }),
        f.workspace.setArticleCover({
          operationId: id(),
          article: f.first.article,
          asset: "missing-asset",
          expectedCoverHash: "c".repeat(64),
        }),
        f.workspace.listAssets(f.first.article),
      ]);
      f.unknownContext();
      const unknown = await f.workspace.writeBody({
        article: f.second.article,
        html: "unknown context",
        expectedHash: f.second.bodyHash,
        operationId: id(),
      });
      const query = await f.workspace.getOperation(firstId);
      return {
        independent: independent.value.snapshot.state,
        read: read.status,
        maintenance: maintenance.value.snapshot.result.error.code,
        reload: reload.error.failure.code,
        blocked: blocked.map((reply: any) =>
          reply.status === "error" ? reply.error.code : reply.value.snapshot.result.error.code,
        ),
        unknown: unknown.value.snapshot.result.error.code,
        result: result.value.snapshot.state,
        counts: f.counters,
        query: query.status,
      };
    });
    expect(outcome).toMatchObject({
      independent: "settled",
      read: "ok",
      maintenance: "operation_blocked",
      reload: "operation_blocked",
      blocked: Array(5).fill("operation_blocked"),
      unknown: "relationship_unknown",
      result: "settled",
      counts: { set: 2, field: 0, cover: 0, upload: 0, save: 0, reload: 0, navigation: 0 },
    });
  } finally {
    await browser.close();
  }
});

test("F3 native IDB rejects terminal fields history contradictions before union and preserves pending ownership", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const result = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const operations = (await createOperations()).unwrap();
      const input = {
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
        article: "original-ref",
        fields: { title: "New", author: "Later" },
        expectedHash: "a".repeat(64),
      };
      const binding = {
        tabId: 1,
        documentId: "doc",
        route: "editor",
        executorId: crypto.randomUUID(),
      };
      const empty = {
        outcome: "not_dispatched",
        requested: ["title", "author"],
        attempted: [],
        confirmed: [],
        unknown: [],
      };
      const running = {
        effect: { ...empty, outcome: "partial", attempted: ["title"], confirmed: ["title"] },
        ended: false,
        result: { status: "error", error: { code: "operation_unresolved" } },
      };
      let native = 0;
      const first = (
        await operations.run(input, (execution: any) =>
          execution.issue(binding, async () => {
            native++;
            return running;
          }),
        )
      ).unwrap();
      const record = (await operations.record(input.operationId)).unwrap();
      const rejected = [];
      for (const terminal of [
        {
          effect: { ...empty, outcome: "confirmed", fieldsHash: "b".repeat(64) },
          ended: true,
          result: { status: "ok", value: {} },
        },
        {
          ...running,
          effect: { ...running.effect, outcome: "unknown", confirmed: [], unknown: ["title"] },
          ended: true,
        },
      ]) {
        const reply = (
          await operations.observe(input.operationId, record.requestDigest, binding, terminal)
        ).unwrap();
        const pending = (await operations.pending()).unwrap();
        const maintenance = await operations.maintenance(() => {
          throw new Error("contradiction released ownership");
        });
        rejected.push({
          reply,
          pending: pending.map((row: any) => row.snapshot.operationId),
          maintenance: maintenance.error.failure.code,
        });
      }
      const low = (
        await operations.observe(input.operationId, record.requestDigest, binding, {
          ...running,
          effect: empty,
        })
      ).unwrap();
      const same = (
        await operations.observe(input.operationId, record.requestDigest, binding, running)
      ).unwrap();
      const terminal = { ...running, ended: true };
      const ended = (
        await operations.observe(input.operationId, record.requestDigest, binding, terminal)
      ).unwrap();
      const repeated = (
        await operations.observe(input.operationId, record.requestDigest, binding, terminal)
      ).unwrap();
      const replay = (
        await operations.run(input, async () => {
          throw new Error("must not resume fields");
        })
      ).unwrap();
      const lateLow = (
        await operations.observe(input.operationId, record.requestDigest, binding, {
          ...running,
          effect: empty,
        })
      ).unwrap();
      const bodyInput = {
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
        article: "body-ref",
        html: "next",
        expectedHash: "a".repeat(64),
      };
      await operations.run(bodyInput, (execution: any) =>
        execution.issue(binding, async () => ({
          effect: { outcome: "unknown" },
          ended: false,
          result: { status: "error", error: { code: "operation_unresolved" } },
        })),
      );
      const bodyRecord = (await operations.record(bodyInput.operationId)).unwrap();
      const body = (
        await operations.observe(bodyInput.operationId, bodyRecord.requestDigest, binding, {
          effect: { outcome: "not_dispatched" },
          ended: true,
          result: { status: "error", error: { code: "target_unavailable" } },
        })
      ).unwrap();
      return {
        first,
        rejected,
        low,
        same,
        ended,
        repeated,
        replay,
        lateLow,
        body,
        native,
        pending: (await operations.pending()).unwrap().length,
      };
    });
    for (const rejected of result.rejected) {
      expect(rejected.reply.issue.failure.code).toBe("evidence_conflict");
      expect(rejected.reply.snapshot).toEqual(result.first.snapshot);
      expect(rejected.pending).toEqual([result.first.snapshot.operationId]);
      expect(rejected.maintenance).toBe("operation_blocked");
    }
    expect(result.low).toEqual(result.first);
    expect(result.same).toEqual(result.first);
    expect(result.ended.snapshot).toMatchObject({
      state: "settled",
      effect: { confirmed: ["title"], attempted: ["title"] },
    });
    expect(result.repeated).toEqual(result.ended);
    expect(result.replay).toEqual(result.ended);
    expect(result.lateLow).toEqual(result.ended);
    expect(result.body.snapshot).toMatchObject({
      state: "settled",
      effect: { outcome: "unknown" },
      result: { status: "error", error: { code: "target_unavailable" } },
    });
    expect(result.pending).toBe(0);
    expect(result.native).toBe(1);
  } finally {
    await browser.close();
  }
});

test("K0/K1/K3/P5 fields use the one native IDB ledger, preserve partial and refuse replay after commit loss", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const result = await page.evaluate(async () => {
      const moduleUrl = "https://operations.test/operations.js";
      const { createOperations } = await import(moduleUrl);
      const operations = (await createOperations()).unwrap();
      const input = {
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
        article: "old-ref",
        fields: { title: "New", author: "new", summary: "not attempted" },
        expectedHash: "a".repeat(64),
      };
      const binding = {
        tabId: 1,
        documentId: "doc",
        route: "editor",
        executorId: crypto.randomUUID(),
      };
      let work = 0,
        native = 0;
      let release!: () => void, reached!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const entered = new Promise<void>((done) => {
        reached = done;
      });
      const observation = {
        effect: {
          outcome: "partial",
          requested: ["title", "author", "summary"],
          attempted: ["title", "author"],
          confirmed: ["title"],
          unknown: ["author"],
        },
        ended: true,
        result: {
          status: "error",
          error: {
            code: "target_unavailable",
            cause: { at: "content.guard", kind: "domain", code: "target_unavailable" },
          },
        },
      };
      const callback = async (execution: any) => {
        work++;
        return execution.issue(binding, async () => {
          native++;
          reached();
          await gate;
          return observation;
        });
      };
      const original = operations.run(input, callback);
      await entered;
      const duplicate = operations.run(
        { ...input, fields: { summary: "not attempted", author: "new", title: "New" } },
        callback,
      );
      const mismatch = (
        await operations.run({ ...input, fields: { title: "New", author: "new" } }, callback)
      ).error.failure.code;
      const wrongOperation = (
        await operations.run(
          {
            operationId: input.operationId,
            article: input.article,
            html: "New",
            expectedHash: input.expectedHash,
          },
          callback,
        )
      ).error.failure.code;
      release();
      const first = (await original).unwrap();
      const repeated = (await duplicate).unwrap();
      const historical = (
        await operations.run(input, async () => {
          throw new Error("must not resolve old ref");
        })
      ).unwrap();
      const record = (await operations.record(input.operationId)).unwrap();
      const contradiction = (
        await operations.observe(input.operationId, record.requestDigest, binding, {
          ...observation,
          effect: {
            outcome: "not_dispatched",
            requested: ["title", "author", "summary"],
            attempted: [],
            confirmed: [],
            unknown: [],
          },
        })
      ).unwrap();
      const prototype = IDBObjectStore.prototype.put;
      let aborted = 0;
      const commitInput = {
        ...input,
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
      };
      IDBObjectStore.prototype.put = function (value, ...args) {
        const request = prototype.call(this, value, ...args);
        if (
          this.name === "operations" &&
          value.snapshot.operationId === commitInput.operationId &&
          value.snapshot.state === "settled" &&
          !aborted
        ) {
          aborted++;
          this.transaction.abort();
        }
        return request;
      };
      let lost;
      try {
        lost = (
          await operations.run(commitInput, (execution: any) =>
            execution.issue(binding, async () => {
              native++;
              return observation;
            }),
          )
        ).unwrap();
      } finally {
        IDBObjectStore.prototype.put = prototype;
      }
      const afterLoss = (await operations.run(commitInput, callback)).unwrap();
      return {
        first,
        repeated,
        historical,
        mismatch,
        wrongOperation,
        contradiction,
        lost,
        afterLoss,
        work,
        native,
        aborted,
      };
    });
    expect(result.first.snapshot).toMatchObject({
      operation: "fields",
      state: "settled",
      effect: { confirmed: ["title"], unknown: ["author"], attempted: ["title", "author"] },
    });
    expect(result.repeated).toEqual(result.first);
    expect(result.historical).toEqual(result.first);
    expect(result.mismatch).toBe("operation_conflict");
    expect(result.wrongOperation).toBe("operation_conflict");
    expect(result.contradiction.issue?.failure.code).toBe("evidence_conflict");
    expect(result.contradiction.snapshot).toEqual(result.first.snapshot);
    expect(result.work).toBe(1);
    expect(result.native).toBe(2);
    expect(result.aborted).toBe(1);
    expect(result.lost.issue?.uncommitted?.effect).toEqual(result.first.snapshot.effect);
    expect(result.lost.snapshot.state).toBe("unresolved");
    expect(result.afterLoss.snapshot).toEqual(result.lost.snapshot);
  } finally {
    await browser.close();
  }
});

test("K0/TM0 actual IDB same-key claim runs work/native exactly once", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      if (route.request().url() === "https://operations.test/operations.js")
        return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (route.request().url() === "https://operations.test/")
        return route.fulfill({ contentType: "text/html", body: "<!doctype html>" });
      return route.abort();
    });
    await page.goto("https://operations.test/");
    const outcome = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const initialized = await createOperations();
      if (initialized.isErr()) return { initialized: false, error: initialized.error };
      const operations = initialized.value;
      const operationId = `op:${operations.ledgerId}:${crypto.randomUUID()}`;
      const request = {
        operationId,
        article: "ephemeral:test",
        html: "next",
        expectedHash: "a".repeat(64),
      };
      let workCount = 0;
      let nativeCount = 0;
      const work = async (execution: any) => {
        workCount++;
        return execution.issue(
          { tabId: 1, documentId: "doc", route: "new", executorId: crypto.randomUUID() },
          async () => {
            nativeCount++;
            return {
              effect: { outcome: "confirmed", bodyHash: "b".repeat(64) },
              ended: true,
              result: { status: "ok", value: {} },
            };
          },
        );
      };
      const replies = await Promise.all([
        operations.run(request, work),
        operations.run(request, work),
      ]);
      return {
        initialized: true,
        workCount,
        nativeCount,
        states: replies.map((result: any) => result.value?.snapshot.state),
        stored: (await operations.get(operationId)).value?.snapshot.state,
      };
    });
    expect(outcome).toEqual({
      initialized: true,
      workCount: 1,
      nativeCount: 1,
      states: ["settled", "settled"],
      stored: "settled",
    });
  } finally {
    await browser.close();
  }
});

test("P2/P5 real transaction abort gates dispatch and retains uncommitted confirmation", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const outcomes = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const operations = (await createOperations()).unwrap();
      const nativePut = IDBObjectStore.prototype.put;
      let abortState = "issued";
      const aborted: string[] = [];
      IDBObjectStore.prototype.put = function (value: any, ...args: any[]) {
        const request = nativePut.call(this, value, ...args);
        if (value.snapshot?.state === abortState) {
          const state = abortState;
          abortState = "";
          request.addEventListener("success", () => {
            aborted.push(state);
            this.transaction.abort();
          });
        }
        return request;
      };
      try {
        let nativeCount = 0;
        const binding = {
          tabId: 1,
          documentId: "doc",
          route: "new",
          executorId: crypto.randomUUID(),
        };
        const evidence = {
          effect: { outcome: "confirmed", bodyHash: "b".repeat(64) },
          ended: true,
          result: { status: "ok", value: {} },
        };
        const work = (execution: any) =>
          execution.issue(binding, async () => {
            nativeCount++;
            return evidence;
          });
        const request = (id: string) => ({
          operationId: id,
          article: "ref",
          html: "next",
          expectedHash: "a".repeat(64),
        });
        const firstId = `op:${operations.ledgerId}:${crypto.randomUUID()}`;
        const first = (await operations.run(request(firstId), work)).unwrap();
        const afterIssueFailure = nativeCount;
        const firstStored = (await operations.get(firstId)).unwrap().snapshot.state;
        abortState = "settled";
        const secondId = `op:${operations.ledgerId}:${crypto.randomUUID()}`;
        const second = (await operations.run(request(secondId), work)).unwrap();
        await operations.run(request(secondId), work);
        const stored = (await operations.get(secondId)).unwrap().snapshot;
        return {
          aborted,
          afterIssueFailure,
          firstStored,
          firstIssue: first.issue?.failure.code,
          nativeCount,
          storedState: stored.state,
          storedEffect: stored.effect.outcome,
          uncommitted: second.issue?.uncommitted?.effect.outcome,
        };
      } finally {
        IDBObjectStore.prototype.put = nativePut;
      }
    });
    expect(outcomes).toEqual({
      aborted: ["issued", "settled"],
      afterIssueFailure: 0,
      firstStored: "settled",
      firstIssue: "storage_failed",
      nativeCount: 1,
      storedState: "unresolved",
      storedEffect: "not_dispatched",
      uncommitted: "confirmed",
    });
  } finally {
    await browser.close();
  }
});

test("H0/K1 issue is synchronously single-use and pending different payload cannot inherit work", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const outcome = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const operations = (await createOperations()).unwrap();
      const request = {
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
        article: "ref",
        html: "next",
        expectedHash: "a".repeat(64),
      };
      let nativeCount = 0;
      let reached!: () => void;
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const entered = new Promise<void>((done) => {
        reached = done;
      });
      let secondCode = "";
      const first = operations.run(request, async (execution: any) => {
        reached();
        await gate;
        const binding = {
          tabId: 1,
          documentId: "doc",
          route: "new",
          executorId: crypto.randomUUID(),
        };
        const action = async () => {
          nativeCount++;
          return {
            effect: { outcome: "confirmed", bodyHash: "b".repeat(64) },
            ended: true,
            result: { status: "ok", value: {} },
          };
        };
        const original = execution.issue(binding, action);
        try {
          await execution.issue(binding, action);
        } catch (error: any) {
          secondCode = error.code;
        }
        return original;
      });
      await entered;
      const mismatch = await operations.run({ ...request, html: "different" }, () => {
        throw new Error("must not run");
      });
      release();
      const result = (await first).unwrap();
      return {
        nativeCount,
        secondCode,
        mismatch: mismatch.error?.failure.code,
        state: result.snapshot.state,
      };
    });
    expect(outcome).toEqual({
      nativeCount: 1,
      secondCode: "execution_consumed",
      mismatch: "operation_conflict",
      state: "settled",
    });
  } finally {
    await browser.close();
  }
});

test("H0 early work return cannot settle before its issued action has ended", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const outcome = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const operations = (await createOperations()).unwrap();
      const id = `op:${operations.ledgerId}:${crypto.randomUUID()}`;
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const entered = new Promise<void>((done) => {
        reached = done;
      });
      let completed = false;
      let calls = 0;
      const pending = operations
        .run(
          { operationId: id, article: "ref", html: "next", expectedHash: "a".repeat(64) },
          async (execution: any) => {
            void execution.issue(
              { tabId: 1, documentId: "doc", route: "new", executorId: crypto.randomUUID() },
              async () => {
                calls++;
                reached();
                await gate;
                return {
                  effect: { outcome: "confirmed", bodyHash: "b".repeat(64) },
                  ended: true,
                  result: { status: "ok", value: {} },
                };
              },
            );
            return {
              effect: { outcome: "not_dispatched" },
              ended: true,
              result: { status: "error", error: { code: "page_failed" } },
            };
          },
        )
        .then((result: any) => {
          completed = true;
          return result;
        });
      await entered;
      const before = { completed, state: (await operations.get(id)).unwrap().snapshot.state };
      release();
      return { before, calls, after: (await pending).unwrap().snapshot.state };
    });
    expect(outcome).toEqual({
      before: { completed: false, state: "issued" },
      calls: 1,
      after: "settled",
    });
  } finally {
    await browser.close();
  }
});

test("R4 settled observation is current on duplicate run and contradictory terminal evidence is rejected", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const outcome = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const operations = (await createOperations()).unwrap();
      const request = {
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
        article: "ref",
        html: "next",
        expectedHash: "a".repeat(64),
      };
      const binding = {
        tabId: 1,
        documentId: "doc",
        route: "new",
        executorId: crypto.randomUUID(),
      };
      let calls = 0;
      const first = await operations.run(request, (execution: any) =>
        execution.issue(binding, async () => {
          calls++;
          return {
            effect: { outcome: "unknown" },
            ended: false,
            result: { status: "error", error: { code: "write_unknown" } },
          };
        }),
      );
      const record = (await operations.record(request.operationId)).unwrap();
      const observation = {
        effect: { outcome: "confirmed", bodyHash: "b".repeat(64) },
        ended: true,
        result: { status: "ok", value: {} },
      };
      await operations.observe(request.operationId, record.requestDigest, binding, observation);
      const duplicate = (
        await operations.run(request, () => {
          throw new Error("must not rerun");
        })
      ).unwrap();
      const contradiction = (
        await operations.observe(request.operationId, record.requestDigest, binding, {
          ...observation,
          result: { status: "error", error: { code: "content_conflict" } },
        })
      ).unwrap();
      return {
        first: first.value.snapshot.state,
        duplicate: duplicate.snapshot.state,
        effect: duplicate.snapshot.effect.outcome,
        contradiction: contradiction.issue?.failure.code,
        result: contradiction.snapshot.result.status,
        calls,
      };
    });
    expect(outcome).toEqual({
      first: "unresolved",
      duplicate: "settled",
      effect: "confirmed",
      contradiction: "evidence_conflict",
      result: "ok",
      calls: 1,
    });
  } finally {
    await browser.close();
  }
});

test("R6 checkpoint and active observe preserve the outer action's issued state", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const outcome = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const operations = (await createOperations()).unwrap();
      const id = `op:${operations.ledgerId}:${crypto.randomUUID()}`;
      const binding = {
        tabId: 1,
        documentId: "doc",
        route: "new",
        executorId: crypto.randomUUID(),
      };
      const observation = {
        effect: { outcome: "confirmed", bodyHash: "b".repeat(64) },
        ended: true,
        result: { status: "ok", value: {} },
      };
      let reached!: () => void;
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const entered = new Promise<void>((done) => {
        reached = done;
      });
      const run = operations.run(
        { operationId: id, article: "ref", html: "next", expectedHash: "a".repeat(64) },
        (execution: any) =>
          execution.issue(binding, async () => {
            await execution.checkpoint(observation);
            reached();
            await gate;
            return observation;
          }),
      );
      await entered;
      const record = (await operations.record(id)).unwrap();
      const observed = (
        await operations.observe(id, record.requestDigest, binding, observation)
      ).unwrap();
      release();
      const result = (await run).unwrap();
      return {
        checkpoint: record.snapshot.state,
        observed: observed.snapshot.state,
        finished: result.snapshot.state,
      };
    });
    expect(outcome).toEqual({ checkpoint: "issued", observed: "issued", finished: "settled" });
  } finally {
    await browser.close();
  }
});

test("B-S2/H1 actual IDB checkpoint request success then abort retains confirmed uncommitted and zero continuation", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const result = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const operations = (await createOperations()).unwrap();
      const id = `op:${operations.ledgerId}:${crypto.randomUUID()}`;
      let saves = 0,
        reloads = 0,
        lists = 0,
        aborted = 0;
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: any, ...args: any[]) {
        const request = original.call(this, value, ...args);
        if (
          !aborted &&
          value.snapshot?.operation === "save" &&
          value.snapshot.effect.outcome === "confirmed"
        )
          request.addEventListener("success", () => {
            aborted++;
            this.transaction.abort();
          });
        return request;
      };
      const input = {
        operationId: id,
        article: "ref",
        expectedBodyHash: "a".repeat(64),
        expectedFieldsHash: "b".repeat(64),
        expectedCoverHash: "c".repeat(64),
      };
      const binding = {
        tabId: 1,
        documentId: "original",
        route: "saved",
        executorId: crypto.randomUUID(),
      };
      const run = await operations.run(input, (execution: any) =>
        execution.issue(binding, async () => {
          saves++;
          const evidence = {
            effect: { outcome: "confirmed", persistence: "unverified" },
            ended: false,
            result: {
              status: "error",
              error: {
                code: "cleanup_failed",
                cause: { at: "content.history_cleanup", kind: "domain", code: "cleanup_failed" },
              },
            },
          };
          await execution.checkpoint(evidence);
          lists++;
          reloads++;
          return evidence;
        }),
      );
      IDBObjectStore.prototype.put = original;
      const row = (await operations.record(id)).unwrap();
      const repeated = await operations.run(input, () => {
        throw new Error("no resume");
      });
      return { run, row, repeated, counts: { saves, reloads, lists, aborted } };
    });
    expect(result.counts).toEqual({ saves: 1, reloads: 0, lists: 0, aborted: 1 });
    expect(result.run.value.issue).toMatchObject({
      failure: { code: "storage_failed" },
      uncommitted: {
        effect: { outcome: "confirmed", persistence: "unverified" },
        result: { status: "error", error: { code: "cleanup_failed" } },
      },
    });
    expect(result.row.snapshot).toMatchObject({
      state: "unresolved",
      effect: { outcome: "not_dispatched", persistence: "unverified" },
    });
    expect(result.repeated.value.snapshot).toEqual(result.row.snapshot);
  } finally {
    await browser.close();
  }
});

test("storage reconstruction settles old accepted; corrupt records and ledger loss fail closed", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const outcome = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const original = (await createOperations()).unwrap();
      let release!: () => void;
      let signal!: () => void;
      const entered = new Promise<void>((done) => {
        signal = done;
      });
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const id = `op:${original.ledgerId}:${crypto.randomUUID()}`;
      const run = original.run(
        { operationId: id, article: "ref", html: "next", expectedHash: "a".repeat(64) },
        async () => {
          signal();
          await gate;
          return {
            effect: { outcome: "not_dispatched" },
            ended: true,
            result: { status: "error", error: { code: "target_unavailable" } },
          };
        },
      );
      await entered;
      const restored = (await createOperations()).unwrap();
      const accepted = (await restored.get(id)).unwrap().snapshot;
      let extra = 0;
      await restored.run(
        { operationId: id, article: "ref", html: "next", expectedHash: "a".repeat(64) },
        () => {
          extra++;
          throw new Error("must not run");
        },
      );
      release();
      await run;
      const alternate = (await createOperations("mpctl.rebuilt")).unwrap();
      const mismatch = await alternate.run(
        { operationId: id, article: "ref", html: "next", expectedHash: "a".repeat(64) },
        () => {
          extra++;
          throw new Error("must not run");
        },
      );
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open("mpctl.operations", 1);
        request.onsuccess = () => resolve(request.result);
      });
      const retained = (await restored.record(id)).unwrap();
      await new Promise<void>((resolve) => {
        const tx = db.transaction("operations", "readwrite");
        tx.objectStore("operations").put({ ...retained, schemaVersion: 99 });
        tx.oncomplete = () => resolve();
      });
      const corrupt = await restored.run(
        { operationId: id, article: "ref", html: "next", expectedHash: "a".repeat(64) },
        () => {
          extra++;
          throw new Error("must not run");
        },
      );
      const corruptRestart = await createOperations();
      await new Promise<void>((resolve) => {
        const tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put({ schemaVersion: 99, ledgerId: original.ledgerId }, "ledger");
        tx.oncomplete = () => resolve();
      });
      const incompatible = await createOperations();
      db.close();
      return {
        acceptedState: accepted.state,
        result: accepted.result.error.code,
        extra,
        mismatch: mismatch.error?.failure.code,
        incompatible: incompatible.error?.failure.code,
        corrupt: corrupt.error?.failure.code,
        corruptRestart: corruptRestart.error?.failure.code,
      };
    });
    expect(outcome).toEqual({
      acceptedState: "settled",
      result: "operation_interrupted",
      extra: 0,
      mismatch: "ledger_mismatch",
      incompatible: "ledger_incompatible",
      corrupt: "ledger_incompatible",
      corruptRestart: "ledger_incompatible",
    });
  } finally {
    await browser.close();
  }
});

test("R5/R7/F3 wrong bindings and aborted observe preserve facts and never release another operation", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const outcome = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const operations = (await createOperations()).unwrap();
      const binding = {
        tabId: 1,
        documentId: "doc",
        route: "new",
        executorId: crypto.randomUUID(),
      };
      const request = () => ({
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
        article: "ref",
        html: "next",
        expectedHash: "a".repeat(64),
      });
      const a = request();
      const b = request();
      let native = 0;
      const work = (execution: any) =>
        execution.issue(binding, async () => {
          native++;
          return {
            effect: { outcome: "unknown" },
            ended: false,
            result: { status: "error", error: { code: "write_unknown" } },
          };
        });
      await operations.run(a, work);
      await operations.run(b, work);
      const record = (await operations.record(a.operationId)).unwrap();
      const observation = {
        effect: { outcome: "confirmed", bodyHash: "b".repeat(64) },
        ended: true,
        result: { status: "ok", value: {} },
      };
      const mismatch = (
        await operations.observe(
          a.operationId,
          record.requestDigest,
          { ...binding, executorId: crypto.randomUUID() },
          observation,
        )
      ).unwrap();
      const nativePut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: any, ...args: any[]) {
        const result = nativePut.call(this, value, ...args);
        if (value.snapshot?.state === "settled")
          result.addEventListener("success", () => this.transaction.abort());
        return result;
      };
      const failed = (
        await operations.observe(a.operationId, record.requestDigest, binding, observation)
      ).unwrap();
      IDBObjectStore.prototype.put = nativePut;
      await operations.observe(a.operationId, record.requestDigest, binding, observation);
      const late = (
        await operations.observe(a.operationId, record.requestDigest, binding, {
          effect: { outcome: "unknown" },
          ended: false,
          result: { status: "error", error: { code: "write_unknown" } },
        })
      ).unwrap();
      const pending = (await operations.pending()).unwrap();
      await operations.run(a, work);
      const mismatchDigest = (
        await operations.observe(b.operationId, "0".repeat(64), binding, observation)
      ).unwrap();
      const actionRequest = {
        ...b,
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
      };
      const thrown = (
        await operations.run(actionRequest, (execution: any) =>
          execution.issue(binding, async () => {
            native++;
            throw new Error("action after native failed");
          }),
        )
      ).unwrap();
      await operations.run(actionRequest, work);
      return {
        native,
        mismatch: mismatch.issue.failure.code,
        failed: failed.issue.failure.code,
        storedAtFailure: failed.snapshot.effect.outcome,
        uncommitted: failed.issue.uncommitted.effect.outcome,
        late: late.snapshot.state,
        pending: pending.map((row: any) => row.snapshot.operationId),
        b: b.operationId,
        mismatchDigest: mismatchDigest.issue.failure.code,
        thrown: { state: thrown.snapshot.state, effect: thrown.snapshot.effect.outcome },
      };
    });
    expect(outcome).toMatchObject({
      native: 3,
      mismatch: "evidence_conflict",
      failed: "storage_failed",
      storedAtFailure: "unknown",
      uncommitted: "confirmed",
      late: "settled",
      mismatchDigest: "evidence_conflict",
      thrown: { state: "unresolved", effect: "unknown" },
    });
    expect(outcome.pending).toEqual([outcome.b]);
  } finally {
    await browser.close();
  }
});

test("TM0/P0/H0 maintenance reserves synchronously before IDB and closed handles never reissue", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const outcome = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const operations = (await createOperations()).unwrap();
      let native = 0;
      let handle: any;
      const request = {
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
        article: "ref",
        html: "next",
        expectedHash: "a".repeat(64),
      };
      const binding = {
        tabId: 1,
        documentId: "doc",
        route: "new",
        executorId: crypto.randomUUID(),
      };
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const maintenance = operations.maintenance(async () => gate);
      const blocked = await operations.run(request, () => {
        native++;
        throw new Error("must not run");
      });
      release();
      await maintenance;
      const settled = (
        await operations.run(request, async (execution: any) => {
          handle = execution;
          throw new Error("pre-issue exception");
        })
      ).unwrap();
      let closed = "";
      try {
        await handle.issue(binding, () => {
          native++;
        });
      } catch (error: any) {
        closed = error.code;
      }
      await operations.run(request, () => {
        native++;
        throw new Error("must not run");
      });
      return {
        blocked: blocked.error.failure.code,
        settled: settled.snapshot.state,
        effect: settled.snapshot.effect.outcome,
        closed,
        native,
      };
    });
    expect(outcome).toEqual({
      blocked: "operation_blocked",
      settled: "settled",
      effect: "not_dispatched",
      closed: "execution_closed",
      native: 0,
    });
  } finally {
    await browser.close();
  }
});

test("TM4 duplicate during terminal transaction waits for complete; request success is not durability", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const outcome = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const operations = (await createOperations()).unwrap();
      const request = {
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
        article: "ref",
        html: "next",
        expectedHash: "a".repeat(64),
      };
      let entered!: () => void;
      const committing = new Promise<void>((done) => {
        entered = done;
      });
      let release = false;
      let complete = false;
      let settled = false;
      let native = 0;
      let completed!: () => void;
      const committed = new Promise<void>((done) => {
        completed = done;
      });
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: any, ...args: any[]) {
        const result = put.call(this, value, ...args);
        if (value.snapshot?.state === "settled") {
          const tx = this.transaction;
          tx.addEventListener("complete", () => {
            complete = true;
            completed();
          });
          result.addEventListener("success", () => {
            entered();
            const keepAlive = () => {
              if (release) return;
              const pending = this.get(value.snapshot.operationId);
              pending.addEventListener("success", keepAlive);
            };
            keepAlive();
          });
        }
        return result;
      };
      try {
        const first = operations
          .run(request, (execution: any) =>
            execution.issue(
              { tabId: 1, documentId: "doc", route: "new", executorId: crypto.randomUUID() },
              async () => {
                native++;
                return {
                  effect: { outcome: "confirmed", bodyHash: "b".repeat(64) },
                  ended: true,
                  result: { status: "ok", value: {} },
                };
              },
            ),
          )
          .then((result: any) => {
            settled = true;
            return result;
          });
        await committing;
        const duplicate = operations.run(request, () => {
          native++;
          throw new Error("must not run");
        });
        const before = { settled, complete, native };
        release = true;
        const results = await Promise.all([first, duplicate]);
        await committed;
        return {
          before,
          complete,
          native,
          states: results.map((result: any) => result.value.snapshot.state),
        };
      } finally {
        IDBObjectStore.prototype.put = put;
      }
    });
    expect(outcome).toEqual({
      before: { settled: false, complete: false, native: 1 },
      complete: true,
      native: 1,
      states: ["settled", "settled"],
    });
  } finally {
    await browser.close();
  }
});

test("TM0/K1/P0 reservation precedes asynchronous hash; aborted claim yields zero work/native", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("operations.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const outcome = await page.evaluate(async () => {
      const url = "https://operations.test/operations.js";
      const { createOperations } = await import(url);
      const operations = (await createOperations()).unwrap();
      let work = 0;
      let native = 0;
      const request = {
        operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
        article: "ref",
        html: "next",
        expectedHash: "a".repeat(64),
      };
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      let digestCalls = 0;
      crypto.subtle.digest = async (...args: Parameters<typeof crypto.subtle.digest>) => {
        if (++digestCalls === 1) await gate;
        return digest(...args);
      };
      const action = (execution: any) => {
        work++;
        return execution.issue(
          { tabId: 1, documentId: "doc", route: "new", executorId: crypto.randomUUID() },
          async () => {
            native++;
            return {
              effect: { outcome: "confirmed", bodyHash: "b".repeat(64) },
              ended: true,
              result: { status: "ok", value: {} },
            };
          },
        );
      };
      const first = operations.run(request, action);
      const duplicate = operations.run(request, action);
      const mismatch = await operations.run({ ...request, html: "different" }, action);
      const before = {
        work,
        native,
        digestCalls,
        shared: first === duplicate,
        mismatch: mismatch.error.failure.code,
      };
      release();
      await first;
      crypto.subtle.digest = digest;
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (value: any, ...args: any[]) {
        const added = add.call(this, value, ...args);
        added.addEventListener("success", () => this.transaction.abort());
        return added;
      };
      const aborted = await operations.run(
        { ...request, operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}` },
        action,
      );
      IDBObjectStore.prototype.add = add;
      return { before, work, native, aborted: aborted.error.failure.code };
    });
    expect(outcome).toEqual({
      before: { work: 0, native: 0, digestCalls: 1, shared: true, mismatch: "operation_conflict" },
      work: 1,
      native: 1,
      aborted: "storage_failed",
    });
  } finally {
    await browser.close();
  }
});

test("R3 workspace status keeps historical snapshot for missing/unreachable/malformed/misbound receipts", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("workspace.js")
        ? route.fulfill({ contentType: "text/javascript", body: workspaceBundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://operations.test/");
    const outcome = await page.evaluate(async () => {
      const url = "https://operations.test/workspace.js";
      const { fixture } = await import(url);
      const f = await fixture();
      const id = `op:${f.operations.ledgerId}:${crypto.randomUUID()}`;
      await f.workspace.writeBody({
        article: f.second.article,
        operationId: id,
        html: "next",
        expectedHash: f.second.bodyHash,
      });
      const record = (await f.operations.record(id)).unwrap();
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open("mpctl.operations", 1);
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise<void>((resolve) => {
        const tx = db.transaction("operations", "readwrite");
        tx.objectStore("operations").put({
          ...record,
          snapshot: {
            ...record.snapshot,
            state: "unresolved",
            result: { status: "error", error: { code: "operation_unresolved" } },
          },
        });
        tx.oncomplete = () => resolve();
      });
      const real = f.pages.getBodyReceipt;
      const counters = { ...f.counters };
      const replies = [];
      f.pages.getBodyReceipt = async () =>
        await real(record.binding, `op:${f.operations.ledgerId}:${crypto.randomUUID()}`); // actual MAIN missing lookup
      replies.push(await f.workspace.getOperation(id));
      f.pages.getBodyReceipt = async () => ({
        isErr: () => true,
        error: { code: "receipt_unreachable" },
      });
      replies.push(await f.workspace.getOperation(id));
      f.pages.getBodyReceipt = async () => ({
        isErr: () => true,
        error: { code: "invalid_result_envelope" },
      });
      replies.push(await f.workspace.getOperation(id));
      f.pages.getBodyReceipt = async () => {
        const reply = await real(record.binding, id);
        reply.value.executorId = crypto.randomUUID();
        return reply;
      };
      replies.push(await f.workspace.getOperation(id));
      f.pages.getBodyReceipt = real;
      const recovered = await f.workspace.getOperation(id);
      return {
        states: replies.map((reply: any) => reply.value.snapshot.state),
        issues: replies.map((reply: any) => reply.value.issue.failure.code),
        recovered: recovered.value.snapshot.state,
        counters,
        after: f.counters,
      };
    });
    expect(outcome.states).toEqual(Array(4).fill("unresolved"));
    expect(outcome.issues).toEqual([
      "receipt_missing",
      "receipt_unreachable",
      "invalid_result_envelope",
      "evidence_conflict",
    ]);
    expect(outcome.recovered).toBe("settled");
    expect(outcome.after).toEqual(outcome.counters);
    expect(outcome.after.set).toBe(1);
  } finally {
    await browser.close();
  }
});
