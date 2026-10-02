import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import {
  appmsgRouteIdentity,
  classifyAppmsgUrl,
  createPageManager,
  draftListUrl,
  editorPageUrl,
  isDraftListUrl,
  isEditorPageUrl,
  type PageBinding,
} from "../src/pages";
import { draftPageToken, homePageToken } from "../src/background-contracts";
import {
  currentItemCountResultCodec,
  homeIsReadyResultCodec,
  listDraftsResultCodec,
  validateDraftResultCodec,
} from "../src/background-contracts";

async function wire<T, E>(
  codec: {
    serialize(
      value: import("better-result").Result<T, E>,
    ): Promise<import("better-result").Result<unknown, unknown>>;
  },
  value: import("better-result").Result<T, E>,
) {
  const result = await codec.serialize(value);
  if (Result.isError(result)) throw result.error;
  return result.value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const api = (overrides: Record<string, unknown> = {}) => ({
  async getGroup() {
    return {};
  },
  async createTab() {
    return { id: 1 };
  },
  async groupTabs() {
    return 7;
  },
  async updateGroup() {},
  async queryGroup() {
    return [];
  },
  async queryMpTabs() {
    return [];
  },
  async getTab(id: number) {
    return { id, url: draftListUrl };
  },
  async getSession(key?: string | null) {
    return key ? {} : { managedGroupId: 7 };
  },
  async setSession() {},
  async removeSession() {},
  ...overrides,
});

const unwrap = <T, E>(result: import("better-result").Result<T, E>): T => {
  if (Result.isError(result)) throw result.error;
  return result.value;
};

const homeUrl = "https://mp.weixin.qq.com/cgi-bin/home?t=home&lang=en_US&token=context";
const savedUrl =
  "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=g1&token=context";

function navigationFixture(frameApi = true) {
  const tabs = new Map<number, { id: number; url: string }>([
    [1, { id: 1, url: homeUrl }],
    [2, { id: 2, url: draftListUrl }],
  ]);
  const created: string[] = [];
  let targetUrl = `${editorPageUrl}&token=context&timestamp=before`;
  let frameLookup: ((binding: PageBinding) => void) | undefined;
  let beforeNavigate: ((details: { tabId: number; frameId: number }) => void) | undefined;
  let committed:
    | ((details: { tabId: number; frameId: number; documentId: string }) => void)
    | undefined;
  let onStatus: ((binding: PageBinding) => void) | undefined;
  let onCapture: (() => void | Promise<void>) | undefined;
  let status: "ready" | "loading" | "not_logged_in" = "ready";
  let onCreate: ((binding: PageBinding) => void) | undefined;
  let lookupError: Error | undefined;
  let lookupTabId: number | undefined;
  let updated: ((tabId: number, status: "loading" | "complete") => void) | undefined;
  let resolveFrame:
    | ((tabId: number) => Promise<{ documentId?: string } | null | undefined>)
    | undefined;
  let observeCreated = true;
  let id = 10;
  const manager = createPageManager(
    api({
      async queryAllTabs() {
        return [...tabs.values()];
      },
      async queryMpTabs() {
        return [...tabs.values()];
      },
      async queryGroup() {
        return [...tabs.values()];
      },
      async getTab(tabId: number) {
        const tab = tabs.get(tabId)!;
        frameLookup?.({
          tabId,
          documentId: tabId < 10 ? `source-${tabId}` : `target-${tabId}`,
          url: tab.url,
        });
        if (lookupError && (lookupTabId === undefined || lookupTabId === tabId)) throw lookupError;
        return tabs.get(tabId)!;
      },
      ...(frameApi
        ? {
            async getFrame({ tabId }: { tabId: number }) {
              if (resolveFrame) return resolveFrame(tabId);
              return { documentId: tabId < 10 ? `source-${tabId}` : `target-${tabId}` };
            },
          }
        : {}),
      onTabUpdated(listener: typeof updated) {
        updated = listener;
      },
      async executeMain({ args }: { args?: string[] }) {
        await onCapture?.();
        return [{ result: { kind: "captured", url: args ? savedUrl : targetUrl } }];
      },
      async createTab({ url }: { url: string }) {
        created.push(url);
        const tab = { id: id++, url };
        tabs.set(tab.id, tab);
        const binding = { tabId: tab.id, documentId: `target-${tab.id}`, url };
        if (observeCreated) manager.observe(binding);
        onCreate?.(binding);
        return tab;
      },
      onBeforeNavigate(listener: typeof beforeNavigate) {
        beforeNavigate = listener;
      },
      onCommitted(listener: typeof committed) {
        committed = listener;
      },
    }) as never,
    undefined,
    async (binding) => {
      onStatus?.(binding);
      return { state: status, route: appmsgRouteIdentity(binding.url)!, documentReady: true };
    },
    async () => [{ candidate: "g1", title: "Draft" }],
    async () =>
      ({
        get(token: unknown) {
          if (token === homePageToken)
            return {
              async isReady() {
                return wire(homeIsReadyResultCodec, Result.ok(true));
              },
            };
          if (token === draftPageToken)
            return {
              async listDrafts() {
                return wire(
                  listDraftsResultCodec,
                  Result.ok([{ candidate: "g1", title: "Draft" }]),
                );
              },
              async validateDraft() {
                return wire(validateDraftResultCodec, Result.ok({ valid: true, title: "Draft" }));
              },
              async currentItemCount() {
                return wire(currentItemCountResultCodec, Result.ok(1));
              },
            };
          throw new Error("Unexpected service");
        },
      }) as never,
  );
  const home = { tabId: 1, documentId: "source-1", url: homeUrl };
  const list = { tabId: 2, documentId: "source-2", url: draftListUrl };
  manager.observe(home);
  manager.observe(list);
  return {
    manager,
    tabs,
    created,
    home,
    list,
    setTargetUrl(value: string) {
      targetUrl = value;
    },
    setStatus(value: typeof status) {
      status = value;
    },
    onStatus(fn: typeof onStatus) {
      onStatus = fn;
    },
    onLookup(fn: typeof frameLookup) {
      frameLookup = fn;
    },
    onCapture(fn: typeof onCapture) {
      onCapture = fn;
    },
    onCreate(fn: typeof onCreate) {
      onCreate = fn;
    },
    setLookupError(value: Error, tabId?: number) {
      lookupError = value;
      lookupTabId = tabId;
    },
    setFrameResolver(resolver: typeof resolveFrame) {
      resolveFrame = resolver;
    },
    loading(tabId: number) {
      updated?.(tabId, "loading");
    },
    delayObservation() {
      observeCreated = false;
    },
    navigate(tabId: number, documentId: string) {
      beforeNavigate?.({ tabId, frameId: 0 });
      committed?.({ tabId, frameId: 0, documentId });
    },
  };
}

describe("automatic navigation identity and bounded readiness", () => {
  test.each([
    ["rejection", () => Promise.reject(new Error("frame lookup rejected"))],
    ["missing frame", () => Promise.resolve(undefined)],
    ["absent document ID", () => Promise.resolve({})],
    [
      "synchronous throw",
      () => {
        throw new Error("frame lookup threw");
      },
    ],
  ])("settles and invalidates the observed binding after getFrame %s", async (_label, lookup) => {
    const f = navigationFixture();
    const old = f.list;
    f.setFrameResolver(lookup);
    f.loading(old.tabId);
    await Promise.resolve();
    await Promise.resolve();

    expect(await f.manager.isCurrent(old)).toMatchObject({ value: false });

    f.setFrameResolver(undefined);
    f.manager.observe({ ...old, documentId: "reobserved-document" });
    const fresh = { ...old, documentId: "reobserved-document" };
    expect(await f.manager.isCurrent(old)).toMatchObject({ value: false });
    expect(await f.manager.isCurrent(fresh)).toMatchObject({ value: true });
  });

  test("settles as unavailable when the getFrame seam is absent", async () => {
    const f = navigationFixture(false);
    f.loading(f.list.tabId);
    expect(await f.manager.isCurrent(f.list)).toMatchObject({ value: false });
    const fresh = { ...f.list, documentId: "fresh-after-missing-frame-api" };
    f.manager.observe(fresh);
    expect(await f.manager.isCurrent(f.list)).toMatchObject({ value: false });
    expect(await f.manager.isCurrent(fresh)).toMatchObject({ value: true });
  });

  test("an older failed getFrame check cannot clear a newer pending check", async () => {
    const f = navigationFixture();
    const oldLookup = deferred<{ documentId?: string } | null>();
    const newLookup = deferred<{ documentId?: string } | null>();
    let count = 0;
    f.setFrameResolver(() => (++count === 1 ? oldLookup.promise : newLookup.promise));
    f.loading(f.list.tabId);
    f.loading(f.list.tabId);
    oldLookup.reject(new Error("old lookup failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(await f.manager.isCurrent(f.list)).toMatchObject({ value: false });

    newLookup.resolve({ documentId: f.list.documentId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await f.manager.isCurrent(f.list)).toMatchObject({ value: true });
  });

  test("new creates the captured native target instead of reusing an existing editor", async () => {
    const f = navigationFixture();
    f.tabs.set(3, { id: 3, url: editorPageUrl });
    f.manager.observe({ tabId: 3, documentId: "existing", url: editorPageUrl });
    const binding = unwrap(await f.manager.ensureEditorTab());
    expect(binding.tabId).toBe(10);
    expect(f.created).toEqual([`${editorPageUrl}&token=context&timestamp=before`]);
  });
  test("checks all eligible homes for ambiguity, including homes outside the group", async () => {
    const f = navigationFixture();
    f.tabs.set(4, { id: 4, url: homeUrl });
    f.manager.observe({ tabId: 4, documentId: "other-account", url: homeUrl });
    expect(await f.manager.findManagedHome()).toMatchObject({
      error: { code: "navigation_failed", stage: "source_ambiguous" },
    });
    expect(f.created).toHaveLength(0);
  });
  test("source replacement during native capture prevents creating a target", async () => {
    const f = navigationFixture();
    f.onCapture(() => f.manager.observe({ ...f.home, documentId: "replacement" }));
    expect(await f.manager.ensureEditorTab()).toMatchObject({
      error: { code: "navigation_failed", stage: "source_changed" },
    });
    expect(f.created).toHaveLength(0);
  });
  test("allows only timestamp changes in the final native target URL", async () => {
    const f = navigationFixture();
    f.onCreate((binding) => {
      const url = binding.url.replace("timestamp=before", "timestamp=after");
      f.tabs.set(binding.tabId, { id: binding.tabId, url });
      f.manager.observe({ ...binding, url });
    });
    expect(unwrap(await f.manager.ensureEditorTab()).url).toContain("timestamp=after");
  });
  for (const mutation of [
    (url: string) => url.replace("token=context", "token=changed"),
    (url: string) => `${url}#changed`,
    (url: string) => `${url}&createType=changed`,
  ])
    test("rejects final context or fragment drift despite the same semantic editor route", async () => {
      const f = navigationFixture();
      f.onCreate((binding) => {
        const url = mutation(binding.url);
        f.tabs.set(binding.tabId, { id: binding.tabId, url });
        f.manager.observe({ ...binding, url });
      });
      expect(await f.manager.ensureEditorTab()).toMatchObject({
        error: { code: "navigation_failed", stage: "target_not_ready" },
      });
    });
  test("first target document replacement while status is awaited cannot become ready", async () => {
    const f = navigationFixture();
    f.onStatus((binding) => {
      if (binding.tabId >= 10) f.manager.observe({ ...binding, documentId: "replacement" });
    });
    expect(await f.manager.ensureEditorTab()).toMatchObject({
      error: { code: "navigation_failed", stage: "target_not_ready" },
    });
  });
  test("login timeout at target readiness rejects instead of adopting another page", async () => {
    const f = navigationFixture();
    f.setStatus("not_logged_in");
    expect(await f.manager.ensureEditorTab()).toMatchObject({
      error: { code: "not_logged_in", pageCreated: true },
    });
  });
  test("saved target login failure carries pageCreated without a fabricated stage", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.setStatus("not_logged_in");
    expect(await f.manager.openDraftGroup(f.list, "g1")).toMatchObject({
      error: { code: "not_logged_in", pageCreated: true },
    });
  });
  test("saved target lookup failure carries pageCreated and keeps page_failed", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.setLookupError(new Error("target lookup unavailable"), 10);
    expect(await f.manager.openDraftGroup(f.list, "g1")).toMatchObject({
      error: { code: "page_failed", pageCreated: true },
    });
  });
  test("target lookup failure preserves page-created fact without inventing a navigation stage", async () => {
    const f = navigationFixture();
    f.setLookupError(new Error("lookup unavailable"), 10);
    expect(await f.manager.ensureEditorTab()).toMatchObject({
      error: { code: "page_failed", pageCreated: true },
    });
  });
  test("unknown Chrome lookup remains a lookup failure when the binding did not change", async () => {
    const f = navigationFixture();
    const error = new Error("indeterminate");
    f.setLookupError(error);
    expect(await f.manager.isCurrent(f.list)).toMatchObject({ error: { code: "page_failed" } });
  });
  test("lookup completion cannot return an old document or revived A-B-A route", async () => {
    const f = navigationFixture();
    let switched = false;
    f.onLookup(() => {
      if (switched) return;
      switched = true;
      f.manager.observe({ ...f.list, url: draftListUrl.replace("begin=0", "begin=10") });
      f.manager.observe(f.list);
    });
    expect(unwrap(await f.manager.isCurrent(f.list))).toBe(false);
  });
  test("navigation barrier rejects old document before the replacement is observed", async () => {
    const f = navigationFixture();
    f.navigate(2, "new-list-document");
    expect(unwrap(await f.manager.isCurrent(f.list))).toBe(false);
    f.manager.observe({ ...f.list, documentId: "new-list-document" });
    expect(unwrap(await f.manager.isCurrent({ ...f.list, documentId: "new-list-document" }))).toBe(
      true,
    );
  });
  test("list refuses a document change or timeout appearing during group inspection", async () => {
    const f = navigationFixture();
    let calls = 0;
    f.onStatus((binding) => {
      if (binding.tabId === 2 && ++calls === 2)
        f.manager.observe({ ...binding, documentId: "replaced-list" });
    });
    expect(await f.manager.listDraftGroups(f.list)).toMatchObject({
      error: { code: "target_unavailable" },
    });
    const timeout = navigationFixture();
    let reads = 0;
    timeout.onStatus(() => {
      if (++reads === 2) timeout.setStatus("not_logged_in");
    });
    expect(await timeout.manager.listDraftGroups(timeout.list)).toMatchObject({
      error: { code: "not_logged_in" },
    });
  });
  test("saved open waits for the captured group and rejects final target drift", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    const binding = unwrap(await f.manager.openDraftGroup(f.list, "g1"));
    expect(binding?.tabId).toBe(10);
    const drift = navigationFixture();
    unwrap(await drift.manager.managedGroup());
    drift.onCreate((binding) =>
      drift.tabs.set(binding.tabId, {
        id: binding.tabId,
        url: savedUrl.replace("context", "changed"),
      }),
    );
    expect(await drift.manager.openDraftGroup(drift.list, "g1")).toMatchObject({
      error: { code: "navigation_failed", stage: "target_not_ready", pageCreated: true },
    });
  });
  test("saved editor replacement during final readiness cannot issue the old binding", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.onStatus((binding) => f.manager.observe({ ...binding, documentId: "saved-replacement" }));
    expect(await f.manager.openDraftGroup(f.list, "g1")).toMatchObject({
      error: { code: "navigation_failed", pageCreated: true },
    });
  });
  test("saved target observed before navigation commit waits for that same document", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.onCreate(() => {
      f.navigate(10, "target-10");
      setTimeout(
        () => f.manager.observe({ tabId: 10, documentId: "target-10", url: savedUrl }),
        20,
      );
    });
    expect(unwrap(await f.manager.openDraftGroup(f.list, "g1"))?.documentId).toBe("target-10");
  });
  test("committed saved document waits for its first content session instead of failing early", async () => {
    const f = navigationFixture();
    f.delayObservation();
    unwrap(await f.manager.managedGroup());
    f.onCreate(() => {
      f.navigate(10, "target-10");
      setTimeout(
        () => f.manager.observe({ tabId: 10, documentId: "target-10", url: savedUrl }),
        20,
      );
    });
    expect(unwrap(await f.manager.openDraftGroup(f.list, "g1"))?.documentId).toBe("target-10");
  });
  test("two concurrent opens of one group return their own documents without a shared group slot", async () => {
    const f = navigationFixture();
    f.delayObservation();
    unwrap(await f.manager.managedGroup());
    f.onCreate((binding) =>
      setTimeout(() => f.manager.observe(binding), binding.tabId === 10 ? 30 : 5),
    );
    const [a, b] = (
      await Promise.all([
        f.manager.openDraftGroup(f.list, "g1"),
        f.manager.openDraftGroup(f.list, "g1"),
      ])
    ).map(unwrap);
    expect(a?.tabId).not.toBe(b?.tabId);
    expect([a?.documentId, b?.documentId].sort()).toEqual(["target-10", "target-11"]);
    expect(f.created).toHaveLength(2);
  });
  test("saved native capture hooks are serialized per source while each request keeps its own result", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    let active = 0;
    let maximum = 0;
    f.onCapture(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
    });
    const results = await Promise.all([
      f.manager.openDraftGroup(f.list, "g1"),
      f.manager.openDraftGroup(f.list, "g1"),
    ]);
    expect(maximum).toBe(1);
    expect(new Set(results.map((result) => unwrap(result)?.tabId)).size).toBe(2);
  });
  test("current refuses two existing editors even if only one has an observed session", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.tabs.set(3, { id: 3, url: editorPageUrl });
    f.tabs.set(4, { id: 4, url: editorPageUrl });
    f.manager.observe({ tabId: 3, documentId: "existing", url: editorPageUrl });
    expect(await f.manager.findCurrentEditor()).toMatchObject({
      error: { code: "target_ambiguous" },
    });
    expect(f.created).toHaveLength(0);
  });
  test("current uses the sole existing editor document without capture or creating a tab", async () => {
    const f = navigationFixture();
    unwrap(await f.manager.managedGroup());
    f.tabs.set(3, { id: 3, url: editorPageUrl });
    f.manager.observe({ tabId: 3, documentId: "sole-existing", url: editorPageUrl });
    const binding = unwrap(await f.manager.findCurrentEditor());
    expect(binding?.documentId).toBe("sole-existing");
    expect(f.created).toHaveLength(0);
  });
  test("current on an empty workspace does not create a tab or a workspace group", async () => {
    const f = navigationFixture();
    expect(unwrap(await f.manager.findCurrentEditor())).toBeUndefined();
    expect(f.created).toHaveLength(0);
  });
});

