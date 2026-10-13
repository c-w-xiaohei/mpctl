import { describe, expect, test, spyOn } from "bun:test";
import { Result } from "better-result";
import { hashBody } from "../src/mp/body-hash";
import { createEditorService } from "../src/mp/jsapi";
import { Nexus } from "@nexus-js/core";
import { createPageEndpoint } from "../src/transport/page-bridge";
import { pageEditorToken } from "../src/page-contracts";
import {
  pageEditorContentResultCodec,
  pageEditorReadyResultCodec,
  pageEditorWriteResultCodec,
} from "../src/page-contracts";

async function hashForTest(html: string): Promise<string> {
  const result = await hashBody(html);
  expect(Result.isOk(result)).toBe(true);
  return Result.isOk(result) ? result.value : "";
}

async function decodeWrite(
  wire: Awaited<ReturnType<ReturnType<typeof createEditorService>["setContent"]>>,
) {
  return pageEditorWriteResultCodec.deserialize(wire);
}
async function write(
  service: ReturnType<typeof createEditorService>,
  html: string,
  expectedHash: string,
) {
  const ready = (await decodeReady(await service.ready())).unwrap();
  return service.setContent(html, expectedHash, {
    operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
    executorId: ready.executorId,
  });
}
async function legacyAssertion(
  wire: Awaited<ReturnType<ReturnType<typeof createEditorService>["setContent"]>>,
) {
  const receipt = await decodeWrite(wire);
  if (receipt.isErr()) return receipt;
  if (receipt.value.result?.status === "error")
    return Result.err({ code: receipt.value.result.error.code });
  expect(receipt.value.effect.outcome).toBe("confirmed");
  return Result.ok({
    bodyHash: receipt.value.effect.outcome === "confirmed" ? receipt.value.effect.bodyHash : "",
  });
}

async function decodeReady(
  wire: Awaited<ReturnType<ReturnType<typeof createEditorService>["ready"]>>,
) {
  return pageEditorReadyResultCodec.deserialize(wire);
}

async function decodeContent(
  wire: Awaited<ReturnType<ReturnType<typeof createEditorService>["getContent"]>>,
) {
  return pageEditorContentResultCodec.deserialize(wire);
}

