import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
let temp: string;
let bundle: string;
test.beforeAll(async () => {
  temp = await mkdtemp("/tmp/opencode/mpctl-navigation-idb-");
  const output = path.join(temp, "navigation.js");
  execFileSync("bun", [
    "build",
    "test/browser/fixtures/navigation-workspace.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${output}`,
  ]);
  bundle = await readFile(output, "utf8");
});
test.afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});
for (const mode of ["normal", "expired-list", "lost", "no-document", "wrong-url"] as const) {
  test(`relogin original workspace and native IDB ${mode} keep once-only navigation facts`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("navigation.js")
          ? route.fulfill({ contentType: "text/javascript", body: bundle })
          : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
      );
      await page.goto("https://navigation.test/");
      const result = await page.evaluate(async (mode) => {
        const url = "https://navigation.test/navigation.js";
        const { navigationFixture } = await import(url);
        const f = await navigationFixture();
        try {
          f.addSaved("A");
          await f.decode(await f.workspace.openArticle({ operationId: f.id(), candidate: "A" }));
          const tabId = f.expireSaved(
            "A",
            mode === "expired-list" ? "normal" : mode,
            mode === "expired-list",
          );
          const beforeCurrent = { ...f.counters, update: f.updates };
          const current = await f.workspace.currentArticle({ candidate: "A" });
          const afterCurrent = { ...f.counters, update: f.updates };
          const input = { operationId: f.id(), candidate: "A" };
          const first = await f.decode(await f.workspace.openArticle(input));
          const record = (await f.operations.record(input.operationId)).unwrap();
          const beforeReplay = { ...f.counters, update: f.updates };
          const replay = await f.decode(await f.workspace.openArticle(input));
          const status = await f.decode(await f.workspace.getOperation(input.operationId));
          return {
            first,
            replay,
            status,
            record,
            tabId,
            current,
            beforeCurrent,
            afterCurrent,
            beforeReplay,
            afterReplay: { ...f.counters, update: f.updates },
          };
        } finally {
          f.dispose();
        }
      }, mode);
      expect(result.current).toMatchObject({ status: "error", error: { code: "not_logged_in" } });
      expect(result.beforeCurrent).toEqual(result.afterCurrent);
      expect(result.beforeReplay).toEqual(result.afterReplay);
      expect(result.first.snapshot).toEqual(result.replay.snapshot);
      expect(result.status.snapshot).toEqual(result.first.snapshot);
      expect(result.afterReplay).toMatchObject({
        create: 0,
        update: mode === "expired-list" ? 2 : 1,
        reload: 0,
        set: 0,
      });
      const success = mode === "normal" || mode === "expired-list";
      expect(result.first.snapshot).toMatchObject({
        state: success ? "settled" : "unresolved",
        effect: { pageCreated: false, outcome: success ? "confirmed" : "unknown" },
        result: { status: success ? "ok" : "error" },
      });
      if (success)
        expect(result.record.navigationBinding?.target).toMatchObject({
          tabId: result.tabId,
          documentId: `fresh:${result.tabId}:${mode === "expired-list" ? 2 : 1}`,
        });
      else expect(result.record.navigationBinding?.target).toBeUndefined();
    } finally {
      await browser.close();
    }
  });
}
for (const boundary of [
  "issue-abort",
  "creation-checkpoint-abort",
  "completed-dead-source",
  "pending-maintenance",
  "root-checkpoint-abort",
  "binding-abort",
] as const) {
  test(`B-N1/P2/H1/K3/B-N3 native IDB ${boundary}`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("navigation.js")
          ? route.fulfill({ contentType: "text/javascript", body: bundle })
          : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
      );
      await page.goto("https://navigation.test/");
      const result = await page.evaluate(async (boundary) => {
        const url = "https://navigation.test/navigation.js";
        const { navigationFixture } = await import(url);
        const f = await navigationFixture();
        if (boundary === "root-checkpoint-abort") f.missingHome();
        let aborted = 0;
        const original = IDBObjectStore.prototype.put;
        if (boundary.endsWith("abort"))
          IDBObjectStore.prototype.put = function (value, key) {
            const request = original.call(this, value, key);
            if (
              this.name === "operations" &&
              value.snapshot.state === "issued" &&
              (boundary === "binding-abort"
                ? !!value.navigationBinding?.target
                : boundary === "root-checkpoint-abort"
                  ? value.snapshot.effect.auxiliaryCreated.length > 0
                  : boundary === "issue-abort"
                    ? !value.snapshot.effect.pageCreated
                    : value.snapshot.effect.pageCreated)
            ) {
              const tx = this.transaction;
              request.addEventListener("success", () => {
                aborted++;
                tx.abort();
              });
            }
            return request;
          };
        try {
          const input = { operationId: f.id() };
          if (boundary === "pending-maintenance") f.holdGroup();
          const first = f.workspace.newArticle(input);
          let blocked: unknown[] = [];
          if (boundary === "pending-maintenance") {
            await f.reached();
            blocked = await Promise.all([
              f.workspace.listArticles(),
              f.workspace.cleanupWorkspace(),
              f.workspace.newArticle({ operationId: f.id() }),
            ]);
            const snapshot = await f.workspace.getOperation(input.operationId);
            blocked.push(snapshot);
            f.release();
          }
          const reply = await f.decode(await first);
          const before = { ...f.counters };
          if (boundary === "completed-dead-source") f.expire();
          const repeated = await f.decode(await f.workspace.newArticle(input));
          const query = await f.decode(await f.workspace.getOperation(input.operationId));
          const pending = (await f.operations.pending())
            .unwrap()
            .map((entry: any) => entry.snapshot.operationId);
          return { reply, repeated, query, counts: f.counters, before, aborted, blocked, pending };
        } finally {
          IDBObjectStore.prototype.put = original;
          f.dispose();
        }
      }, boundary);
      expect(result.counts).toEqual(result.before);
      expect(result.repeated.snapshot).toEqual(result.query.snapshot);
      if (boundary === "issue-abort") {
        expect(result.aborted).toBe(1);
        expect(result.counts).toEqual({
          create: 0,
          group: 0,
          capture: 0,
          reload: 0,
          read: 0,
          set: 0,
        });
        expect(result.reply.snapshot.effect.pageCreated).toBe(false);
      } else if (boundary === "root-checkpoint-abort") {
        expect(result.aborted).toBe(1);
        expect(result.counts).toEqual({
          create: 1,
          group: 0,
          capture: 0,
          reload: 0,
          read: 0,
          set: 0,
        });
        expect(result.reply.issue).toMatchObject({
          failure: { code: "storage_failed" },
          uncommitted: {
            effect: { auxiliaryCreated: ["home"], pageCreated: false, targetBound: false },
          },
        });
        expect(result.pending).toHaveLength(1);
      } else if (boundary === "binding-abort") {
        expect(result.aborted).toBe(1);
        expect(result.counts).toEqual({
          create: 1,
          group: 1,
          capture: 1,
          reload: 0,
          read: 0,
          set: 0,
        });
        expect(result.reply.snapshot).toMatchObject({
          state: "unresolved",
          effect: { pageCreated: true, targetBound: false },
        });
        expect(result.reply.issue).toMatchObject({
          failure: { code: "storage_failed" },
          uncommitted: { effect: { pageCreated: true, targetBound: true } },
        });
        expect(result.pending).toHaveLength(1);
      } else if (boundary === "creation-checkpoint-abort") {
        expect(result.aborted).toBe(1);
        expect(result.counts).toEqual({
          create: 1,
          group: 0,
          capture: 1,
          reload: 0,
          read: 0,
          set: 0,
        });
        expect(result.reply.snapshot).toMatchObject({
          state: "unresolved",
          effect: { pageCreated: false },
        });
        expect(result.reply.issue).toMatchObject({
          failure: { code: "storage_failed" },
          uncommitted: { effect: { pageCreated: true, targetBound: false } },
        });
        expect(result.pending).toHaveLength(1);
      } else {
        expect(result.counts).toEqual({
          create: 1,
          group: 1,
          capture: 1,
          reload: 0,
          read: 1,
          set: 0,
        });
        expect(result.reply.snapshot).toMatchObject({
          state: "unresolved",
          effect: { pageCreated: true, targetBound: true },
          result: { status: "error", error: { code: "operation_unresolved" } },
        });
        if (boundary === "pending-maintenance") {
          expect(result.blocked.slice(0, 2)).toMatchObject([
            { status: "error" },
            { status: "error" },
          ]);
          expect(result.blocked[2]).toMatchObject({
            status: "ok",
            value: { snapshot: { state: "settled", result: { status: "error" } } },
          });
          expect(result.blocked[3]).toMatchObject({
            status: "ok",
            value: { snapshot: { state: "issued" } },
          });
        }
      }
    } finally {
      await browser.close();
    }
  });
}
