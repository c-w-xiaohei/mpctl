import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { Result } from "better-result";
import { createReloadControl } from "../src/reload";
import { installIdbFixture } from "./idb-fixture";
import { navigationFixture } from "./browser/fixtures/navigation-workspace";
let restore: () => void;
beforeEach(() => {
  restore = installIdbFixture();
});
afterEach(() => {
  restore();
});

test("B-N1/K0/K3/TM3 new created once; historical dead source needs no handle or reads", async () => {
  const f = await navigationFixture();
  try {
    f.holdGroup();
    const input = { operationId: f.id() };
    const first = f.workspace.newArticle(input);
    await f.reached();
    const checkpoint = (await f.operations.get(input.operationId)).unwrap().snapshot;
    expect(checkpoint).toMatchObject({
      state: "issued",
      effect: { pageCreated: true, targetBound: false },
    });
    const duplicate = f.workspace.newArticle(input);
    const mismatch = await f.workspace.openArticle({ ...input, candidate: "A" });
    expect(mismatch).toMatchObject({
      status: "error",
      error: { failure: { code: "operation_conflict" } },
    });
    f.release();
    const reply = await f.decode(await first);
    expect(await f.decode(await duplicate)).toEqual(reply);
    expect(reply.snapshot).toMatchObject({
      operation: "new",
      state: "unresolved",
      effect: { pageCreated: true, targetBound: true },
    });
    expect(f.counters).toMatchObject({ create: 1, group: 1, capture: 1, read: 1, set: 0 });
    const current = await f.current();
    expect(current.article).toMatch(/^ephemeral:/);
    f.expire();
    const before = { ...f.counters };
    expect(await f.decode(await f.workspace.newArticle(input))).toEqual(reply);
    expect(await f.decode(await f.workspace.getOperation(input.operationId))).toEqual(reply);
    expect(f.counters).toEqual(before);
    expect("result" in reply.snapshot && reply.snapshot.result).toEqual({
      status: "error",
      error: {
        code: "operation_unresolved",
        cause: { at: "bg.navigation", kind: "domain", code: "native_capture_end_unverified" },
      },
    });
  } finally {
    f.dispose();
  }
});

test("B-N1 group uncertainty retains confirmed creation and blocks maintenance; pure status does not settle", async () => {
  const f = await navigationFixture();
  try {
    f.failGroup();
    const input = { operationId: f.id() };
    const reply = await f.decode(await f.workspace.newArticle(input));
    expect(reply.snapshot).toMatchObject({
      state: "unresolved",
      effect: { pageCreated: true, targetBound: false },
      result: {
        status: "error",
        error: { cause: { at: "bg.navigation", kind: "runtime", code: "tab_group_failed" } },
      },
    });
    expect(f.counters).toMatchObject({ create: 1, group: 1, capture: 1, read: 0 });
    const before = { ...f.counters };
    expect(await f.decode(await f.workspace.getOperation(input.operationId))).toEqual(reply);
    expect(await f.decode(await f.workspace.newArticle(input))).toEqual(reply);
    for (const action of [() => f.workspace.listArticles(), () => f.workspace.cleanupWorkspace()])
      expect(await action()).toMatchObject({
        status: "error",
        error: { blockingOperationId: input.operationId },
      });
    expect(f.counters).toEqual(before);
  } finally {
    f.dispose();
  }
});

