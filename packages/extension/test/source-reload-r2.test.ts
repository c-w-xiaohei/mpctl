import { afterEach, beforeEach, expect, test } from "bun:test";
import { Result } from "better-result";
import { installIdbFixture } from "./idb-fixture";
import { navigationFixture } from "./browser/fixtures/navigation-workspace";

let restore: () => void;
beforeEach(() => {
  restore = installIdbFixture();
});
afterEach(() => restore());

for (const maintenance of [false, true]) {
  for (const completed of [false, true]) {
    test(`R2 ${maintenance ? "maintenance" : "navigation"}: placement docB ${completed ? "then post-dispatch docC completes" : "cannot complete acknowledged reload"}`, async () => {
      const f = await navigationFixture();
      try {
        const list = {
          tabId: 2,
          documentId: "docB",
          url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10&token=account",
        };
        const originalGroup = f.api.groupTabs;
        const originalCurrent = f.manager.isCurrent.bind(f.manager);
        if (!maintenance)
          f.manager.isCurrent = async (binding) =>
            binding.tabId === 2 && binding.documentId === "list"
              ? Result.ok(false)
              : originalCurrent(binding);
        let dispatchDocument = "docA";
        f.api.groupTabs = async (id) => {
          const result = await originalGroup(id);
          f.manager.observe(list);
          dispatchDocument = "docB";
          return result;
        };
        const originalFrame = f.api.getFrame;
        f.api.getFrame = async ({ tabId }) =>
          tabId === 2 ? { documentId: dispatchDocument, url: list.url } : originalFrame({ tabId });
        let entered!: () => void;
        const dispatched = new Promise<void>((done) => {
          entered = done;
        });
        let release!: () => void;
        const gate = new Promise<void>((done) => {
          release = done;
        });
        f.api.reloadTab = async () => {
          f.counters.reload++;
          entered();
          await gate;
          if (completed) {
            dispatchDocument = "docC";
            f.manager.observe({ ...list, documentId: "docC" });
          }
        };
        const input = { operationId: f.id(), candidate: "not-in-list" };
        const request = maintenance ? f.workspace.listArticles() : f.workspace.openArticle(input);
        await dispatched;
        expect((await f.operations.pending()).unwrap()).toHaveLength(1);
        release();
        const response = await request;
        const pending = (await f.operations.pending()).unwrap();
        expect(pending).toHaveLength(completed ? 0 : 1);
        if (!completed) {
          const snapshot = pending[0]!.snapshot;
          expect(snapshot.state).toBe("unresolved");
          const before = { ...f.counters };
          expect(
            (await f.decode(await f.workspace.getOperation(snapshot.operationId))).snapshot,
          ).toEqual(snapshot);
          if (!maintenance)
            expect((await f.decode(await f.workspace.openArticle(input))).snapshot).toEqual(
              snapshot,
            );
          expect(await f.workspace.cleanupWorkspace()).toMatchObject({
            status: "error",
            error: { blockingOperationId: snapshot.operationId },
          });
          expect(
            (
              await f.operations.maintenance(async () => {
                throw new Error("must not dispatch runtime reload");
              })
            ).isErr(),
          ).toBe(true);
          const next = await f.decode(await f.workspace.newArticle({ operationId: f.id() }));
          expect(next.snapshot).toMatchObject({ state: "settled", result: { status: "error" } });
          expect(f.counters).toEqual(before);
        } else expect(response.status).toBe("ok");
        expect(f.counters).toEqual({ create: 0, group: 1, capture: 0, reload: 1, read: 0, set: 0 });
      } finally {
        f.dispose();
      }
    }, 25000);
  }
}

for (const invalidation of [
  "missing",
  "pending",
  "changed-after-tab-read",
  "wrong-route",
] as const) {
  test(`R2 ${invalidation} dispatch baseline refuses with zero reload`, async () => {
    const f = await navigationFixture();
    try {
      const list = {
        tabId: 2,
        documentId: "docB",
        url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10&token=account",
      };
      const group = f.api.groupTabs;
      const getTab = f.api.getTab;
      let placementDone = false;
      f.api.groupTabs = async (id) => {
        const result = await group(id);
        placementDone = true;
        f.manager.observe(list);
        if (invalidation === "missing") f.manager.dispose();
        if (invalidation === "pending") f.navigationStarted(2);
        if (invalidation === "wrong-route")
          f.manager.observe({ ...list, url: list.url.replace("count=10", "count=20") });
        return result;
      };
      f.api.getTab = async (id) => {
        const tab = await getTab(id);
        if (id === 2 && placementDone && invalidation === "changed-after-tab-read")
          f.manager.observe({ ...list, documentId: "unverified-docC" });
        return tab;
      };
      const response = await f.workspace.listArticles();
      expect(response.status).toBe("error");
      expect(f.counters).toEqual({ create: 0, group: 1, capture: 0, reload: 0, read: 0, set: 0 });
      expect((await f.operations.pending()).unwrap()).toEqual([]);
    } finally {
      f.dispose();
    }
  });
}

test("R2 post-dispatch old docB, wrong-tab and wrong-route observations cannot retire reload", async () => {
  const f = await navigationFixture();
  try {
    const list = {
      tabId: 2,
      documentId: "docB",
      url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10&token=account",
    };
    const group = f.api.groupTabs;
    f.api.groupTabs = async (id) => {
      const result = await group(id);
      f.manager.observe(list);
      return result;
    };
    f.api.reloadTab = async () => {
      f.counters.reload++;
      f.manager.observe(list);
      f.manager.observe({ ...list, tabId: 99, documentId: "wrong-tab-docC" });
      f.manager.observe({
        ...list,
        documentId: "wrong-route-docC",
        url: list.url.replace("count=10", "count=20"),
      });
    };
    await f.workspace.listArticles();
    const pending = (await f.operations.pending()).unwrap();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.snapshot.state).toBe("unresolved");
    expect(f.counters).toEqual({ create: 0, group: 1, capture: 0, reload: 1, read: 0, set: 0 });
  } finally {
    f.dispose();
  }
}, 25000);
