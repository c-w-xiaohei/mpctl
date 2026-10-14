import { expect, test } from "bun:test";
import { createOperationId } from "@mpctl/contracts";
import { createOperations } from "../src/operations";
import { installIdbFixture } from "./idb-fixture";

test("claims consume a key once; errors and restart never restore execution permission", async () => {
  const restore = installIdbFixture();
  try {
    const store = (await createOperations()).unwrap();
    const input = {
      operationId: createOperationId(store.ledgerId),
      operation: "body" as const,
      requestDigest: "a".repeat(64),
      localRequestDigest: "b".repeat(64),
      effect: { outcome: "not_dispatched" as const },
    };
    // Native transaction contention is tested in Chromium, not this Map fixture.
    const replies = [await store.claim(input), await store.claim(input)];
    expect(replies.map((reply) => reply.unwrap().acquired).sort()).toEqual([false, true]);
    expect((await store.claim({ ...input, requestDigest: "c".repeat(64) })).isErr()).toBe(true);
    const recorded = (
      await store.finish(
        input.operationId,
        { outcome: "unknown" },
        {
          status: "error",
          error: { code: "write_unknown" },
        },
      )
    ).unwrap();
    const restarted = (await createOperations()).unwrap();
    expect((await restarted.get(input.operationId)).unwrap()).toEqual(recorded);
    expect((await restarted.claim(input)).unwrap().acquired).toBe(false);
    expect(
      (await store.claim({ ...input, operationId: createOperationId(store.ledgerId) })).isErr(),
    ).toBe(true);
  } finally {
    restore();
  }
});

test("registration without a reply remains queryable and does not stop unrelated requests", async () => {
  const restore = installIdbFixture();
  try {
    const first = (await createOperations()).unwrap();
    const input = {
      operationId: createOperationId(first.ledgerId),
      operation: "save" as const,
      requestDigest: "a".repeat(64),
      localRequestDigest: "b".repeat(64),
      effect: { outcome: "not_dispatched" as const, persistence: "unverified" as const },
    };
    expect((await first.claim(input)).unwrap().acquired).toBe(true);
    const before = (await first.get(input.operationId)).unwrap();
    const next = (await createOperations()).unwrap();
    expect((await next.get(input.operationId)).unwrap()).toEqual(before);
    expect(
      (await next.claim({ ...input, operationId: createOperationId(next.ledgerId) })).unwrap()
        .acquired,
    ).toBe(true);
  } finally {
    restore();
  }
});

test("unknown remote saves are scoped to the original draft and account", async () => {
  const restore = installIdbFixture();
  try {
    const store = (await createOperations()).unwrap();
    const input = {
      operationId: createOperationId(store.ledgerId),
      operation: "save" as const,
      requestDigest: "a".repeat(64),
      localRequestDigest: "b".repeat(64),
      effect: { outcome: "not_dispatched" as const, persistence: "unverified" as const },
    };
    await store.claim(input);
    const target = {
      tabId: 1,
      documentId: "doc",
      route: "saved",
      executorId: crypto.randomUUID(),
      groupId: "a",
      contextDigest: "a".repeat(64),
    };
    expect((await store.bind(input.operationId, target)).isOk()).toBe(true);
    await store.finish(
      input.operationId,
      { outcome: "unknown", persistence: "unverified" },
      { status: "error", error: { code: "save_unknown" } },
    );
    expect(
      (await store.savedRequests({ ...target, tabId: 2, documentId: "new-doc" })).unwrap(),
    ).toHaveLength(1);
    expect(
      (await store.savedRequests({ ...target, documentId: "b-doc", groupId: "b" })).unwrap(),
    ).toHaveLength(0);
    expect(
      (
        await store.savedRequests({
          ...target,
          documentId: "other-doc",
          contextDigest: "c".repeat(64),
        })
      ).unwrap(),
    ).toHaveLength(0);
  } finally {
    restore();
  }
});
