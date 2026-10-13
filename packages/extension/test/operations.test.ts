import { expect, test } from "bun:test";
import { Result } from "better-result";
import { fixture } from "./browser/fixtures/body-workspace";
import { installIdbFixture } from "./idb-fixture";
import { createOperations } from "../src/operations";
import {
  fieldsRequestDigest,
  coverRequestDigest,
  bodyCoverRequestDigest,
  saveRequestDigest,
} from "../src/background-contracts";
import { bodyRequestDigest } from "../src/page-contracts";
import { initialFieldsEffect } from "../src/mp/article-fields";
import { assetRequestDigest, createOperationId } from "@mpctl/contracts";
import { spyOn } from "bun:test";

test("request identity keeps the original local and ledger digests for every operation", async () => {
  const restore = installIdbFixture();
  try {
    const operations = (await createOperations()).unwrap();
    const article = "ref";
    const expectedHash = "a".repeat(64);
    const fields = { author: "Author" };
    const save = {
      expectedBodyHash: expectedHash,
      expectedFieldsHash: "b".repeat(64),
      expectedCoverHash: "c".repeat(64),
    };
    const payload = {
      blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }),
      filename: "x.png",
      mimeType: "image/png" as const,
    };
    const bodyCover = {
      bodyImage: 1,
      expectedBodyHash: expectedHash,
      expectedCoverHash: save.expectedCoverHash,
    };
    const cases = [
      {
        operation: "body",
        input: { article, html: "body", expectedHash },
        local: await bodyRequestDigest("body", expectedHash),
        target: article,
        hash: expectedHash,
      },
      {
        operation: "fields",
        input: { article, fields, expectedHash },
        local: await fieldsRequestDigest(fields, expectedHash),
        target: article,
        hash: expectedHash,
      },
      {
        operation: "upload",
        input: { article, ...payload },
        local: await assetRequestDigest(payload),
        target: article,
        hash: "0".repeat(64),
      },
      {
        operation: "cover",
        input: { article, asset: "asset", expectedCoverHash: save.expectedCoverHash },
        local: await coverRequestDigest("asset", save.expectedCoverHash),
        target: article,
        hash: "0".repeat(64),
      },
      {
        operation: "cover",
        input: { article, ...bodyCover },
        local: await bodyCoverRequestDigest(bodyCover),
        target: article,
        hash: "0".repeat(64),
      },
      {
        operation: "save",
        input: { article, ...save },
        local: await saveRequestDigest(save),
        target: article,
        hash: "0".repeat(64),
      },
      {
        operation: "new",
        input: {},
        local: await bodyRequestDigest(JSON.stringify(["new", null, null]), "0".repeat(64)),
        target: null,
        hash: "0".repeat(64),
      },
      {
        operation: "open",
        input: { candidate: "g1" },
        local: await bodyRequestDigest(JSON.stringify(["open", "g1", null]), "0".repeat(64)),
        target: "g1",
        hash: "0".repeat(64),
      },
      {
        operation: "maintenance",
        input: { maintenance: "workspace-cleanup" as const },
        local: await bodyRequestDigest(
          JSON.stringify(["maintenance", null, "workspace-cleanup"]),
          "0".repeat(64),
        ),
        target: null,
        hash: "0".repeat(64),
      },
    ];
    for (const entry of cases) {
      const input = { ...entry.input, operationId: createOperationId(operations.ledgerId) };
      let calls = 0;
      const result = (
        await operations.run(input, async () => {
          calls++;
          return {
            effect:
              entry.operation === "fields"
                ? initialFieldsEffect(fields)
                : entry.operation === "upload"
                  ? { outcome: "not_dispatched", filename: payload.filename }
                  : entry.operation === "cover"
                    ? { cover: true, outcome: "not_dispatched" }
                    : entry.operation === "save"
                      ? { outcome: "not_dispatched", persistence: "unverified" }
                      : entry.operation === "maintenance"
                        ? { maintenance: true, outcome: "not_dispatched" }
                        : entry.operation === "body"
                          ? { outcome: "not_dispatched" }
                          : {
                              navigation: true,
                              outcome: "not_dispatched",
                              pageCreated: false,
                              auxiliaryCreated: [],
                              targetBound: false,
                            },
            ended: true,
            result: { status: "error", error: { code: "unsupported" } },
          };
        })
      ).unwrap();
      const row = (await operations.record(input.operationId)).unwrap();
      expect(row.snapshot).toMatchObject({
        operation: entry.operation,
        state: "settled",
        effect: { outcome: "not_dispatched" },
        result: { status: "error", error: { code: "unsupported" } },
      });
      expect(row.localRequestDigest).toBe(entry.local);
      expect(row.requestDigest).toBe(
        await bodyRequestDigest(
          JSON.stringify([entry.operation, entry.target, entry.local]),
          entry.hash,
        ),
      );
      expect(
        (
          await operations.run(input, async () => {
            throw new Error("must not replay");
          })
        ).unwrap(),
      ).toEqual(result);
      expect(calls).toBe(1);
    }
  } finally {
    restore();
  }
});

