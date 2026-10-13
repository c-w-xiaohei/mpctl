import { expect, test, spyOn } from "bun:test";
import { Result } from "better-result";
import { createReloadControl } from "../src/reload";

function fixture() {
  const values: Record<string, unknown> = {};
  let calls = 0;
  let reloads = 0;
  const order: string[] = [];
  const control = createReloadControl({
    storage: {
      async get() {
        return { ...values };
      },
      async set(items) {
        Object.assign(values, items);
        order.push("persist");
      },
      async remove(key) {
        delete values[key as string];
        order.push("consume");
      },
    } as Pick<typeof chrome.storage.local, "get" | "set" | "remove">,
    async connect() {
      calls++;
      order.push("connect");
      return Result.ok(undefined);
    },
    reload() {
      reloads++;
      order.push("reload");
      return Result.ok(undefined);
    },
  });
  return {
    values,
    control,
    order,
    get calls() {
      return calls;
    },
    get reloads() {
      return reloads;
    },
  };
}

test("F0 scheduled reload awaits asynchronous native admission and reports a later refusal without reload", async () => {
  let scheduled!: () => Promise<void>;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: () => Promise<void>,
  ) => {
    scheduled = handler;
    return 1;
  }) as typeof setTimeout);
  let release!: (result: Result<void, { code: "reload_failed" }>) => void;
  const gate = new Promise<Result<void, { code: "reload_failed" }>>((done) => {
    release = done;
  });
  let removed = 0;
  const reports: unknown[] = [];
  const control = createReloadControl({
    storage: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {
        removed++;
      },
    } as never,
    connect: async () => Result.ok(undefined),
    reload: async () => gate,
    report: (result) => reports.push(result),
  });
  try {
    expect(await control.reload()).toEqual(Result.ok(undefined));
    const native = scheduled();
    expect(reports).toEqual([]);
    expect(removed).toBe(0);
    release(Result.err({ code: "reload_failed" }));
    await native;
    expect(reports).toEqual([Result.err({ code: "reload_failed" })]);
    expect(removed).toBe(1);
  } finally {
    timer.mockRestore();
  }
});

test("reload persists intent before scheduling runtime reload and consumes it only once", async () => {
  const f = fixture();
  await f.control.reload();
  expect(f.order).toEqual(["persist"]);
  expect(f.reloads).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.order).toEqual(["persist", "reload"]);
  await f.control.resume();
  await f.control.resume();
  expect(f.calls).toBe(1);
  expect(f.values).toEqual({});
  expect(f.order).toEqual(["persist", "reload", "consume", "connect"]);
});

test("ordinary activation never connects and expired/malformed reload markers are discarded", async () => {
  const f = fixture();
  await f.control.resume();
  expect(f.calls).toBe(0);
  for (const value of [true, "pending", Date.now() - 1, Date.now() + 60_000]) {
    f.values.reconnectAfterReloadUntil = value;
    await f.control.resume();
    expect(f.values).toEqual({});
    expect(f.calls).toBe(0);
  }
});

test("a failed resume is consumed before dialing and cannot retry on another activation", async () => {
  let until: unknown = Date.now() + 1000;
  let calls = 0;
  const control = createReloadControl({
    storage: {
      get: async () => ({ reconnectAfterReloadUntil: until }),
      set: async () => {},
      remove: async () => {
        until = undefined;
      },
    } as never,
    async connect() {
      calls++;
      expect(until).toBeUndefined();
      return Result.err({ code: "connect_failed" as const });
    },
    reload() {
      return Result.ok(undefined);
    },
  });
  expect((await control.resume()).isErr()).toBe(true);
  await control.resume();
  expect(calls).toBe(1);
});

test("storage write failure prevents reload, and consumption failure prevents reconnect", async () => {
  let reloads = 0;
  let connects = 0;
  const control = createReloadControl({
    storage: {
      get: async () => ({ reconnectAfterReloadUntil: Date.now() + 1000 }),
      set: async () => {
        return Promise.reject(new Error("write failed"));
      },
      remove: async () => {
        return Promise.reject(new Error("remove failed"));
      },
    } as never,
    async connect() {
      connects++;
      return Result.ok(undefined);
    },
    reload() {
      reloads++;
      return Result.ok(undefined);
    },
  });
  expect((await control.reload()).isErr()).toBe(true);
  expect((await control.resume()).isErr()).toBe(true);
  expect([reloads, connects]).toEqual([0, 0]);
});

test("scheduled reload and marker cleanup failures are reported without retrying", async () => {
  const reports: unknown[] = [];
  const cleanupReports: unknown[] = [];
  const control = createReloadControl({
    storage: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {
        throw new Error("marker cleanup failed");
      },
    } as never,
    connect: async () => Result.ok(undefined),
    reload: () => Result.err({ code: "reload_failed" as const }),
    report: (result) => reports.push(result),
    reportCleanup: (result) => cleanupReports.push(result),
  });

  expect(await control.reload()).toEqual(Result.ok(undefined));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reports).toEqual([Result.err({ code: "reload_failed", cleanupFailed: true })]);
  expect(cleanupReports).toEqual([Result.err({ code: "storage_failed" })]);
  expect(await control.resume()).toEqual(Result.ok(undefined));
});

test("a rejected reload adapter is reported and marker cleanup failure remains visible", async () => {
  const reports: unknown[] = [];
  const cleanupReports: unknown[] = [];
  const control = createReloadControl({
    storage: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {
        throw new Error("remove rejected");
      },
    } as never,
    connect: async () => Result.ok(undefined),
    reload: () => {
      throw new Error("reload rejected");
    },
    report: (result) => reports.push(result),
    reportCleanup: (result) => cleanupReports.push(result),
  });
  expect(await control.reload()).toEqual(Result.ok(undefined));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reports).toEqual([Result.err({ code: "reload_failed", cleanupFailed: true })]);
  expect(cleanupReports).toEqual([Result.err({ code: "storage_failed" })]);
});