describe("page route and document identity", () => {
  test("recognizes only supported observed routes and binds route-bearing fields", () => {
    expect(classifyAppmsgUrl(draftListUrl).kind).toBe("draft-list");
    expect(isDraftListUrl(draftListUrl)).toBe(true);
    expect(classifyAppmsgUrl(editorPageUrl).kind).toBe("new");
    expect(isEditorPageUrl(editorPageUrl)).toBe(true);
    expect(classifyAppmsgUrl("https://example.test/article").kind).toBe("unsupported");
    expect(appmsgRouteIdentity(`${editorPageUrl}&token=changed`)).toBe(
      appmsgRouteIdentity(editorPageUrl),
    );
    expect(appmsgRouteIdentity(draftListUrl.replace("begin=0", "begin=10"))).not.toBe(
      appmsgRouteIdentity(draftListUrl),
    );
  });

  test("status connection is acquired for the exact current document", async () => {
    const connected: string[] = [];
    const manager = createPageManager(
      api({
        async getTab(id: number) {
          return { id, url: draftListUrl };
        },
      }) as never,
      undefined,
      undefined,
      undefined,
      async (binding) => {
        connected.push(binding.documentId);
        return {
          get() {
            return {
              async status() {
                return {
                  state: "ready",
                  route: appmsgRouteIdentity(binding.url)!,
                  documentReady: true,
                };
              },
            };
          },
        } as never;
      },
    );
    const first = { tabId: 9, documentId: "doc-A", url: draftListUrl };
    manager.observe(first);
    await manager.pageStatus(first);
    manager.observe({ ...first, documentId: "doc-B" });
    await manager.pageStatus({ ...first, documentId: "doc-B" });
    expect(connected).toContain("doc-A");
    expect(connected).toContain("doc-B");
  });

  test("propagates unknown Chrome lookup failures without treating them as confirmed navigation", async () => {
    const failure = new Error("unknown tab lookup");
    const manager = createPageManager(
      api({
        async getTab() {
          throw failure;
        },
      }) as never,
    );
    const binding = { tabId: 12, documentId: "unknown-lookup", url: draftListUrl };
    manager.observe(binding);
    const result = await manager.isCurrent(binding);
    expect(result).toMatchObject({ status: "error", error: { code: "page_failed" } });
    expect(failure.message).toBe("unknown tab lookup");
  });
});