test("schema2 historical navigation source remains readable without new source writes", async () => {
  const restore = installIdbFixture();
  try {
    const name = `historical-source:${crypto.randomUUID()}`;
    const operations = (await createOperations(name)).unwrap();
    const input = { operationId: createOperationId(operations.ledgerId) };
    const first = (
      await operations.run(input, (e) =>
        e.issue({ bg: true, purpose: "new" }, async () => ({
          effect: {
            navigation: true,
            outcome: "unknown",
            pageCreated: true,
            auxiliaryCreated: [],
            targetBound: false,
          },
          ended: false,
          result: { status: "error", error: { code: "operation_unresolved" } },
        })),
      )
    ).unwrap();
    const row = (await operations.record(input.operationId)).unwrap();
    expect(row.createdAt).toBeUndefined();
    expect(row.updatedAt).toBeUndefined();
    expect(row.navigationBinding).toEqual({ bg: true, purpose: "new" });
    const source = {
      tabId: 9,
      documentId: "historical-source",
      route: "new",
      contextDigest: "a".repeat(64),
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opened = indexedDB.open(name);
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("operations", "readwrite");
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.objectStore("operations").put({
          ...row,
          createdAt: 123,
          updatedAt: 456,
          navigationBinding: { ...row.navigationBinding, source },
        });
      });
    } finally {
      db.close();
    }
    const restarted = (await createOperations(name)).unwrap();
    expect((await restarted.record(input.operationId)).unwrap().createdAt).toBe(123);
    expect((await restarted.record(input.operationId)).unwrap().updatedAt).toBe(456);
    expect((await restarted.record(input.operationId)).unwrap().navigationBinding?.source).toEqual(
      source,
    );
    expect((await restarted.get(input.operationId)).unwrap().snapshot).toEqual(first.snapshot);
    expect(
      (
        await restarted.run(input, async () => {
          throw new Error("historical unknown must not replay");
        })
      ).unwrap().snapshot,
    ).toEqual(first.snapshot);
    const dbInvalid = await new Promise<IDBDatabase>((resolve) => {
      const opened = indexedDB.open(name);
      opened.onsuccess = () => resolve(opened.result);
    });
    try {
      for (const createdAt of [-1, Number.POSITIVE_INFINITY]) {
        await new Promise<void>((resolve, reject) => {
          const tx = dbInvalid.transaction("operations", "readwrite");
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
          tx.objectStore("operations").put({ ...row, createdAt });
        });
        expect((await restarted.record(input.operationId)).isErr()).toBe(true);
      }
    } finally {
      dbInvalid.close();
    }
  } finally {
    restore();
  }
});

test("body cover classification and fresh BG completion survive restart without new work", async () => {
  const restore = installIdbFixture();
  try {
    const operations = (await createOperations()).unwrap();
    const input = {
      operationId: createOperationId(operations.ledgerId),
      article: "ref",
      bodyImage: 1,
      expectedBodyHash: "a".repeat(64),
      expectedCoverHash: "b".repeat(64),
    };
    let calls = 0;
    const target = {
      tabId: 1,
      documentId: "original",
      route: "saved",
      executorId: crypto.randomUUID(),
    };
    const action = (execution: import("../src/operations").Execution) =>
      execution.issue(target, async () => {
        calls++;
        return {
          effect: {
            cover: true as const,
            outcome: "confirmed" as const,
            coverHash: "c".repeat(64),
          },
          ended: true,
          result: { status: "ok" as const, value: {} },
        };
      });
    const submitted = await operations.run(input, action);
    expect(submitted.isOk()).toBe(true);
    const first = submitted.unwrap();
    expect(first.snapshot).toMatchObject({
      operation: "cover",
      state: "settled",
      effect: { cover: true, outcome: "confirmed" },
    });
    expect((await operations.record(input.operationId)).unwrap().bgEffects).toBe("complete");
    expect(await operations.run({ ...input, bodyImage: 2 }, action)).toMatchObject({
      error: { failure: { code: "operation_conflict" } },
    });
    for (const changed of [
      { expectedBodyHash: "d".repeat(64) },
      { expectedCoverHash: "e".repeat(64) },
    ])
      expect(await operations.run({ ...input, ...changed }, action)).toMatchObject({
        error: { failure: { code: "operation_conflict" } },
      });
    const restarted = (await createOperations()).unwrap();
    expect((await restarted.run(input, action)).unwrap().snapshot).toEqual(first.snapshot);
    expect(calls).toBe(1);
    const unknown = { ...input, operationId: createOperationId(restarted.ledgerId) };
    await restarted.run(unknown, (e) =>
      e.issue(target, async () => ({
        effect: { cover: true, outcome: "unknown" },
        ended: false,
        result: {
          status: "error",
          error: {
            code: "cover_update_unknown",
            cause: { at: "main.jsapi_callback", kind: "domain", code: "page_failed" },
          },
        },
      })),
    );
    const last = (await createOperations()).unwrap();
    expect((await last.get(unknown.operationId)).unwrap().snapshot).toMatchObject({
      operation: "cover",
      state: "unresolved",
      effect: { cover: true, outcome: "unknown" },
    });
    expect((await last.record(unknown.operationId)).unwrap().bgEffects).toBe("complete");
    expect(calls).toBe(1);
  } finally {
    restore();
  }
});

