import { expect, test } from "bun:test";
import { Result } from "better-result";
import { createPageManager } from "../src/pages";

function browser() {
  const groups = new Map<number, { id: number; title: string }>();
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  let created = 0;
  const api = {
    async getGroup(id: number) {
      const group = groups.get(id);
      if (!group) throw new Error(`No group with id: ${id}`);
      return group;
    },
    async queryGroups() {
      return [...groups.values()].filter((g) => g.title === "mpctl");
    },
    async createTab() {
      created++;
      return { id: created };
    },
    async groupTabs(_tabId: number, groupId?: number) {
      if (groupId !== undefined) return groupId;
      const id = 100 + created;
      groups.set(id, { id, title: "" });
      return id;
    },
    async updateGroup(id: number, options: { title: string }) {
      groups.get(id)!.title = options.title;
    },
    async queryGroup() {
      return [];
    },
    async queryMpTabs() {
      return [];
    },
    async getTab(id: number) {
      return { id };
    },
    async getSession(key?: string | null) {
      return key ? { [key]: session[key] } : { ...session };
    },
    async setSession(values: Record<string, unknown>) {
      Object.assign(session, values);
    },
    async getLocal(key: string) {
      return { [key]: local[key] };
    },
    async setLocal(values: Record<string, unknown>) {
      Object.assign(local, values);
    },
  };
  return { api, groups, local, session, created: () => created };
}

test("restore ignores legacy document hints without deleting them; observe writes no hint", async () => {
  const b = browser();
  b.local.managedGroupId = 22;
  b.groups.set(22, { id: 22, title: "mpctl" });
  const binding = {
    tabId: 1,
    documentId: "legacy-document",
    url: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
  };
  b.session["document:1"] = binding;
  const reads: Array<string | null | undefined> = [];
  const writes: Record<string, unknown>[] = [];
  const manager = createPageManager({
    ...b.api,
    async getSession(key) {
      reads.push(key);
      return b.api.getSession(key);
    },
    async setSession(values) {
      writes.push(values);
      await b.api.setSession(values);
    },
    async getTab(id) {
      return { id, url: binding.url };
    },
  });
  try {
    expect(await manager.restore()).toEqual(Result.ok(undefined));
    expect(await manager.managedGroup()).toEqual(Result.ok(22));
    expect(await manager.isCurrent(binding)).toEqual(Result.ok(false));
    expect(reads).not.toContain(null);
    expect(reads).not.toContain(undefined);
    expect(b.session["document:1"]).toEqual(binding);
    const before = writes.length;
    manager.observe({ ...binding, documentId: "fresh-document" });
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toHaveLength(before);
    expect(b.session["document:1"]).toEqual(binding);
    expect(b.created()).toBe(0);
  } finally {
    manager.dispose();
  }
});

test("reuses the durable group lock after extension session storage is lost", async () => {
  const b = browser();
  const first = createPageManager(b.api as never);
  expect(Result.isOk(await first.restore())).toBe(true);
  const firstGroup = await first.managedGroup();
  expect(Result.isOk(firstGroup)).toBe(true);
  if (Result.isError(firstGroup)) throw firstGroup.error;
  const id = firstGroup.value;
  for (const key of Object.keys(b.session)) delete b.session[key];
  const restarted = createPageManager(b.api as never);
  expect(Result.isOk(await restarted.restore())).toBe(true);
  const restartedGroup = await restarted.managedGroup();
  expect(Result.isOk(restartedGroup) && restartedGroup.value).toBe(id);
  expect(b.created()).toBe(1);
  expect(b.local.managedGroupId).toBe(id);
});

test("reads the durable group lock before a command even without startup restore", async () => {
  const b = browser();
  b.local.managedGroupId = 22;
  b.groups.set(22, { id: 22, title: "mpctl" });
  const manager = createPageManager(b.api as never);
  const group = await manager.managedGroup();
  expect(Result.isOk(group) && group.value).toBe(22);
  expect(b.created()).toBe(0);
});

