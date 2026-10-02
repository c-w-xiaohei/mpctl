import { expect, test } from "bun:test";
import { Result } from "better-result";
import { closeConnectPageTab, runConnectPageAttempt } from "../entrypoints/connect/main";

test("closeConnectPageTab closes the current tab and returns success", async () => {
  const removed: number[] = [];
  const events: string[] = [];
  const result = await closeConnectPageTab(
    {
      getCurrent: async () => ({ id: 27 }),
      remove: async (id) => {
        events.push("remove");
        removed.push(id);
      },
    },
    "connect_failed",
    (scope, code) => events.push(`${scope}:${code}`),
  );

  expect(result).toEqual(Result.ok(undefined));
  expect(removed).toEqual([27]);
  expect(events).toEqual(["connect page:connect_failed", "remove"]);
});

test("closeConnectPageTab returns lookup and close failures as Results", async () => {
  const lookupFailure = await closeConnectPageTab({
    getCurrent: async () => {
      throw new Error("tab lookup failed");
    },
    remove: async () => {},
  });
  expect(lookupFailure).toEqual(Result.err({ code: "tab_lookup_failed" }));

  const closeFailure = await closeConnectPageTab({
    getCurrent: async () => ({ id: 27 }),
    remove: async () => {
      throw new Error("tab remove failed");
    },
  });
  expect(closeFailure).toEqual(Result.err({ code: "tab_close_failed" }));
});

test("the real attempt finalizer closes the tab after a successful connection", async () => {
  const events: string[] = [];
  const result = await runConnectPageAttempt(
    async () => {
      events.push("connect");
      return Result.ok({ connected: true });
    },
    {
      getCurrent: async () => ({ id: 42 }),
      remove: async (id) => {
        events.push(`remove:${id}`);
      },
    },
    (scope, code) => events.push(`${scope}:${code}`),
  );

  expect(result).toEqual(Result.ok({ connected: true }));
  expect(events).toEqual(["connect", "remove:42"]);
});

test("the real attempt finalizer reports connection Err before closing and preserves Err if close fails", async () => {
  const events: string[] = [];
  const result = await runConnectPageAttempt(
    async () => {
      events.push("connect");
      return Result.err({ code: "connect_failed" });
    },
    {
      getCurrent: async () => ({ id: 43 }),
      remove: async () => {
        events.push("remove");
        throw new Error("permission denied");
      },
    },
    (scope, code) => events.push(`${scope}:${code}`),
  );

  expect(result).toEqual(Result.err({ code: "connect_failed" }));
  expect(events).toEqual([
    "connect",
    "connect page:connect_failed",
    "remove",
    "connect page tab close:tab_close_failed",
  ]);
});

test("the real attempt finalizer also closes after acquisition failure", async () => {
  const events: string[] = [];
  const result = await runConnectPageAttempt(
    async () => {
      events.push("acquire");
      return Result.err({ code: "background_unavailable" });
    },
    {
      getCurrent: async () => ({ id: 44 }),
      remove: async (id) => {
        events.push(`remove:${id}`);
      },
    },
    (scope, code) => events.push(`${scope}:${code}`),
  );

  expect(result).toEqual(Result.err({ code: "background_unavailable" }));
  expect(events).toEqual(["acquire", "connect page:background_unavailable", "remove:44"]);
});