test("G0 dual-owner new claim is fenced before work/native, not just an old accepted handle", async () => {
  const restore = installIdbFixture();
  try {
    const old = (await createOperations()).unwrap();
    const current = (await createOperations()).unwrap();
    let work = 0;
    let native = 0;
    const input = {
      operationId: createOperationId(old.ledgerId),
      article: "ref",
      html: "next",
      expectedHash: "a".repeat(64),
    };
    const action = (execution: import("../src/operations").Execution) => {
      work++;
      return execution.issue(
        { tabId: 1, documentId: "original", route: "saved", executorId: crypto.randomUUID() },
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
    expect(await old.run(input, action)).toMatchObject({
      error: { failure: { code: "execution_closed" } },
    });
    expect({ work, native }).toEqual({ work: 0, native: 0 });
    expect((await current.run(input, action)).unwrap().snapshot.state).toBe("settled");
    expect((await current.run(input, action)).unwrap().snapshot.state).toBe("settled");
    expect({ work, native }).toEqual({ work: 1, native: 1 });
  } finally {
    restore();
  }
});

test("correction F3 actual ledger status merge preserves cleanup while replacing a placeholder and strengthens effect", async () => {
  const restore = installIdbFixture();
  try {
    const operations = (await createOperations()).unwrap();
    const input = {
      operationId: createOperationId(operations.ledgerId),
      article: "expired",
      asset: "expired",
      expectedCoverHash: "a".repeat(64),
    };
    const binding = {
      tabId: 1,
      documentId: "original",
      route: "saved",
      executorId: crypto.randomUUID(),
    };
    const cleanup = {
      at: "bg.pointer_cleanup" as const,
      kind: "runtime" as const,
      code: "pointer_cleanup_unknown",
    };
    await operations.run(input, (execution) =>
      execution.issue(binding, async () => ({
        effect: { cover: true, outcome: "unknown" },
        ended: false,
        result: { status: "error", error: { code: "operation_interrupted", cleanup } },
      })),
    );
    const record = (await operations.record(input.operationId)).unwrap();
    const evidence = {
      effect: { cover: true as const, outcome: "confirmed" as const, coverHash: "b".repeat(64) },
      ended: true,
      result: {
        status: "error" as const,
        error: {
          code: "target_unavailable" as const,
          cause: {
            at: "content.guard" as const,
            kind: "domain" as const,
            code: "target_unavailable",
          },
        },
      },
    };
    const observed = (
      await operations.observe(input.operationId, record.requestDigest, binding, evidence)
    ).unwrap();
    expect(observed.snapshot).toMatchObject({
      state: "settled",
      effect: evidence.effect,
      result: { status: "error", error: { ...evidence.result.error, cleanup } },
    });
    expect(
      (
        await operations.observe(input.operationId, record.requestDigest, binding, evidence)
      ).unwrap(),
    ).toEqual(observed);
    expect((await operations.record(input.operationId)).unwrap().bgEffects).toBe("complete");
  } finally {
    restore();
  }
});

test("B-C3/K3 cover identity does not depend on resolving an expired asset or article", async () => {
  const restore = installIdbFixture();
  try {
    const operations = (await createOperations()).unwrap();
    const input = {
      operationId: createOperationId(operations.ledgerId),
      article: "old-ref",
      asset: "old-asset",
      expectedCoverHash: "a".repeat(64),
    };
    let calls = 0;
    const first = (
      await operations.run(input, async (execution) =>
        execution.issue(
          { tabId: 1, documentId: "original", route: "route", executorId: crypto.randomUUID() },
          async () => {
            calls++;
            return {
              effect: { cover: true, outcome: "confirmed", coverHash: "b".repeat(64) },
              ended: true,
              result: { status: "ok", value: {} },
            };
          },
        ),
      )
    ).unwrap();
    const repeated = (
      await operations.run(input, async () => {
        throw new Error("expired handles must never be resolved");
      })
    ).unwrap();
    expect(repeated).toEqual(first);
    expect(calls).toBe(1);
    expect(
      (
        await operations.run({ ...input, asset: "other" }, async () => {
          throw new Error("must reject");
        })
      ).isErr(),
    ).toBe(true);
  } finally {
    restore();
  }
});

test("B-S2/R6 persisted pending BG navigation cannot be settled by a native receipt", async () => {
  const restore = installIdbFixture();
  try {
    const operations = (await createOperations()).unwrap();
    const input = {
      operationId: createOperationId(operations.ledgerId),
      article: "ref",
      expectedBodyHash: "a".repeat(64),
      expectedFieldsHash: "b".repeat(64),
      expectedCoverHash: "c".repeat(64),
    };
    const binding = {
      tabId: 1,
      documentId: "original",
      route: "route",
      executorId: crypto.randomUUID(),
      groupId: "draft",
    };
    const evidence = {
      effect: { outcome: "confirmed" as const, persistence: "unverified" as const },
      ended: false,
      result: { status: "error" as const, error: { code: "operation_unresolved" as const } },
    };
    const run = (
      await operations.run(input, (execution) =>
        execution.issue(binding, async () => {
          return evidence;
        }),
      )
    ).unwrap();
    expect(run.snapshot.state).toBe("unresolved");
    const original = (await operations.record(input.operationId)).unwrap();
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("mpctl.operations", 1);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("operations", "readwrite");
      tx.objectStore("operations").put({ ...original, bgEffects: "pending" });
      tx.oncomplete = () => resolve();
    });
    db.close();
    const restarted = (await createOperations()).unwrap();
    const record = (await restarted.record(input.operationId)).unwrap();
    expect(record.bgEffects).toBe("pending");
    const observed = (
      await restarted.observe(input.operationId, record.requestDigest, binding, {
        ...evidence,
        ended: true,
      })
    ).unwrap();
    expect(observed.snapshot.state).toBe("unresolved");
    expect(observed.snapshot.effect).toEqual(evidence.effect);
    expect(
      (
        await restarted.run(input, async () => {
          throw new Error("no resume");
        })
      ).unwrap().snapshot,
    ).toEqual(observed.snapshot);
  } finally {
    restore();
  }
});

