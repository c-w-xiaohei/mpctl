import { afterEach, beforeEach, expect, test } from "bun:test";
import { Result } from "better-result";
import { workspaceResultCodec } from "@mpctl/contracts";
import { installIdbFixture } from "./idb-fixture";
import { navigationFixture } from "./browser/fixtures/navigation-workspace";
let restore: () => void;
beforeEach(() => {
  restore = installIdbFixture();
});
afterEach(() => restore());

test("open hands its owner a live article; duplicate and history never revive a handle", async () => {
  const f = await navigationFixture();
  f.addSaved("A");
  f.holdRead();
  try {
    const input = { operationId: f.id(), candidate: "A" };
    const owner = f.workspace.openArticle(input);
    await f.readReached();
    const waiter = f.workspace.openArticle(input);
    f.releaseRead();
    const first = await f.decode(await owner);
    const second = await f.decode(await waiter);
    expect(first.article).toMatch(/^ephemeral:/);
    expect(second.article).toBeUndefined();
    expect(second.snapshot).toEqual(first.snapshot);
    const before = { ...f.counters };
    f.expire();
    expect((await f.decode(await f.workspace.openArticle(input))).snapshot).toEqual(first.snapshot);
    expect(f.counters).toEqual(before);
  } finally {
    f.releaseRead();
    f.dispose();
  }
});

test("new creates once and returns a readable body without current", async () => {
  const f = await navigationFixture();
  f.endCapture();
  try {
    const input = { operationId: f.id() };
    const first = await f.decode(await f.workspace.newArticle(input));
    expect(first.snapshot).toMatchObject({
      result: { status: "ok" },
      effect: { pageCreated: true },
    });
    expect(
      (await workspaceResultCodec.deserialize(await f.workspace.readBody(first.article!))).unwrap()
        .html,
    ).toBe("dirty content retained");
    const before = { ...f.counters };
    expect((await f.decode(await f.workspace.newArticle(input))).article).toBeUndefined();
    expect(f.counters).toEqual(before);
  } finally {
    f.dispose();
  }
});

test("historical SAVE uncertainty cannot prevent creating an independent draft", async () => {
  const f = await navigationFixture();
  f.endCapture();
  try {
    const id = f.id();
    await f.operations.claim({
      operationId: id,
      operation: "save",
      requestDigest: "a".repeat(64),
      localRequestDigest: "b".repeat(64),
      effect: { outcome: "not_dispatched", persistence: "unverified" },
    });
    const old = (
      await f.operations.finish(
        id,
        { outcome: "unknown", persistence: "unverified" },
        { status: "error", error: { code: "save_unknown" } },
      )
    ).unwrap();
    expect(
      (await f.decode(await f.workspace.newArticle({ operationId: f.id() }))).snapshot,
    ).toMatchObject({ result: { status: "ok" } });
    expect((await f.operations.get(id)).unwrap()).toEqual(old);
  } finally {
    f.dispose();
  }
});

test("target loss after result commit preserves creation facts without returning a stale handle", async () => {
  const f = await navigationFixture();
  f.addSaved("A");
  const finish = f.operations.finish;
  f.operations.finish = async (...args) => {
    const result = await finish(...args);
    f.manager.isCurrent = async () => Result.ok(false);
    return result;
  };
  try {
    const input = { operationId: f.id(), candidate: "A" };
    const reply = await f.decode(await f.workspace.openArticle(input));
    expect(reply.article).toBeUndefined();
    expect(reply).toMatchObject({
      snapshot: { result: { status: "ok" } },
      issue: { failure: { code: "target_unavailable" } },
    });
    expect((await f.decode(await f.workspace.getOperation(input.operationId))).snapshot).toEqual(
      reply.snapshot,
    );
  } finally {
    f.dispose();
  }
});
