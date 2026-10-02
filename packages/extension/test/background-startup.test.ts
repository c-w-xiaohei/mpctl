import { expect, test } from "bun:test";
import { Result } from "better-result";
import { createPageManager, restorePagesOnStartup } from "../src/pages";

test("startup restoration consumes rejection from both activation and browser startup", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const listeners: Array<() => void> = [];
  let lookups = 0;
  const writes: Record<string, unknown>[] = [];
  const reported: unknown[] = [];
  const manager = createPageManager({
    async getGroup(id) {
      expect(id).toBe(17);
      lookups++;
      if (lookups <= 2) throw new Error("temporary lookup failure");
    },
    async createTab() {
      throw new Error("startup must not create a group tab");
    },
    async groupTabs() {
      throw new Error("startup must not group a tab");
    },
    async updateGroup() {},
    async queryGroup() {
      return [];
    },
    async getTab(id) {
      return { id };
    },
    async getSession(key) {
      return key === "managedGroupId" ? { managedGroupId: 17 } : { managedGroupId: 17 };
    },
    async setSession(values) {
      writes.push(values);
    },
    async removeSession() {},
  });

  try {
    restorePagesOnStartup(
      async () => {
        const result = await manager.restore();
        if (result.isErr()) reported.push(result.error);
        return Result.ok(undefined);
      },
      (listener) => listeners.push(listener),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    listeners[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  expect(lookups).toBe(2);
  expect(unhandled).toHaveLength(0);
  expect(reported).toHaveLength(2);
  expect(writes).toHaveLength(0);
  expect(await manager.managedGroup()).toEqual(Result.ok(17));
  expect(lookups).toBe(3);
  expect(writes).toHaveLength(0);
});

test("session-read failures on activation and browser startup are consumed and retried by a command", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const listeners: Array<() => void> = [];
  let sessionReads = 0;
  let lookups = 0;
  let creations = 0;
  const writes: Record<string, unknown>[] = [];
  const reported: unknown[] = [];
  const manager = createPageManager({
    async getGroup(id) {
      expect(id).toBe(17);
      lookups++;
    },
    async createTab() {
      creations++;
      return { id: 1 };
    },
    async groupTabs() {
      throw new Error("saved group must be reused");
    },
    async updateGroup() {},
    async queryGroup() {
      return [];
    },
    async getTab(id) {
      return { id };
    },
    async getSession(key) {
      if (key !== "managedGroupId") return { managedGroupId: 17 };
      sessionReads++;
      if (sessionReads <= 2) throw new Error("session temporarily unavailable");
      return { managedGroupId: 17 };
    },
    async setSession(values) {
      writes.push(values);
    },
    async removeSession() {},
  });

  try {
    restorePagesOnStartup(
      async () => {
        const result = await manager.restore();
        if (result.isErr()) reported.push(result.error);
        return Result.ok(undefined);
      },
      (listener) => listeners.push(listener),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    listeners[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  expect(sessionReads).toBe(2);
  expect(unhandled).toHaveLength(0);
  expect(reported).toHaveLength(2);
  expect(creations).toBe(0);
  expect(writes).toHaveLength(0);
  expect(await manager.managedGroup()).toEqual(Result.ok(17));
  expect(sessionReads).toBe(3);
  expect(lookups).toBe(1);
  expect(creations).toBe(0);
  expect(writes).toHaveLength(0);
});