test("active outer action cannot be ended by content confirmation", async () => {
  const restore = installIdbFixture();
  let release!: () => void;
  try {
    const operations = (await createOperations()).unwrap();
    const input = {
      operationId: createOperationId(operations.ledgerId),
      article: "ref",
      asset: "asset",
      expectedCoverHash: "a".repeat(64),
    };
    const binding = {
      tabId: 1,
      documentId: "original",
      route: "route",
      executorId: crypto.randomUUID(),
    };
    const confirmation = {
      effect: { cover: true as const, outcome: "confirmed" as const, coverHash: "b".repeat(64) },
      ended: true,
      result: { status: "ok" as const, value: {} },
    };
    let reached!: () => void;
    const entered = new Promise<void>((done) => {
      reached = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const first = operations.run(input, (execution) =>
      execution.issue(binding, async () => {
        reached();
        await gate;
        return confirmation;
      }),
    );
    await entered;
    const row = (await operations.record(input.operationId)).unwrap();
    const observed = (
      await operations.observe(input.operationId, row.requestDigest, binding, confirmation)
    ).unwrap();
    expect(observed.snapshot.state).toBe("issued");
    expect((await operations.pending()).unwrap()).toHaveLength(1);
    release();
    expect((await first).unwrap().snapshot.state).toBe("settled");
  } finally {
    release?.();
    restore();
  }
});

test("B-U2/K0/K1/TM0 stable upload identity uses actual bytes while digest is pending", async () => {
  const restore = installIdbFixture();
  const operations = (await createOperations()).unwrap();
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const payload = {
    blob: new Blob([bytes], { type: "image/png" }),
    filename: "image.png",
    mimeType: "image/png" as const,
  };
  const request = {
    ...payload,
    article: "original-ref",
    operationId: createOperationId(operations.ledgerId),
  };
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const original = crypto.subtle.digest.bind(crypto.subtle);
  const hashing = spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
    await gate;
    return original(...args);
  });
  let works = 0;
  let actions = 0;
  const work: Parameters<typeof operations.run>[1] = (execution) => {
    works++;
    return execution.issue(
      { tabId: 1, documentId: "doc", route: "route", executorId: crypto.randomUUID() },
      async () => {
        actions++;
        return {
          effect: { outcome: "unknown", filename: payload.filename },
          ended: false,
          result: { status: "error", error: { code: "asset_upload_unknown" } },
        };
      },
    );
  };
  try {
    const first = operations.run(request, work);
    const same = operations.run(
      { ...request, blob: new Blob([bytes], { type: "image/png" }) },
      work,
    );
    const changed = Uint8Array.from(bytes);
    changed[8] = 2;
    const other = operations.run(
      { ...request, blob: new Blob([changed], { type: "image/png" }) },
      work,
    );
    expect(works).toBe(0);
    release();
    const conflict = await other;
    expect(conflict.isErr() && conflict.error.failure.code).toBe("operation_conflict");
    const result = (await first).unwrap();
    expect((await same).unwrap()).toEqual(result);
    expect(result.snapshot.state).toBe("unresolved");
    expect({ works, actions }).toEqual({ works: 1, actions: 1 });
    const renamed = await operations.run({ ...request, filename: "renamed.png" }, work);
    expect(renamed.isErr() && renamed.error.failure.code).toBe("operation_conflict");
    const local = await assetRequestDigest(payload);
    const jpeg = {
      ...request,
      blob: new Blob([bytes], { type: "image/jpeg" }),
      filename: "image.jpg",
      mimeType: "image/jpeg" as const,
    };
    expect(local).not.toBe(
      await assetRequestDigest({
        blob: jpeg.blob,
        filename: jpeg.filename,
        mimeType: jpeg.mimeType,
      }),
    );
    const mimeConflict = await operations.run(jpeg, work);
    expect(mimeConflict.isErr() && mimeConflict.error.failure.code).toBe("operation_conflict");
    const restarted = (await createOperations()).unwrap();
    expect((await restarted.run(request, work)).unwrap().snapshot).toEqual(result.snapshot);
    expect({ works, actions }).toEqual({ works: 1, actions: 1 });
  } finally {
    release();
    hashing.mockRestore();
    restore();
  }
});