test.each(["", "."])(
  "recovers an existing group after Chrome's exact missing-ID error ending '%s'",
  async (punctuation) => {
    const b = browser();
    b.local.managedGroupId = 99;
    b.groups.set(22, { id: 22, title: "mpctl" });
    const getGroup = b.api.getGroup;
    b.api.getGroup = async (id) => {
      if (id === 99) throw new Error(`No group with id: ${id}${punctuation}`);
      return getGroup(id);
    };
    const manager = createPageManager(b.api as never);
    expect(Result.isOk(await manager.restore())).toBe(true);
    const group = await manager.managedGroup();
    expect(Result.isOk(group) && group.value).toBe(22);
    expect(b.created()).toBe(0);
    expect(b.local.managedGroupId).toBe(22);
  },
);

test("does not create a replacement on an indeterminate group lookup failure", async () => {
  const b = browser();
  b.local.managedGroupId = 99;
  b.api.getGroup = async () => {
    throw new Error("Chrome API unavailable");
  };
  const manager = createPageManager(b.api as never);
  expect(await manager.restore()).toMatchObject({ error: { code: "page_failed" } });
  expect(await manager.managedGroup()).toMatchObject({ error: { code: "page_failed" } });
  expect(b.created()).toBe(0);
});

test("cleanup merges duplicate groups without closing article tabs", async () => {
  const b = browser();
  b.local.managedGroupId = 22;
  b.groups.set(22, { id: 22, title: "mpctl" });
  b.groups.set(23, { id: 23, title: "mpctl" });
  b.groups.set(24, { id: 24, title: "personal" });
  const membership = new Map([
    [1, 22],
    [2, 23],
    [3, 23],
    [4, 24],
  ]);
  const api = {
    ...b.api,
    async queryGroup(group: number) {
      return [...membership.entries()].filter(([, id]) => id === group).map(([id]) => ({ id }));
    },
    async groupTabs(tab: number, group?: number) {
      if (group === undefined) throw new Error("cleanup must reuse the locked group");
      const old = membership.get(tab)!;
      membership.set(tab, group);
      if (![...membership.values()].includes(old)) b.groups.delete(old);
      return group;
    },
  };
  const manager = createPageManager(api as never);
  expect(Result.isOk(await manager.restore())).toBe(true);
  expect(await manager.cleanupWorkspace()).toMatchObject({
    value: {
      groupsRemoved: 1,
      tabsMoved: 2,
      groupsRemaining: 1,
    },
  });
  expect([...membership.values()]).toEqual([22, 22, 22, 24]);
  expect(b.groups.has(24)).toBe(true);
  expect(b.created()).toBe(0);
});

test("failed durable lock migration retains the group instead of choosing another", async () => {
  const b = browser();
  b.session.managedGroupId = 22;
  b.groups.set(22, { id: 22, title: "mpctl" });
  let failing = true;
  b.api.setLocal = async (values) => {
    if (failing) throw new Error("Storage temporarily unavailable");
    Object.assign(b.local, values);
  };
  const manager = createPageManager(b.api as never);
  expect(await manager.restore()).toMatchObject({ error: { code: "page_failed" } });
  expect(await manager.managedGroup()).toMatchObject({ error: { code: "page_failed" } });
  expect(b.created()).toBe(0);
  failing = false;
  const group = await manager.managedGroup();
  expect(Result.isOk(group) && group.value).toBe(22);
  expect(b.local.managedGroupId).toBe(22);
});

test("cleanup refuses to import a duplicate saved article without moving or closing either tab", async () => {
  const b = browser();
  b.local.managedGroupId = 22;
  b.groups.set(22, { id: 22, title: "mpctl" });
  b.groups.set(23, { id: 23, title: "mpctl" });
  const url =
    "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=same";
  let moved = 0;
  const manager = createPageManager({
    ...b.api,
    async getTab(id: number) {
      return { id, url };
    },
    async queryGroup(group: number) {
      return [{ id: group === 22 ? 1 : 2, url }];
    },
    async groupTabs() {
      moved++;
      return 22;
    },
  } as never);
  expect(await manager.cleanupWorkspace()).toMatchObject({ error: { code: "target_ambiguous" } });
  expect(moved).toBe(0);
  expect(b.groups.size).toBe(2);
  expect(b.created()).toBe(0);
});