test("B-N1 BODY read failure cannot end an unverified clicked source handler", async () => {
  const f = await navigationFixture();
  try {
    f.failRead();
    const input = { operationId: f.id() };
    const reply = await f.decode(await f.workspace.newArticle(input));
    expect(reply.snapshot).toMatchObject({
      state: "unresolved",
      effect: { pageCreated: true, targetBound: true },
      result: { status: "error", error: { code: "page_failed" } },
    });
    expect(f.counters).toMatchObject({ create: 1, group: 1, capture: 1, read: 1 });
    expect((await f.operations.pending()).unwrap()).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

test("B-N2 same saved article different keys preserve dirty content, no create/capture/reload on reuse", async () => {
  const f = await navigationFixture();
  try {
    f.addSaved("A");
    f.addSaved("B");
    const first = await f.decode(
      await f.workspace.openArticle({ operationId: f.id(), candidate: "A" }),
    );
    const second = await f.decode(
      await f.workspace.openArticle({ operationId: f.id(), candidate: "A" }),
    );
    expect(first.snapshot.effect).toMatchObject({
      pageCreated: false,
      targetBound: true,
      outcome: "confirmed",
    });
    expect(second.snapshot.effect).toEqual(first.snapshot.effect);
    const located = await f.current("A");
    expect(located.bodyHash).toBe(
      "navigation" in first.snapshot.effect ? first.snapshot.effect.bodyHash! : "invalid",
    );
    expect(f.counters).toMatchObject({ create: 0, group: 0, capture: 0, reload: 0, set: 0 });
    expect(await f.workspace.currentArticle()).toMatchObject({
      status: "error",
      error: { code: "target_ambiguous" },
    });
  } finally {
    f.dispose();
  }
});

test("G1 legacy missing-key new/open have zero Chrome or DOM actions", async () => {
  const f = await navigationFixture();
  try {
    expect(await f.workspace.newArticle(undefined as never)).toMatchObject({
      status: "error",
      error: { failure: { code: "invalid_operation" } },
    });
    expect(await f.workspace.openArticle("A" as never)).toMatchObject({
      status: "error",
      error: { failure: { code: "invalid_operation" } },
    });
    expect(f.counters).toEqual({ create: 0, group: 0, capture: 0, reload: 0, read: 0, set: 0 });
  } finally {
    f.dispose();
  }
});

test("B-N2 concurrent different-key saved opens create exactly one member; dead candidate historical replay never acquires again", async () => {
  const f = await navigationFixture();
  try {
    f.holdGroup();
    const input = { operationId: f.id(), candidate: "A" };
    const first = f.workspace.openArticle(input);
    await f.reached();
    expect(await f.workspace.openArticle({ ...input, candidate: "B" })).toMatchObject({
      status: "error",
      error: { failure: { code: "operation_conflict" } },
    });
    const later = await f.decode(
      await f.workspace.openArticle({ operationId: f.id(), candidate: "A" }),
    );
    expect(later.snapshot).toMatchObject({
      state: "settled",
      result: { status: "error", error: { blockingOperationId: input.operationId } },
    });
    f.release();
    const completed = await f.decode(await first);
    expect(completed.snapshot).toMatchObject({
      state: "unresolved",
      effect: { pageCreated: true, targetBound: true },
    });
    expect(f.counters).toMatchObject({ create: 1, group: 1, capture: 1, reload: 0 });
    f.expire();
    const before = { ...f.counters };
    expect(await f.decode(await f.workspace.openArticle(input))).toEqual(completed);
    expect(f.counters).toEqual(before);
  } finally {
    f.dispose();
  }
});

test("B-N3/F active navigation allows explicit pure current on existing independent draft but blocks unbound modifications", async () => {
  const f = await navigationFixture();
  try {
    f.addSaved("B");
    f.holdGroup();
    const input = { operationId: f.id(), candidate: "A" };
    const first = f.workspace.openArticle(input);
    await f.reached();
    const current = await f.current("B");
    expect(current.article).toMatch(/^ephemeral:/);
    expect(await f.workspace.listAssets(current.article)).toMatchObject({
      status: "error",
      error: { code: "relationship_unknown", blockingOperationId: input.operationId },
    });
    const blocked = await f.decode(
      await f.workspace.writeBody({
        operationId: f.id(),
        article: current.article,
        html: "do not dispatch",
        expectedHash: current.bodyHash,
      }),
    );
    expect(blocked.snapshot).toMatchObject({
      result: {
        status: "error",
        error: { code: "relationship_unknown", blockingOperationId: input.operationId },
      },
    });
    expect(f.counters.set).toBe(0);
    f.release();
    await first;
  } finally {
    f.dispose();
  }
});

test("F1/B-N2 target-bound navigation keeps proven independent saved BODY usable", async () => {
  const f = await navigationFixture();
  try {
    f.addSaved("A");
    f.addSaved("B");
    const current = await f.current("B");
    f.holdRead();
    const input = { operationId: f.id(), candidate: "A" };
    const first = f.workspace.openArticle(input);
    await f.readReached();
    const during = await f.decode(await f.workspace.getOperation(input.operationId));
    expect(during.snapshot).toMatchObject({
      state: "issued",
      effect: { targetBound: true, pageCreated: false },
    });
    const independent = await f.decode(
      await f.workspace.writeBody({
        operationId: f.id(),
        article: current.article,
        html: "dirty content retained",
        expectedHash: current.bodyHash,
      }),
    );
    expect(independent.snapshot).toMatchObject({ state: "settled", result: { status: "ok" } });
    expect(f.counters).toMatchObject({ create: 0, group: 0, capture: 0, reload: 0 });
    f.releaseRead();
    await first;
  } finally {
    f.dispose();
  }
});

test("TM0/B-N2 simultaneous different-key new admission has one actual create, never double issue", async () => {
  const f = await navigationFixture();
  try {
    const replies = await Promise.all([
      f.workspace.newArticle({ operationId: f.id() }),
      f.workspace.newArticle({ operationId: f.id() }),
    ]);
    const values = await Promise.all(replies.map(f.decode));
    expect(
      values.filter(
        (entry) =>
          entry.snapshot.state === "unresolved" &&
          "navigation" in entry.snapshot.effect &&
          entry.snapshot.effect.pageCreated,
      ),
    ).toHaveLength(1);
    expect(
      values.filter(
        (entry) => entry.snapshot.state === "settled" && entry.snapshot.result.status === "error",
      ),
    ).toHaveLength(1);
    expect(f.counters).toEqual({ create: 1, group: 1, capture: 1, reload: 0, read: 1, set: 0 });
  } finally {
    f.dispose();
  }
});

test("B-N1 root created is an auxiliary fact, not an editor claim; issue precedes root dispatch", async () => {
  const f = await navigationFixture();
  try {
    f.missingHome();
    const original = f.api.createTab;
    let atRoot: unknown;
    f.api.createTab = async (options) => {
      atRoot = (await f.operations.pending()).unwrap().map((entry) => entry.snapshot.state);
      return original(options);
    };
    const reply = await f.decode(await f.workspace.newArticle({ operationId: f.id() }));
    expect(atRoot).toEqual(["issued"]);
    expect(reply.snapshot).toMatchObject({
      state: "unresolved",
      effect: { auxiliaryCreated: ["home"], pageCreated: true, targetBound: true },
    });
    expect(f.counters).toMatchObject({ create: 2, capture: 1, read: 1, set: 0 });
  } finally {
    f.dispose();
  }
});

test("B-N3 reload acceptance and later scheduled dispatch check the same ledger; marker cleanup failure never reloads", async () => {
  const f = await navigationFixture();
  let scheduled!: () => Promise<void>;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => Promise<void>,
  ) => {
    scheduled = callback;
    return 1;
  }) as typeof setTimeout);
  let reloads = 0;
  const reports: unknown[] = [];
  const control = createReloadControl({
    storage: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {
        throw new Error("private marker failure");
      },
    } as never,
    connect: async () => Result.ok(undefined),
    reload: async () => {
      const accepted = await f.operations.maintenance(async () => {
        reloads++;
        return Result.ok(undefined);
      });
      return accepted.isOk() ? accepted.value : Result.err({ code: "reload_failed" as const });
    },
    report: (value) => {
      reports.push(value);
    },
    reportCleanup: () => {},
  });
  try {
    expect((await f.operations.maintenance(() => control.reload())).unwrap()).toEqual(
      Result.ok(undefined),
    );
    const pending = await f.operations.run({ operationId: f.id() }, (execution) =>
      execution.issue({ bg: true, purpose: "new" }, async () => ({
        effect: {
          navigation: true,
          outcome: "unknown",
          pageCreated: false,
          targetBound: false,
          auxiliaryCreated: [],
        },
        ended: false,
        result: { status: "error", error: { code: "operation_unresolved" } },
      })),
    );
    expect(pending.isOk()).toBe(true);
    await scheduled();
    expect(reloads).toBe(0);
    expect(reports).toEqual([Result.err({ code: "reload_failed", cleanupFailed: true })]);
    const accepted = await f.operations.maintenance(() => control.reload());
    expect(accepted.isErr()).toBe(true);
    expect(reloads).toBe(0);
  } finally {
    timer.mockRestore();
    f.dispose();
  }
});