test("B-U3/R6 confirmation plus cleanup failure: active receipt cannot release owner", async () => {
  const restore = installIdbFixture();
  const operations = (await createOperations()).unwrap();
  const payload = {
    blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }),
    filename: "confirmed.png",
    mimeType: "image/png" as const,
  };
  const input = { ...payload, article: "ref", operationId: createOperationId(operations.ledgerId) };
  const binding = { tabId: 1, documentId: "doc", route: "route", executorId: crypto.randomUUID() };
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const effect = {
    outcome: "confirmed" as const,
    filename: payload.filename,
    thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/test/300",
  };
  const evidence = {
    effect,
    ended: true,
    result: {
      status: "error" as const,
      error: {
        code: "cleanup_failed" as const,
        cause: {
          at: "content.library_cleanup" as const,
          kind: "domain" as const,
          code: "cancel_unavailable",
        },
      },
    },
  };
  let actions = 0;
  try {
    const task = operations.run(input, (execution) =>
      execution.issue(binding, async () => {
        actions++;
        entered();
        await gate;
        return evidence;
      }),
    );
    await started;
    const record = (await operations.record(input.operationId)).unwrap();
    const observed = (
      await operations.observe(input.operationId, record.requestDigest, binding, evidence)
    ).unwrap();
    expect(observed.snapshot.state).toBe("issued");
    expect(observed.snapshot.effect).toEqual(effect);
    expect((await operations.pending()).unwrap()).toHaveLength(1);
    release();
    const result = (await task).unwrap();
    expect(result.snapshot.state).toBe("settled");
    expect(result.snapshot.effect).toEqual(effect);
    expect("result" in result.snapshot && result.snapshot.result).toEqual(evidence.result);
    expect(
      (
        await operations.run(input, async () => {
          actions++;
          return evidence;
        })
      ).unwrap().snapshot.state,
    ).toBe("settled");
    expect(actions).toBe(1);
    const committed = (
      await operations.observe(input.operationId, record.requestDigest, binding, evidence)
    ).unwrap();
    expect(committed.snapshot.state).toBe("settled");
    expect(committed.snapshot.effect).toEqual(effect);
    expect((await operations.pending()).unwrap()).toHaveLength(0);
  } finally {
    release();
    restore();
  }
});

test("B-U2/G1 BG rejects oversized/type-invalid upload before byte hashing or work", async () => {
  const restore = installIdbFixture();
  const operations = (await createOperations()).unwrap();
  let hashes = 0;
  let works = 0;
  const digest = spyOn(crypto.subtle, "digest").mockImplementation(async () => {
    hashes++;
    throw new Error("must not hash");
  });
  try {
    for (const blob of [
      new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: "image/png" }),
      new Blob([new Uint8Array(12)], { type: "image/jpeg" }),
    ]) {
      const result = await operations.run(
        {
          operationId: createOperationId(operations.ledgerId),
          article: "ref",
          blob,
          filename: "image.png",
          mimeType: "image/png",
        },
        async () => {
          works++;
          throw new Error("must not work");
        },
      );
      expect(result.isErr() && result.error.failure.code).toBe("invalid_asset");
    }
    expect({ hashes, works }).toEqual({ hashes: 0, works: 0 });
  } finally {
    digest.mockRestore();
    restore();
  }
});