describe("MAIN editor service", () => {
  test("cover outgoing codec refusal returns a controlled envelope instead of throwing", async () => {
    const { coverReceiptResultCodec, coverWriteResultCodec } =
      await import("../src/background-contracts");
    const service = createEditorService({ invoke: undefined });
    const receipt = spyOn(coverReceiptResultCodec, "serialize").mockResolvedValue(
      Result.err({ code: "invalid_result_envelope" }),
    );
    const write = spyOn(coverWriteResultCodec, "serialize").mockResolvedValue(
      Result.err({ code: "invalid_result_envelope" }),
    );
    try {
      expect(await service.getCoverReceipt("missing")).toEqual({
        status: "error",
        error: { code: "invalid_result_envelope" },
      });
      expect(
        await service.setCoverFromBody({
          operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
          executorId: crypto.randomUUID(),
          bodyImage: 1,
          expectedBodyHash: "a".repeat(64),
          expectedCoverHash: "b".repeat(64),
        }),
      ).toEqual({ status: "error", error: { code: "invalid_result_envelope" } });
    } finally {
      receipt.mockRestore();
      write.mockRestore();
    }
  });
  test("body cover reserves synchronously through digest failure without releasing BODY predecessor", async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const reached = new Promise<void>((done) => {
      entered = done;
    });
    let sets = 0;
    const service = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: "body" });
        else {
          sets++;
          entered();
          void held.then(() => request.sucCb({}));
        }
      },
    });
    const executorId = (await decodeReady(await service.ready())).unwrap().executorId;
    const predecessor = service.setContent("body", await hashForTest("body"), {
      operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
      executorId,
    });
    await reached;
    const input = {
      operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
      executorId,
      bodyImage: 1,
      expectedBodyHash: "a".repeat(64),
      expectedCoverHash: "b".repeat(64),
    };
    const digest = spyOn(crypto.subtle, "digest").mockRejectedValueOnce(
      new Error("cover digest failure"),
    );
    try {
      const first = service.setCoverFromBody(input);
      expect(await service.setCoverFromBody({ ...input, bodyImage: 2 })).toMatchObject({
        status: "error",
        error: { code: "operation_conflict" },
      });
      expect(await first).toMatchObject({ status: "error", error: { code: "hash_failed" } });
      const successor = service.setContent("body", await hashForTest("body"), {
        operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        executorId,
      });
      await new Promise((done) => setTimeout(done, 0));
      expect(sets).toBe(1);
      release();
      await Promise.all([predecessor, successor]);
      expect(sets).toBe(2);
    } finally {
      digest.mockRestore();
      release();
    }
  });
  test("body cover owns a pre-dispatch receipt even when Document is unavailable", async () => {
    let calls = 0;
    const service = createEditorService({
      invoke(request) {
        calls++;
        request.sucCb({ isReady: true, isNew: true });
      },
    });
    const executorId = (await decodeReady(await service.ready())).unwrap().executorId;
    const operationId = `op:${crypto.randomUUID()}:${crypto.randomUUID()}`;
    const before = calls;
    const receipt = await service.setCoverFromBody({
      operationId,
      executorId,
      bodyImage: 1,
      expectedBodyHash: "a".repeat(64),
      expectedCoverHash: "b".repeat(64),
    });
    expect(receipt).toMatchObject({
      status: "ok",
      value: {
        operationId,
        ended: true,
        effect: { cover: true, outcome: "not_dispatched" },
        result: { status: "error", error: { code: "unsupported" } },
      },
    });
    expect(calls).toBe(before);
    expect(
      await service.setContent("body", "a".repeat(64), { operationId, executorId }),
    ).toMatchObject({ status: "error", error: { code: "operation_conflict" } });
    expect(
      await service.setCoverFromBody({
        operationId,
        executorId: crypto.randomUUID(),
        bodyImage: 1,
        expectedBodyHash: "a".repeat(64),
        expectedCoverHash: "b".repeat(64),
      }),
    ).toMatchObject({ status: "error", error: { code: "executor_mismatch" } });
    expect(calls).toBe(before);
    const decoded = (await import("../src/background-contracts")).coverWriteResultCodec;
    expect(await service.getCoverReceipt(operationId)).toMatchObject({
      status: "ok",
      value: (await decoded.deserialize(receipt)).unwrap(),
    });
  });
  test("F3 failed digest node cannot release a still-running native predecessor", async () => {
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((done) => {
      reached = done;
    });
    let sets = 0;
    const service = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: "before" });
        else {
          sets++;
          if (sets === 1) {
            release = () => request.sucCb({});
            reached();
          } else request.sucCb({});
        }
      },
    });
    const ready = (await decodeReady(await service.ready())).unwrap();
    const execution = () => ({
      operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
      executorId: ready.executorId,
    });
    const hash = await hashForTest("before");
    const first = service.setContent("a", hash, execution());
    await entered;
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digest = spyOn(crypto.subtle, "digest").mockRejectedValueOnce(
      new Error("B digest failed"),
    );
    try {
      expect(await decodeWrite(await service.setContent("b", hash, execution()))).toEqual(
        Result.err({ code: "hash_failed" }),
      );
      let hashed!: () => void;
      const atHash = new Promise<void>((done) => {
        hashed = done;
      });
      digest.mockImplementation(async (...args) => {
        const value = await nativeDigest(...args);
        hashed();
        return value;
      });
      const third = service.setContent("c", hash, execution());
      await atHash;
      // A host task boundary lets the complete C digest/preflight pipeline run if
      // the queue is broken; not a guessed microtask count or native sleep.
      await new Promise<void>((done) => setImmediate(done));
      const before = sets;
      release();
      await Promise.all([first, third]);
      expect(before).toBe(1);
      expect(sets).toBe(2);
    } finally {
      digest.mockRestore();
    }
  });

  test("F4 dynamic native invoke disappearance after preflight is a stopped zero-set refusal", async () => {
    let available = true;
    let sets = 0;
    const service = createEditorService({
      get invoke() {
        if (!available) return undefined;
        return (request: import("../src/mp/jsapi").EditorRequest) => {
          if (request.apiName === "mp_editor_get_isready")
            request.sucCb({ isReady: true, isNew: true });
          else if (request.apiName === "mp_editor_get_content") {
            request.sucCb({ content: "before" });
            available = false;
          } else {
            sets++;
            request.sucCb({});
          }
        };
      },
    });
    const ready = (await decodeReady(await service.ready())).unwrap();
    const execution = {
      operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
      executorId: ready.executorId,
    };
    const receipt = (
      await decodeWrite(await service.setContent("next", await hashForTest("before"), execution))
    ).unwrap();
    expect(receipt).toMatchObject({
      ended: true,
      effect: { outcome: "not_dispatched" },
      result: {
        status: "error",
        error: { code: "page_failed", cause: { code: "jsapi_unavailable" } },
      },
    });
    expect(sets).toBe(0);
  });
  test("R2 error callback cannot prove native end or release unknown history", async () => {
    let callback!: (value: unknown) => void;
    const counts = { read: 0, set: 0 };
    const service = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") {
          counts.read++;
          request.sucCb({ content: "before" });
        } else {
          counts.set++;
          callback = request.sucCb;
          request.errCb({});
        }
      },
    });
    const ready = (await decodeReady(await service.ready())).unwrap();
    const execution = {
      operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
      executorId: ready.executorId,
    };
    const hash = await hashForTest("before");
    const first = (await decodeWrite(await service.setContent("next", hash, execution))).unwrap();
    expect(first).toMatchObject({
      effect: { outcome: "unknown" },
      ended: false,
      result: { status: "error", error: { code: "write_unknown" } },
    });
    await service.setContent("next", hash, execution);
    callback({});
    expect(await service.getReceipt(execution.operationId)).toMatchObject({
      status: "ok",
      value: { ended: true, effect: { outcome: "unknown" } },
    });
    expect(counts).toEqual({ read: 1, set: 1 });
  });
  test.each(["before-set", "during-readback"] as const)(
    "V1 %s target invalidation never confirms another document",
    async (boundary) => {
      let valid = true;
      const counts = { read: 0, set: 0 };
      const service = createEditorService({
        validateTarget: () => valid,
        invoke(request) {
          if (request.apiName === "mp_editor_get_isready")
            request.sucCb({ isReady: true, isNew: true });
          else if (request.apiName === "mp_editor_get_content") {
            counts.read++;
            if (
              (boundary === "before-set" && counts.read === 1) ||
              (boundary === "during-readback" && counts.read === 2)
            )
              valid = false;
            request.sucCb({ content: counts.read === 1 ? "before" : "next" });
          } else {
            counts.set++;
            request.sucCb({});
          }
        },
      });
      const ready = (await decodeReady(await service.ready())).unwrap();
      const execution = {
        operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        executorId: ready.executorId,
      };
      const receipt = (
        await decodeWrite(await service.setContent("next", await hashForTest("before"), execution))
      ).unwrap();
      expect(receipt.effect.outcome).toBe(boundary === "before-set" ? "not_dispatched" : "unknown");
      expect(receipt.ended).toBe(true);
      expect(receipt.result).toMatchObject({
        status: "error",
        error: { code: "target_unavailable" },
      });
      const beforeQuery = { ...counts };
      await service.getReceipt(execution.operationId);
      await service.setContent("next", await hashForTest("before"), execution);
      expect(counts).toEqual(beforeQuery);
      expect(counts.set).toBe(boundary === "before-set" ? 0 : 1);
    },
  );
  test("P0 MAIN digest failure retains a refusal tombstone, not a fabricated receipt or dispatch", async () => {
    let nativeCount = 0;
    const service = createEditorService({
      invoke(request) {
        nativeCount++;
        request.sucCb({ isReady: true, isNew: true });
      },
    });
    const ready = (await decodeReady(await service.ready())).unwrap();
    const execution = {
      operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
      executorId: ready.executorId,
    };
    const digest = spyOn(crypto.subtle, "digest").mockRejectedValue(
      new Error("digest unavailable"),
    );
    try {
      expect(
        await decodeWrite(await service.setContent("next", "a".repeat(64), execution)),
      ).toEqual(Result.err({ code: "hash_failed" }));
      expect(await service.getReceipt(execution.operationId)).toEqual({
        status: "ok",
        value: null,
      });
      expect(
        await decodeWrite(await service.setContent("next", "a".repeat(64), execution)),
      ).toEqual(Result.err({ code: "hash_failed" }));
      expect(nativeCount).toBe(1); // only ready, zero content/set after digest failure
    } finally {
      digest.mockRestore();
    }
  });
  test("V2 real Nexus old lazy Remote cannot authorize a same-session replacement provider", async () => {
    const target = new EventTarget();
    const channelId = crypto.randomUUID();
    const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
    const providerEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
    const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
    const first = createEditorService({
      invoke(request) {
        request.sucCb({ isReady: true, isNew: true });
      },
    });
    const provider = new Nexus()
      .configure({ endpoint: { implementation: providerEndpoint, meta: {} } })
      .provide(pageEditorToken, first);
    const client = new Nexus().configure({
      endpoint: { implementation: clientEndpoint, meta: {} },
    });
    try {
      await Promise.all([provider.ready(), client.ready()]);
      const remote = (await client.connect({ target: {} })).safeGet(pageEditorToken).unwrap();
      const ready = (await decodeReady((await Nexus.safeCall(remote.ready())).unwrap())).unwrap();
      const lazy = remote.setContent("next", await hashForTest("before"), {
        operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        executorId: ready.executorId,
      });
      let nativeCount = 0;
      provider.provide(
        pageEditorToken,
        createEditorService({
          invoke() {
            nativeCount++;
          },
        }),
      );
      const result = await decodeWrite((await Nexus.safeCall(lazy)).unwrap());
      expect(result).toEqual(Result.err({ code: "executor_mismatch" }));
      expect(nativeCount).toBe(0);
    } finally {
      providerEndpoint.close();
      clientEndpoint.close();
    }
  });
  test("K0/V3 direct same-key duplicate associates the original native write", async () => {
    let writes = 0;
    const service = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: "before" });
        else {
          writes++;
          request.sucCb({});
        }
      },
    });
    const expectedHash = await hashForTest("before");
    const ready = await decodeReady(await service.ready());
    if (ready.isErr()) throw ready.error;
    const operation = {
      operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
      executorId: ready.value.executorId,
    };
    await service.setContent("next", expectedHash, operation);
    await service.setContent("next", expectedHash, operation);
    expect(writes).toBe(1);
  });
  test("V2 replacement provider rejects a previously bound execution with zero native reads/writes", async () => {
    const original = createEditorService({
      invoke(request) {
        request.sucCb({ isReady: true, isNew: true });
      },
    });
    const ready = (await decodeReady(await original.ready())).unwrap();
    let calls = 0;
    const replacement = createEditorService({
      invoke() {
        calls++;
      },
    });
    expect(
      await decodeWrite(
        await replacement.setContent("next", await hashForTest("before"), {
          operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
          executorId: ready.executorId,
        }),
      ),
    ).toEqual(Result.err({ code: "executor_mismatch" }));
    expect(calls).toBe(0);
  });
  test("G1 missing execution identity cannot reach the old MAIN mutation entry", async () => {
    let calls = 0;
    const service = createEditorService({
      invoke() {
        calls++;
      },
    });
    expect(
      await decodeWrite(
        await service.setContent("next", await hashForTest("before"), undefined as never),
      ),
    ).toEqual(Result.err({ code: "invalid_operation" }));
    expect(calls).toBe(0);
  });
  test.each(["callback-first", "timeout-first"] as const)(
    "R2 %s setter success preserves facts without resuming stopped readback",
    async (order) => {
      let callback!: (value: unknown) => void;
      let reached!: () => void;
      const entered = new Promise<void>((done) => {
        reached = done;
      });
      const deadlines: Array<() => void> = [];
      const timers = spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
        deadlines.push(handler);
        return 1;
      }) as typeof setTimeout);
      const counters = { ready: 0, read: 0, set: 0 };
      const service = createEditorService({
        timeoutMs: 5,
        invoke(request) {
          if (request.apiName === "mp_editor_get_isready") {
            counters.ready++;
            request.sucCb({ isReady: true, isNew: true });
          } else if (request.apiName === "mp_editor_get_content") {
            counters.read++;
            request.sucCb({ content: "before" });
          } else {
            counters.set++;
            callback = request.sucCb;
            reached();
          }
        },
      });
      const ready = (await decodeReady(await service.ready())).unwrap();
      const execution = {
        operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        executorId: ready.executorId,
      };
      try {
        const pending = service.setContent("next", await hashForTest("before"), execution);
        await entered;
        const deadline = deadlines.at(-1)!;
        if (order === "callback-first") {
          callback({});
          deadline();
        } else deadline();
        const first = (await decodeWrite(await pending)).unwrap();
        expect(first.effect.outcome).toBe(order === "callback-first" ? "confirmed" : "unknown");
        expect(first.ended).toBe(order === "callback-first");
        callback({});
        const receipt = await service.getReceipt(execution.operationId);
        expect(receipt.status === "ok" && receipt.value?.ended).toBe(true);
        expect(receipt.status === "ok" && receipt.value?.effect.outcome).toBe(
          order === "callback-first" ? "confirmed" : "unknown",
        );
        expect(counters).toEqual({ ready: 1, read: order === "callback-first" ? 2 : 1, set: 1 });
      } finally {
        timers.mockRestore();
      }
    },
  );
  test("K1 async request matching rejects changed bytes without another native action", async () => {
    let reads = 0;
    let sets = 0;
    let release!: () => void;
    let reached!: () => void;
    const reachedPromise = new Promise<void>((done) => {
      reached = done;
    });
    const service = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") {
          reads++;
          if (reads === 1) {
            release = () => request.sucCb({ content: "before" });
            reached();
          } else request.sucCb({ content: "next" });
        } else {
          sets++;
          request.sucCb({});
        }
      },
    });
    const ready = (await decodeReady(await service.ready())).unwrap();
    const execution = {
      operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
      executorId: ready.executorId,
    };
    const hash = await hashForTest("before");
    const first = service.setContent("next", hash, execution);
    await reachedPromise;
    expect(await decodeWrite(await service.setContent("different", hash, execution))).toEqual(
      Result.err({ code: "operation_conflict" }),
    );
    release();
    await first;
    expect({ reads, sets }).toEqual({ reads: 2, sets: 1 });
  });
  test("checks readiness and editor version before reading, preserving empty HTML", async () => {
    const calls: string[] = [];
    const service = createEditorService({
      timeoutMs: 100,
      invoke(request) {
        calls.push(request.apiName);
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        if (request.apiName === "mp_editor_get_content") request.sucCb({ content: "" });
      },
    });
    expect((await decodeReady(await service.ready())).unwrap()).toMatchObject({
      isReady: true,
      isNew: true,
    });
    expect(await decodeContent(await service.getContent())).toEqual(Result.ok(""));
    expect(calls).toEqual(["mp_editor_get_isready", "mp_editor_get_content"]);
  });

  test("returns a serialized domain Err for an invalid target instead of rejecting RPC", async () => {
    const service = createEditorService({
      validateTarget: () => false,
      invoke() {
        throw new Error("JSAPI must not be called for an invalid target");
      },
    });

    const wire = await service.ready();
    expect(wire).toEqual({ status: "error", error: { code: "target_unavailable" } });
    expect(await decodeReady(wire)).toEqual(Result.err({ code: "target_unavailable" }));
  });

  test("maps external readiness and content getter traps to typed Err values", async () => {
    const readiness = createEditorService({
      invoke(request) {
        request.sucCb(
          new Proxy(
            {},
            {
              get(_target, key) {
                if (key === "isReady") throw new Error("proxy trap");
                return undefined;
              },
            },
          ),
        );
      },
    });
    expect(await decodeReady(await readiness.ready())).toEqual(Result.err({ code: "page_failed" }));

    const content = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else
          request.sucCb({
            get content() {
              throw new Error("content getter trap");
            },
          });
      },
    });
    expect(await decodeContent(await content.getContent())).toEqual(
      Result.err({ code: "page_failed" }),
    );
  });

  test("preflight content getter trap is page_failed and does not dispatch a write", async () => {
    let writes = 0;
    const service = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content")
          request.sucCb({
            get content() {
              throw new Error("preflight getter trap");
            },
          });
        else writes++;
      },
    });

    expect(
      await legacyAssertion(await write(service, "next", await hashForTest("before"))),
    ).toEqual(Result.err({ code: "page_failed" }));
    expect(writes).toBe(0);
  });

  test("post-dispatch content getter trap is write_unknown and releases the serialized writer queue", async () => {
    let contentReads = 0;
    let writes = 0;
    const service = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready") {
          request.sucCb({ isReady: true, isNew: true });
        } else if (request.apiName === "mp_editor_get_content") {
          contentReads++;
          if (contentReads === 2) {
            request.sucCb({
              get content() {
                throw new Error("post-write getter trap");
              },
            });
          } else {
            request.sucCb({ content: "before" });
          }
        } else {
          writes++;
          request.sucCb({ msg: "ok" });
        }
      },
    });
    const expectedHash = await hashForTest("before");

    expect(await legacyAssertion(await write(service, "first", expectedHash))).toEqual(
      Result.err({ code: "page_failed" }),
    );
    expect(await legacyAssertion(await write(service, "second", expectedHash))).toEqual(
      Result.ok({ bodyHash: expectedHash }),
    );
    expect({ contentReads, writes }).toEqual({ contentReads: 4, writes: 2 });
  });

  test("keeps a stale snapshot from dispatching a write", async () => {
    let writes = 0;
    const service = createEditorService({
      timeoutMs: 100,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: "changed" });
        else writes++;
      },
    });
    expect(
      await legacyAssertion(await write(service, "replacement", await hashForTest("before"))),
    ).toEqual(Result.err({ code: "content_conflict" }));
    expect(writes).toBe(0);
  });

  test("serializes two writes based on the same snapshot so only one succeeds", async () => {
    let body = "original";
    let writeCount = 0;
    const service = createEditorService({
      timeoutMs: 100,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: body });
        else {
          writeCount++;
          body = `<p>${"content" in request.apiParam ? request.apiParam.content : ""}</p>`;
          request.sucCb({ msg: "ok" });
        }
      },
    });
    const snapshotHash = await hashForTest(body);
    const results = await Promise.all([
      write(service, "first", snapshotHash),
      write(service, "second", snapshotHash),
    ]);
    const decoded = await Promise.all(results.map(legacyAssertion));
    expect(decoded.filter(Result.isOk)).toHaveLength(1);
    expect(decoded.filter(Result.isError)).toEqual([Result.err({ code: "content_conflict" })]);
    expect(writeCount).toBe(1);
    expect(decoded.find(Result.isOk)).toEqual(Result.ok({ bodyHash: await hashForTest(body) }));
  });

  test("returns hash of normalized content read back after the write", async () => {
    let body = "before";
    const normalized = "<p>normalized by editor</p>";
    const service = createEditorService({
      timeoutMs: 100,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: body });
        else {
          body = normalized;
          request.sucCb({ msg: "ok" });
        }
      },
    });
    expect(
      await legacyAssertion(await write(service, "input", await hashForTest("before"))),
    ).toEqual(Result.ok({ bodyHash: await hashForTest(normalized) }));
  });

  test("reports set timeout as unknown and never retries the write", async () => {
    let writes = 0;
    const service = createEditorService({
      timeoutMs: 5,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: "before" });
        else writes++;
      },
    });
    expect(
      await legacyAssertion(await write(service, "next", await hashForTest("before"))),
    ).toEqual(Result.err({ code: "write_unknown" }));
    expect(writes).toBe(1);
  });

  test("reports malformed preflight content as a page failure without writing", async () => {
    let writes = 0;
    const service = createEditorService({
      timeoutMs: 100,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: 4 });
        else writes++;
      },
    });
    expect(
      await legacyAssertion(await write(service, "next", await hashForTest("before"))),
    ).toEqual(Result.err({ code: "page_failed" }));
    expect(writes).toBe(0);
  });

  test("CSS-only changes are conflicts even when visible text is unchanged", async () => {
    const before = '<p style="color:red">same text</p>';
    let writes = 0;
    const service = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content")
          request.sucCb({ content: before.replace("red", "blue") });
        else writes++;
      },
    });
    expect(
      await legacyAssertion(await write(service, "replacement", await hashForTest(before))),
    ).toEqual(Result.err({ code: "content_conflict" }));
    expect(writes).toBe(0);
  });

  test("rechecks the target at mutation dispatch after reading and hashing", async () => {
    let current = true;
    let writes = 0;
    const service = createEditorService({
      validateTarget: () => current,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") {
          request.sucCb({ content: "before" });
          current = false;
        } else writes++;
      },
    });
    expect(
      await legacyAssertion(await write(service, "replacement", await hashForTest("before"))),
    ).toEqual(Result.err({ code: "target_unavailable" }));
    expect(writes).toBe(0);
  });

  test("a second queued writer rechecks its target before any JSAPI read", async () => {
    let current = true;
    let completeWrite: (() => void) | undefined;
    let reads = 0;
    let writes = 0;
    let body = "before";
    const service = createEditorService({
      validateTarget: () => current,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") {
          reads++;
          request.sucCb({ content: body });
        } else {
          writes++;
          completeWrite = () => {
            body = "first";
            request.sucCb({ msg: "ok" });
          };
        }
      },
    });
    const hash = await hashForTest(body);
    const first = write(service, "first", hash);
    const second = write(service, "second", hash);
    while (!completeWrite) await new Promise((resolve) => setTimeout(resolve, 0));
    current = false;
    completeWrite();
    expect(await legacyAssertion(await first)).toEqual(Result.err({ code: "page_failed" }));
    expect(await legacyAssertion(await second)).toEqual(Result.err({ code: "target_unavailable" }));
    expect([reads, writes]).toEqual([1, 1]);
  });

  test("preserves read errors, malformed results, ready identity checks, and unsupported versions", async () => {
    const errorService = createEditorService({
      timeoutMs: 10,
      invoke(request) {
        request.errCb({ reason: "rejected" });
      },
    });
    expect(await decodeContent(await errorService.getContent())).toEqual(
      Result.err({ code: "page_failed" }),
    );

    const malformed = createEditorService({
      timeoutMs: 10,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else request.sucCb({ content: 3 });
      },
    });
    expect(await decodeContent(await malformed.getContent())).toEqual(
      Result.err({ code: "page_failed" }),
    );

    const legacy = createEditorService({
      timeoutMs: 10,
      invoke(request) {
        request.sucCb({ isReady: true, isNew: false });
      },
    });
    expect(await decodeReady(await legacy.ready())).toEqual(
      Result.err({ code: "unsupported_editor" }),
    );

    const ambiguous = createEditorService({
      timeoutMs: 10,
      invoke(request) {
        request.sucCb({ isReady: true });
      },
    });
    expect(await decodeReady(await ambiguous.ready())).toEqual(
      Result.err({ code: "identity_unavailable" }),
    );
  });
});
