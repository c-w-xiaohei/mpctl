import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

let temp: string;
let bundle: string;
test.beforeAll(async () => {
  temp = await mkdtemp("/tmp/opencode/mpctl-records-");
  const output = path.join(temp, "records.js");
  execFileSync("bun", [
    "build",
    "src/operations.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${output}`,
  ]);
  bundle = await readFile(output, "utf8");
});
test.afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

test("native IDB serializes duplicate registration, preserves legacy facts, and fences old writers", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("records.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://records.test/");
    const result = await page.evaluate(async () => {
      const url = "https://records.test/records.js";
      const { createOperations } = await import(url);
      const store = (await createOperations()).unwrap();
      const id = () => `op:${store.ledgerId}:${crypto.randomUUID()}`;
      const input = {
        operationId: id(),
        operation: "body",
        requestDigest: "a".repeat(64),
        localRequestDigest: "b".repeat(64),
        effect: { outcome: "not_dispatched" },
      };
      const concurrent = await Promise.all(Array.from({ length: 12 }, () => store.claim(input)));
      const winners = concurrent.filter((value) => value.isOk() && value.value.acquired).length;
      const mismatch = await store.claim({ ...input, requestDigest: "c".repeat(64) });
      const snapshot = (
        await store.finish(
          input.operationId,
          { outcome: "unknown" },
          { status: "error", error: { code: "write_unknown" } },
        )
      ).unwrap().snapshot;
      const database = await new Promise<IDBDatabase>((resolve) => {
        const open = indexedDB.open("mpctl.operations", 1);
        open.onsuccess = () => resolve(open.result);
      });
      const legacyId = id();
      const legacy = {
        schemaVersion: 2,
        ledgerId: store.ledgerId,
        owner: crypto.randomUUID(),
        requestDigest: "d".repeat(64),
        localRequestDigest: "e".repeat(64),
        binding: {
          tabId: 7,
          documentId: "old-doc",
          route: "old-route",
          executorId: crypto.randomUUID(),
        },
        bgEffects: "pending",
        snapshot: {
          operationId: legacyId,
          operation: "save",
          state: "unresolved",
          effect: { outcome: "confirmed", persistence: "unverified" },
          result: {
            status: "error",
            error: {
              code: "page_failed",
              cause: { at: "bg.reload", kind: "domain", code: "navigation_failed" },
            },
          },
        },
      };
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction("operations", "readwrite");
        tx.objectStore("operations").add(legacy);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      const restart = (await createOperations()).unwrap();
      const oldWrite = await store.claim({ ...input, operationId: id() });
      const readLegacy = (await restart.record(legacyId)).unwrap();
      const duplicate = (await restart.claim(input)).unwrap();
      const before = (await restart.get(input.operationId)).unwrap().snapshot;
      const independent = (await restart.claim({ ...input, operationId: id() })).unwrap().acquired;
      const legacyDuplicate = (
        await restart.claim({
          ...input,
          operationId: legacyId,
          requestDigest: legacy.requestDigest,
        })
      ).unwrap().acquired;
      database.close();
      return {
        winners,
        mismatch: mismatch.isErr(),
        oldWrite: oldWrite.isErr(),
        readLegacy,
        legacy,
        duplicate: duplicate.acquired,
        snapshot,
        before,
        independent,
        legacyDuplicate,
      };
    });
    expect(result.winners).toBe(1);
    expect(result.mismatch).toBe(true);
    expect(result.oldWrite).toBe(true);
    expect(result.readLegacy).toEqual(result.legacy);
    expect(result.duplicate).toBe(false);
    expect(result.before).toEqual(result.snapshot);
    expect(result.independent).toBe(true);
    expect(result.legacyDuplicate).toBe(false);
  } finally {
    await browser.close();
  }
});

test("native transaction abort never returns execution permission", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("records.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://records.test/");
    const result = await page.evaluate(async () => {
      const url = "https://records.test/records.js";
      const { createOperations } = await import(url);
      const store = (await createOperations()).unwrap();
      const operationId = `op:${store.ledgerId}:${crypto.randomUUID()}`;
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) {
        const result = add.apply(this, args);
        if (this.name === "operations")
          result.addEventListener("success", () => this.transaction.abort());
        return result;
      };
      const claim = await store.claim({
        operationId,
        operation: "body",
        requestDigest: "a".repeat(64),
        localRequestDigest: "b".repeat(64),
        effect: { outcome: "not_dispatched" },
      });
      IDBObjectStore.prototype.add = add;
      const read = await store.get(operationId);
      return {
        refused: claim.isErr(),
        absent: read.isErr() && read.error.failure.code === "operation_not_found",
      };
    });
    expect(result).toEqual({ refused: true, absent: true });
  } finally {
    await browser.close();
  }
});