test("G1 upload positional/no-key call is refused at the actual workspace before ledger/UI acquisition", async () => {
  const { createWorkspace } = await import("../src/workspace");
  let calls = 0;
  const workspace = createWorkspace({
    pages: {
      uploadMaterial() {
        calls++;
        throw new Error("no bypass");
      },
    } as never,
  });
  expect(await workspace.uploadAsset("old-ref" as never)).toEqual({
    status: "error",
    error: { failure: { code: "invalid_operation" } },
  });
  expect(calls).toBe(0);
});

test("F0/F1 upload shared UI remains pending after native work; distinct article BODY/fields/list/cover/SAVE cannot bypass", async () => {
  const restore = installIdbFixture();
  const f = await fixture();
  let uploads = 0;
  const executorId = crypto.randomUUID();
  Object.assign(f.pages, {
    materialIdentity: async () => Result.ok({ executorId }),
    uploadMaterial: async () => {
      uploads++;
      return Result.ok({
        operationId: uploadId,
        executorId,
        requestDigest: await assetRequestDigest(payload),
        effect: { outcome: "not_dispatched", filename: payload.filename },
        ended: false,
        result: { status: "error", error: { code: "library_open_unknown" } },
      });
    },
  });
  const payload = {
    blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }),
    filename: "native.png",
    mimeType: "image/png" as const,
  };
  const uploadId = createOperationId(f.operations.ledgerId);
  try {
    const upload = await f.workspace.uploadAsset({
      ...payload,
      article: f.first.article,
      operationId: uploadId,
    });
    expect(upload).toMatchObject({
      value: { snapshot: { state: "unresolved", effect: { outcome: "not_dispatched" } } },
    });
    const id = () => createOperationId(f.operations.ledgerId);
    const writes = [
      await f.workspace.writeBody({
        operationId: id(),
        article: f.second.article,
        html: "no",
        expectedHash: f.second.bodyHash,
      }),
      await f.workspace.updateArticleFields({
        operationId: id(),
        article: f.second.article,
        fields: { author: "no" },
        expectedHash: "a".repeat(64),
      }),
      await f.workspace.listAssets(f.second.article),
      await f.workspace.setArticleCover({
        operationId: id(),
        article: f.second.article,
        asset: "missing",
        expectedCoverHash: "c".repeat(64),
      }),
      await f.workspace.saveArticle({
        operationId: id(),
        article: f.second.article,
        expectedBodyHash: "a".repeat(64),
        expectedFieldsHash: "b".repeat(64),
        expectedCoverHash: "c".repeat(64),
      }),
    ];
    for (const result of writes)
      expect(result).toMatchObject(
        result.status === "error"
          ? { error: { code: "relationship_unknown", blockingOperationId: uploadId } }
          : {
              value: {
                snapshot: {
                  result: {
                    error: { code: "relationship_unknown", blockingOperationId: uploadId },
                  },
                },
              },
            },
      );
    expect((await f.workspace.inspectArticle(f.second.article)).status).toBe("ok");
    expect(uploads).toBe(1);
    expect(f.counters).toMatchObject({ set: 0, field: 0, cover: 0, save: 0, navigation: 0 });
  } finally {
    f.release();
    restore();
  }
});