test("B-N2 dirty new page with unended original capture refuses different key without another capture", async () => {
  const f = await navigationFixture();
  try {
    const first = await f.decode(await f.workspace.newArticle({ operationId: f.id() }));
    const counts = { ...f.counters };
    const next = await f.decode(await f.workspace.newArticle({ operationId: f.id() }));
    expect(next.snapshot).toMatchObject({
      state: "settled",
      effect: { pageCreated: false },
      result: { status: "error", error: { code: "relationship_unknown" } },
    });
    expect(f.counters).toEqual(counts);
    const current = await f.current();
    expect(current.bodyHash).toBe(
      "navigation" in first.snapshot.effect ? first.snapshot.effect.bodyHash! : "invalid",
    );
    expect(f.counters.set).toBe(0);
  } finally {
    f.dispose();
  }
});

test("F2/B-N2 matching saved ID in a different observed source context cannot be adopted", async () => {
  const f = await navigationFixture();
  try {
    f.addSaved("A");
    f.changeAccount("A");
    const reply = await f.decode(
      await f.workspace.openArticle({ operationId: f.id(), candidate: "A" }),
    );
    expect(reply.snapshot).toMatchObject({
      state: "settled",
      result: { status: "error", error: { code: "relationship_unknown" } },
    });
    expect(f.counters).toEqual({ create: 0, group: 0, capture: 0, reload: 0, read: 0, set: 0 });
  } finally {
    f.dispose();
  }
});

test("B-N1 native source capture without target confirmation remains pending, never creates or infers Chrome end", async () => {
  const f = await navigationFixture();
  try {
    f.api.executeMain = async () => {
      f.counters.capture++;
      return [{ result: { kind: "unavailable" } }];
    };
    const input = { operationId: f.id() };
    const reply = await f.decode(await f.workspace.newArticle(input));
    expect(reply.snapshot).toMatchObject({
      state: "unresolved",
      effect: { pageCreated: false, targetBound: false },
      result: {
        status: "error",
        error: { cause: { at: "bg.navigation", code: "native_target_missing" } },
      },
    });
    expect(f.counters).toEqual({ create: 0, group: 0, capture: 1, reload: 0, read: 0, set: 0 });
    expect(await f.workspace.cleanupWorkspace()).toMatchObject({
      status: "error",
      error: { blockingOperationId: input.operationId },
    });
    expect(await f.decode(await f.workspace.newArticle(input))).toEqual(reply);
    expect(f.counters.capture).toBe(1);
  } finally {
    f.dispose();
  }
});
