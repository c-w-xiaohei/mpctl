import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";

let temp: string;
let bundle: string;
test.beforeAll(async () => {
  temp = await mkdtemp("/tmp/opencode/mpctl-t6-retention-");
  execFileSync("bun", [
    "build",
    "src/operations.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${temp}/operations.js`,
  ]);
  bundle = await readFile(`${temp}/operations.js`, "utf8");
});
test.afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

test("G0 dual owner fences pre-issue old handle, retains running unknown and permits only new owner late evidence", async () => {
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
    await page.goto("https://retention.test/");
    const result = await page.evaluate(async () => {
      const url = "https://retention.test/operations.js";
      const { createOperations } = await import(url);
      const old = (await createOperations()).unwrap();
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((done) => {
        entered = done;
      });
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const input = {
        operationId: `op:${old.ledgerId}:${crypto.randomUUID()}`,
        article: "ref",
        html: "next",
        expectedHash: "a".repeat(64),
      };
      const binding = {
        tabId: 1,
        documentId: "doc",
        route: "saved",
        executorId: crypto.randomUUID(),
      };
      let native = 0;
      const confirmation = {
        effect: { outcome: "confirmed" as const, bodyHash: "b".repeat(64) },
        ended: true,
        result: { status: "ok" as const, value: {} },
      };
      const task = old.run(input, async (execution: any) => {
        entered();
        await gate;
        return execution.issue(binding, async () => {
          native++;
          return confirmation;
        });
      });
      await reached;
      const current = (await createOperations()).unwrap();
      release();
      await task;
      if (native !== 0) throw new Error(`old accepted owner dispatched after new owner: ${native}`);
      const repeated = await current.run(input, async () => {
        native++;
        return confirmation;
      });
      const stale = await old.run(
        { ...input, operationId: `op:${old.ledgerId}:${crypto.randomUUID()}` },
        async () => {
          native++;
          return confirmation;
        },
      );
      const pending = {
        ...input,
        operationId: `op:${(await current.keyLedger()).unwrap()}:${crypto.randomUUID()}`,
      };
      let lateEntered!: () => void;
      let lateRelease!: () => void;
      const lateReached = new Promise<void>((done) => {
        lateEntered = done;
      });
      const lateGate = new Promise<void>((done) => {
        lateRelease = done;
      });
      const active = current.run(pending, (execution: any) =>
        execution.issue(binding, async () => {
          native++;
          lateEntered();
          await lateGate;
          return confirmation;
        }),
      );
      await lateReached;
      const final = (await createOperations()).unwrap();
      const row = (await final.record(pending.operationId)).unwrap();
      const before = (await final.pending()).unwrap().length;
      lateRelease();
      const uncommitted = await active;
      const evidence = await final.observe(
        pending.operationId,
        row.requestDigest,
        binding,
        confirmation,
      );
      const duplicate = await final.run(pending, async () => {
        native++;
        return confirmation;
      });
      return {
        native,
        repeated: repeated.unwrap().snapshot.state,
        stale: stale.error?.failure.code,
        before,
        row: row.snapshot.state,
        uncommitted: uncommitted.unwrap().issue?.uncommitted,
        evidence: evidence.unwrap().snapshot.state,
        duplicate: duplicate.unwrap().snapshot.state,
      };
    });
    expect(result).toMatchObject({
      native: 1,
      repeated: "settled",
      stale: "execution_closed",
      before: 1,
      row: "unresolved",
      uncommitted: { effect: { outcome: "confirmed" } },
      evidence: "settled",
      duplicate: "settled",
    });
  } finally {
    await browser.close();
  }
});

test("G0 old schema is preserved/refused; actual storage recreation cannot admit the lost key", async () => {
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
    await page.goto("https://retention.test/");
    const result = await page.evaluate(async () => {
      const url = "https://retention.test/operations.js";
      const { createOperations } = await import(url);
      const real = IDBFactory.prototype.open;
      const connections: IDBDatabase[] = [];
      IDBFactory.prototype.open = function (...args) {
        const request = real.apply(this, args);
        request.addEventListener("success", () => connections.push(request.result));
        return request;
      };
      let native = 0;
      try {
        const operations = (await createOperations()).unwrap();
        const input = {
          operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
          article: "ref",
          html: "next",
          expectedHash: "a".repeat(64),
        };
        const confirmation = {
          effect: { outcome: "confirmed" as const, bodyHash: "b".repeat(64) },
          ended: true,
          result: { status: "ok" as const, value: {} },
        };
        await operations.run(input, (execution: any) =>
          execution.issue(
            { tabId: 1, documentId: "doc", route: "saved", executorId: crypto.randomUUID() },
            async () => {
              native++;
              return confirmation;
            },
          ),
        );
        const db = connections[0]!;
        await new Promise<void>((resolve) => {
          const tx = db.transaction("meta", "readwrite");
          tx.objectStore("meta").put({ schemaVersion: 1, ledgerId: operations.ledgerId }, "ledger");
          tx.oncomplete = () => resolve();
        });
        const rejected = await createOperations();
        const inventory = await new Promise<any>((resolve) => {
          const tx = db.transaction(["meta", "operations"]);
          const meta = tx.objectStore("meta").get("ledger");
          const count = tx.objectStore("operations").count();
          tx.oncomplete = () => resolve({ meta: meta.result, count: count.result });
        });
        const noNew = await operations.run(
          { ...input, operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}` },
          async () => {
            native++;
            return confirmation;
          },
        );
        for (const db of connections) db.close();
        await new Promise<void>((resolve, reject) => {
          const remove = indexedDB.deleteDatabase("mpctl.operations");
          remove.onsuccess = () => resolve();
          remove.onerror = () => reject(remove.error);
          remove.onblocked = () => reject(new Error("owned connection not released"));
        });
        const recreated = (await createOperations()).unwrap();
        const old = await recreated.run(input, async () => {
          native++;
          return confirmation;
        });
        return {
          native,
          failure: rejected.error?.failure.code,
          inventory,
          noNew: noNew.error?.failure.code,
          old: old.error?.failure.code,
          changed: recreated.ledgerId !== operations.ledgerId,
        };
      } finally {
        IDBFactory.prototype.open = real;
        for (const db of connections) db.close();
      }
    });
    expect(result).toMatchObject({
      native: 1,
      failure: "ledger_incompatible",
      inventory: { meta: { schemaVersion: 1 }, count: 1 },
      noNew: "ledger_incompatible",
      old: "ledger_mismatch",
      changed: true,
    });
  } finally {
    await browser.close();
  }
});