test("R1/R3/F0 fields status recovers only the original typed receipt without BODY lookup or DOM reread", async () => {
  const restore = installIdbFixture();
  try {
    const f = await fixture();
    const executorId = crypto.randomUUID();
    let identities = 0,
      actions = 0,
      lookups = 0;
    const fields = { title: "changed", summary: "not attempted" };
    const digest = await fieldsRequestDigest(fields, "a".repeat(64));
    const input = {
      operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
      article: f.first.article,
      fields,
      expectedHash: "a".repeat(64),
    };
    const receipt = {
      operationId: input.operationId,
      executorId,
      requestDigest: digest,
      ended: true,
      effect: {
        ...initialFieldsEffect(fields),
        outcome: "partial" as const,
        attempted: ["title" as const],
        confirmed: ["title" as const],
      },
      result: {
        status: "error" as const,
        error: {
          code: "fields_unavailable" as const,
          cause: {
            at: "content.field_edit" as const,
            kind: "domain" as const,
            code: "fields_unavailable",
          },
        },
      },
    };
    const pages = f.pages as typeof f.pages & {
      fieldsIdentity: () => Promise<
        Result<{ executorId: string }, import("@mpctl/contracts").Failure>
      >;
      getFieldsReceipt: (
        _binding: unknown,
        id: string,
      ) => Promise<Result<typeof receipt | null, import("@mpctl/contracts").Failure>>;
    };
    pages.fieldsIdentity = async () => {
      identities++;
      return Result.ok({ executorId });
    };
    pages.updateArticleFields = async () => {
      actions++;
      return Result.err({ code: "receipt_unreachable" });
    };
    pages.getBodyReceipt = async () => {
      throw new Error("wrong operation receipt route");
    };
    let mode: "missing" | "misbound" | "valid" = "missing";
    pages.getFieldsReceipt = async (_binding, id) => {
      lookups++;
      expect(id).toBe(input.operationId);
      return Result.ok(
        mode === "missing"
          ? null
          : mode === "misbound"
            ? { ...receipt, executorId: crypto.randomUUID() }
            : receipt,
      );
    };
    const first = await f.workspace.updateArticleFields(input);
    expect(first).toMatchObject({
      status: "ok",
      value: {
        snapshot: {
          operation: "fields",
          state: "unresolved",
          effect: { outcome: "unknown", attempted: [], confirmed: [], unknown: [] },
        },
      },
    });
    const blocked = await f.workspace.writeBody({
      operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
      article: f.first.article,
      html: "forbidden",
      expectedHash: f.first.bodyHash,
    });
    expect(blocked).toMatchObject({
      status: "ok",
      value: {
        snapshot: {
          result: {
            status: "error",
            error: { code: "operation_blocked", blockingOperationId: input.operationId },
          },
        },
      },
    });
    const counters = { ...f.counters };
    expect(await f.workspace.getOperation(input.operationId)).toMatchObject({
      status: "ok",
      value: { issue: { failure: { code: "receipt_missing" } } },
    });
    mode = "misbound";
    expect(await f.workspace.getOperation(input.operationId)).toMatchObject({
      status: "ok",
      value: { issue: { failure: { code: "evidence_conflict" } } },
    });
    mode = "valid";
    const recovered = await f.workspace.getOperation(input.operationId);
    expect(recovered).toMatchObject({
      status: "ok",
      value: { snapshot: { state: "settled", effect: receipt.effect, result: receipt.result } },
    });
    expect(await f.workspace.updateArticleFields(input)).toEqual(recovered);
    expect(await f.workspace.getOperation(input.operationId)).toEqual(recovered);
    expect({ identities, actions, lookups }).toEqual({ identities: 1, actions: 1, lookups: 3 });
    expect(f.counters).toEqual(counters);
    expect((await f.operations.pending()).unwrap()).toEqual([]);
  } finally {
    restore();
  }
});
test("F0/F1/TM1 fields owner holds admission and same-document queue through commit; mismatch cannot release it", async () => {
  const restore = installIdbFixture();
  let release!: () => void;
  try {
    const f = await fixture();
    const executorId = crypto.randomUUID();
    let reached!: () => void;
    const entered = new Promise<void>((done) => {
      reached = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let calls = 0;
    const pages = f.pages as typeof f.pages & {
      fieldsIdentity(): Promise<Result<{ executorId: string }, import("@mpctl/contracts").Failure>>;
    };
    pages.fieldsIdentity = async () => Result.ok({ executorId });
    pages.updateArticleFields = async (
      _binding: unknown,
      fields: { title?: string },
      expectedHash: string,
      execution: { operationId: string; executorId: string },
    ) => {
      calls++;
      reached();
      await gate;
      return Result.ok({
        ...execution,
        requestDigest: await fieldsRequestDigest(fields, expectedHash),
        effect: {
          ...initialFieldsEffect(fields),
          outcome: "confirmed" as const,
          fieldsHash: "b".repeat(64),
        },
        ended: true,
        result: { status: "ok" as const, value: {} },
      });
    };
    const id = () => `op:${f.operations.ledgerId}:${crypto.randomUUID()}`;
    const input = {
      operationId: id(),
      article: f.first.article,
      fields: { title: "same" },
      expectedHash: "a".repeat(64),
    };
    const first = f.workspace.updateArticleFields(input);
    await entered;
    const same = f.workspace.updateArticleFields(input);
    const next = f.workspace.writeBody({
      operationId: id(),
      article: f.first.article,
      html: "after fields",
      expectedHash: f.first.bodyHash,
    });
    expect(
      await f.workspace.updateArticleFields({ ...input, fields: { title: "different" } }),
    ).toMatchObject({ status: "error", error: { failure: { code: "operation_conflict" } } });
    const independent = await f.workspace.writeBody({
      operationId: id(),
      article: f.second.article,
      html: "independent",
      expectedHash: f.second.bodyHash,
    });
    expect(independent).toMatchObject({
      status: "ok",
      value: { snapshot: { state: "settled", result: { status: "ok" } } },
    });
    expect(calls).toBe(1);
    expect(f.counters.set).toBe(1);
    release();
    expect(await same).toEqual(await first);
    await f.entered;
    f.release();
    expect(await next).toMatchObject({
      status: "ok",
      value: { snapshot: { state: "settled", result: { status: "ok" } } },
    });
    expect(f.counters.set).toBe(2);
    expect(calls).toBe(1);
  } finally {
    release?.();
    restore();
  }
});

test("G1 unavailable native IndexedDB initialization returns an explicit failure", async () => {
  // Bun has no native browser IDB. This tests only fail-closed admission, not transactions.
  expect(globalThis.indexedDB).toBeUndefined();
  const initialized = await createOperations();
  expect(initialized.isErr()).toBe(true);
  expect(initialized.isErr() && initialized.error.failure.code).toBe("storage_failed");
});

// Orchestration/merge regressions only. Native IDB and worker lifecycle evidence
// lives in browser/operations.spec.ts and browser/idempotency.spec.ts.
test("F1 mismatched submission cannot release original accepted BODY shared-UI admission", async () => {
  const restore = installIdbFixture();
  try {
    const f = await fixture();
    const open = f.pages.open;
    let entered!: () => void;
    let release!: () => void;
    const atOpen = new Promise<void>((done) => {
      entered = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let held = true;
    f.pages.open = async (binding) => {
      if (held) {
        held = false;
        entered();
        await gate;
      }
      return open(binding);
    };
    (f.pages as any).listMaterials = async () => {
      f.counters.navigation++;
      return Result.err({ code: "asset_list_failed" });
    };
    const input = {
      operationId: `op:${f.operations.ledgerId}:${crypto.randomUUID()}`,
      article: f.first.article,
      html: "next",
      expectedHash: f.first.bodyHash,
    };
    const original = f.workspace.writeBody(input);
    await atOpen;
    const duplicate = f.workspace.writeBody(input);
    const record = (await f.operations.record(input.operationId)).unwrap();
    expect(record.snapshot.state).toBe("accepted");
    expect(record.binding).toBeUndefined();
    expect(await f.workspace.writeBody({ ...input, html: "different" })).toMatchObject({
      status: "error",
      error: { failure: { code: "operation_conflict" } },
    });
    const shared = await f.workspace.listAssets(f.second.article);
    release();
    await f.entered;
    f.release();
    expect(await duplicate).toEqual(await original);
    expect(shared).toMatchObject({
      status: "error",
      error: { code: "relationship_unknown", blockingOperationId: input.operationId },
    });
    expect(f.counters.navigation).toBe(0);
    expect(f.counters.set).toBe(1);
  } finally {
    restore();
  }
});

test("F5 original ended refusal settles transport-unknown; duplicate evidence is stable", async () => {
  const restore = installIdbFixture();
  try {
    const operations = (await createOperations()).unwrap();
    const input = {
      operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
      article: "ref",
      html: "next",
      expectedHash: "a".repeat(64),
    };
    const binding = { tabId: 1, documentId: "doc", route: "new", executorId: crypto.randomUUID() };
    const initial = (
      await operations.run(input, (execution) =>
        execution.issue(binding, async () => ({
          effect: { outcome: "unknown" },
          ended: false,
          result: { status: "error", error: { code: "receipt_unreachable" } },
        })),
      )
    ).unwrap();
    expect(initial.snapshot.state).toBe("unresolved");
    const record = (await operations.record(input.operationId)).unwrap();
    const refusal = {
      effect: { outcome: "not_dispatched" as const },
      ended: true,
      result: { status: "error" as const, error: { code: "content_conflict" as const } },
    };
    const observed = (
      await operations.observe(input.operationId, record.requestDigest, binding, refusal)
    ).unwrap();
    expect(observed.issue).toBeUndefined();
    expect(observed.snapshot).toMatchObject({
      state: "settled",
      effect: { outcome: "unknown" },
      result: refusal.result,
    });
    expect(
      (
        await operations.observe(input.operationId, record.requestDigest, binding, refusal)
      ).unwrap(),
    ).toEqual(observed);
    expect((await operations.pending()).unwrap()).toEqual([]);
    const contradictory = (
      await operations.observe(input.operationId, record.requestDigest, binding, {
        ...refusal,
        result: { status: "error", error: { code: "target_unavailable" } },
      })
    ).unwrap();
    expect(contradictory.issue?.failure.code).toBe("evidence_conflict");
    expect(contradictory.snapshot).toEqual(observed.snapshot);
    const confirmedInput = {
      ...input,
      operationId: `op:${operations.ledgerId}:${crypto.randomUUID()}`,
    };
    const confirmed = (
      await operations.run(confirmedInput, (execution) =>
        execution.issue(binding, async () => ({
          ended: true,
          effect: { outcome: "confirmed", bodyHash: "b".repeat(64) },
          result: { status: "ok", value: {} },
        })),
      )
    ).unwrap();
    const confirmedRecord = (await operations.record(confirmedInput.operationId)).unwrap();
    const impossible = (
      await operations.observe(
        confirmedInput.operationId,
        confirmedRecord.requestDigest,
        binding,
        refusal,
      )
    ).unwrap();
    expect(impossible.issue?.failure.code).toBe("evidence_conflict");
    expect(impossible.snapshot).toEqual(confirmed.snapshot);
  } finally {
    restore();
  }
});
