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
  await rm(temp, { recursive: true, force: true });
});

for (const mode of ["normal", "expired-list", "lost", "no-document", "wrong-url"] as const) {
  test(`relogin ${mode} preserves exact-once navigation and a usable successful reference`, async () => {
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
          await f.workspace.openArticle({ operationId: f.id(), candidate: "A" });
          f.expireSaved("A", mode === "expired-list" ? "normal" : mode, mode === "expired-list");
          const beforeCurrent = { ...f.counters, update: f.updates };
          const current = await f.workspace.currentArticle({ candidate: "A" });
          const afterCurrent = { ...f.counters, update: f.updates };
          const input = { operationId: f.id(), candidate: "A" };
          const first = await f.decode(await f.workspace.openArticle(input));
          const body = first.article ? await f.workspace.readBody(first.article) : undefined;
          const beforeReplay = { ...f.counters, update: f.updates };
          const replay = await f.decode(await f.workspace.openArticle(input));
          const status = await f.decode(await f.workspace.getOperation(input.operationId));
          return {
            first,
            body,
            replay,
            status,
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
      expect(result.afterCurrent).toEqual(result.beforeCurrent);
      expect(result.afterReplay).toEqual(result.beforeReplay);
      expect(result.replay.snapshot).toEqual(result.first.snapshot);
      expect(result.status.snapshot).toEqual(result.first.snapshot);
      expect(result.replay.article).toBeUndefined();
      expect(result.afterReplay).toMatchObject({
        create: 0,
        update: mode === "expired-list" ? 2 : 1,
        reload: 0,
        set: 0,
      });
      const success = mode === "normal" || mode === "expired-list";
      expect(result.first.snapshot).toMatchObject({
        state: "settled",
        effect: { pageCreated: false, outcome: success ? "confirmed" : "unknown" },
        result: { status: success ? "ok" : "error" },
      });
      if (success) expect(result.body.status).toBe("ok");
      else expect(result.first.article).toBeUndefined();
    } finally {
      await browser.close();
    }
  });
}

for (const boundary of ["claim-abort", "result-abort", "completed-dead-source"] as const) {
  test(`native IDB ${boundary} never repeats navigation`, async () => {
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
        f.endCapture();
        const method = boundary === "claim-abort" ? "add" : "put";
        const original = IDBObjectStore.prototype[method];
        let aborted = 0;
        if (boundary !== "completed-dead-source")
          IDBObjectStore.prototype[method] = function (...args) {
            const request = original.apply(this, args);
            if (this.name === "operations")
              request.addEventListener("success", () => {
                aborted++;
                this.transaction.abort();
              });
            return request;
          };
        try {
          const input = { operationId: f.id() };
          const first = await f.workspace.newArticle(input);
          IDBObjectStore.prototype[method] = original;
          const before = { ...f.counters };
          f.expire();
          // An aborted claim was never admitted; do not submit a new intent in this test.
          const replay =
            boundary === "claim-abort" ? undefined : await f.workspace.newArticle(input);
          const status = await f.workspace.getOperation(input.operationId);
          return { first, replay, status, before, after: f.counters, aborted };
        } finally {
          IDBObjectStore.prototype[method] = original;
          f.dispose();
        }
      }, boundary);
      expect(result.after).toEqual(result.before);
      if (boundary === "claim-abort") {
        expect(result.first).toMatchObject({
          status: "error",
          error: { failure: { code: "storage_failed" } },
        });
        expect(result.before).toEqual({
          create: 0,
          group: 0,
          capture: 0,
          reload: 0,
          read: 0,
          set: 0,
        });
        expect(result.aborted).toBe(1);
      } else {
        expect(result.before).toMatchObject({ create: 1, group: 1, capture: 1, set: 0 });
        expect(result.replay.value.snapshot).toEqual(result.status.value.snapshot);
        if (boundary === "result-abort") {
          expect(result.first.value.issue).toMatchObject({
            failure: { code: "storage_failed" },
            uncommitted: {
              effect: { pageCreated: true, targetBound: true },
              result: { status: "ok" },
            },
          });
          expect(result.aborted).toBe(1);
        } else expect(result.first.value.snapshot.result.status).toBe("ok");
      }
    } finally {
      await browser.close();
    }
  });
}
