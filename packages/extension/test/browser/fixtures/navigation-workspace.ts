import { Nexus } from "@nexus-js/core";
import { Result } from "better-result";
import {
  protocolVersion,
  operationResultCodec,
  articleResultCodec,
  createOperationId,
} from "@mpctl/contracts";
import { createOperations } from "../../../src/operations";
import { createPageManager, appmsgRouteIdentity, type PageBinding } from "../../../src/pages";
import { createWorkspace } from "../../../src/workspace";
import { createPageEndpoint } from "../../../src/transport/page-bridge";
import { createEditorService } from "../../../src/mp/jsapi";
import { pageEditorToken } from "../../../src/page-contracts";
import { homePageToken, materialPageToken } from "../../../src/background-contracts";

export async function navigationFixture(database = `navigation:${crypto.randomUUID()}`) {
  const operations = (await createOperations(database)).unwrap();
  const counters = { create: 0, group: 0, capture: 0, reload: 0, read: 0, set: 0 };
  let updates = 0;
  let captureEnded = false;
  const expired = new Set<number>();
  const freshDocuments = new Map<number, string>();
  let updateMode: "normal" | "lost" | "no-document" | "wrong-url" = "normal";
  const home = {
    tabId: 1,
    documentId: "home",
    url: "https://mp.weixin.qq.com/cgi-bin/home?t=home&token=account&lang=en_US",
  };
  const list = {
    tabId: 2,
    documentId: "list",
    url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10&token=account",
  };
  const newUrl =
    "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=account";
  const savedUrl = (candidate: string) =>
    `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${candidate}&token=account`;
  const tabs = new Map<number, { id: number; url: string }>([
    [1, { id: 1, url: home.url }],
    [2, { id: 2, url: list.url }],
  ]);
  const members = new Set([1, 2]);
  let nextTab = 3;
  let alive = true;
  let readFailure = false;
  let groupFailure = false;
  let createdReached!: () => void;
  let groupRelease!: () => void;
  let held = false;
  let groupGate: Promise<void> = Promise.resolve();
  let createdBarrier: Promise<void> = Promise.resolve();
  let readReached!: () => void;
  let readBarrier: Promise<void> = Promise.resolve();
  let readRelease: (() => void) | undefined;
  let holdRead = false;
  let materialCalls = 0;
  let materialWire: () => Promise<any> = async () => ({
    status: "ok",
    value: { scope: "visible-page", cards: [] },
  });
  const eventTarget = new EventTarget();
  const channelId = crypto.randomUUID();
  const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
  const main = createPageEndpoint({ target: eventTarget, channelId, side: "main", eventNames });
  const isolated = createPageEndpoint({
    target: eventTarget,
    channelId,
    side: "isolated",
    eventNames,
  });
  const provider = new Nexus()
    .configure({ endpoint: { implementation: main, meta: { app: { protocolVersion } } } })
    .provide(homePageToken, {
      isReady: async () => ({ status: "ok" as const, value: true }),
      openDraftList: async () => ({ status: "ok" as const, value: list.url }),
    })
    .provide(materialPageToken, {
      list: async () => {
        materialCalls++;
        return materialWire();
      },
    } as never)
    .provide(
      pageEditorToken,
      createEditorService({
        invoke(request) {
          if (request.apiName === "mp_editor_get_isready")
            request.sucCb({ isReady: true, isNew: true });
          else if (request.apiName === "mp_editor_get_content") {
            counters.read++;
            if (readFailure) request.errCb({ msg: "fixture" });
            else if (holdRead) {
              holdRead = false;
              readRelease = () => request.sucCb({ content: "dirty content retained" });
              readReached();
            } else request.sucCb({ content: "dirty content retained" });
          } else {
            counters.set++;
            request.sucCb({});
          }
        },
      }),
    );
  const client = new Nexus().configure({
    endpoint: { implementation: isolated, meta: { app: { protocolVersion } } },
  });
  await Promise.all([provider.ready(), client.ready()]);
  const connection = await client.connect({ target: {} });
  let manager: ReturnType<typeof createPageManager>;
  let beforeNavigate: ((details: { tabId: number; frameId: number }) => void) | undefined;
  const api = {
    onBeforeNavigate(listener: (details: { tabId: number; frameId: number }) => void) {
      beforeNavigate = listener;
    },
    getGroup: async () => ({ id: 10 }),
    queryGroups: async () => [{ id: 10, title: "mpctl" }],
    queryGroup: async () => [...tabs.values()].filter((tab) => members.has(tab.id)),
    queryMpTabs: async () => [...tabs.values()],
    queryAllTabs: async () => [...tabs.values()],
    getTab: async (id: number) => {
      if (!alive || !tabs.has(id)) throw new Error("fixture tab unavailable");
      return tabs.get(id)!;
    },
    getFrame: async ({
      tabId,
    }: {
      tabId: number;
    }): Promise<{ documentId: string; url?: string }> => ({
      documentId:
        freshDocuments.get(tabId) ??
        (tabId === 1 ? home.documentId : tabId === 2 ? list.documentId : `doc:${tabId}`),
      url: tabs.get(tabId)?.url,
    }),
    getSession: async () => ({ managedGroupId: 10 }),
    setSession: async () => {},
    updateGroup: async () => {},
    executeMain: async ({ args }: { args?: string[] }): Promise<unknown[]> => {
      counters.capture++;
      return [
        {
          result: {
            kind: "captured",
            ...(captureEnded ? { ended: true } : {}),
            url: args?.[0] ? savedUrl(args[0]) : newUrl,
          },
        },
      ];
    },
    createTab: async ({ url }: { url: string }) => {
      counters.create++;
      const id = nextTab++;
      if (url === "https://mp.weixin.qq.com/") url = home.url;
      tabs.set(id, { id, url });
      manager.observe({ tabId: id, documentId: `doc:${id}`, url });
      return { id, url };
    },
    groupTabs: async (id: number) => {
      counters.group++;
      if (held) {
        createdReached();
        await groupGate;
      }
      if (groupFailure) throw new Error("private group error");
      members.add(id);
      return 10;
    },
    reloadTab: async () => {
      counters.reload++;
    },
    updateTab: async (id: number, { url }: { url: string }) => {
      updates++;
      tabs.get(id)!.url = url;
      if (updateMode === "no-document") return;
      expired.delete(id);
      if (updateMode === "wrong-url")
        tabs.get(id)!.url = url.replace("token=account", "token=wrong");
      const documentId = `fresh:${id}:${updates}`;
      freshDocuments.set(id, documentId);
      manager.observe({ tabId: id, documentId, url: tabs.get(id)!.url });
      if (updateMode === "lost")
        throw new Error("synthetic update delivery unknown after fresh document");
    },
  };
  manager = createPageManager(
    api,
    async () => connection.get(pageEditorToken),
    async (binding) => ({
      state: expired.has(binding.tabId) ? "not_logged_in" : "ready",
      route: appmsgRouteIdentity(binding.url)!,
      documentReady: true,
    }),
    async () => [
      { candidate: "A", title: "A" },
      { candidate: "B", title: "B" },
    ],
    async () => connection,
  );
  manager.validateSavedArticle = async (binding) =>
    expired.has(binding.tabId)
      ? Result.err({ code: "not_logged_in" })
      : Result.ok({ valid: true, title: "saved" });
  manager.observe(home);
  manager.observe(list);
  await manager.restore();
  const workspace = createWorkspace({
    pages: manager,
    operations: Promise.resolve(Result.ok(operations)),
  });
  const decode = async (wire: Awaited<ReturnType<typeof workspace.newArticle>>) =>
    (await operationResultCodec.deserialize(wire)).unwrap();
  return {
    operations,
    workspace,
    manager,
    counters,
    get updates() {
      return updates;
    },
    api,
    database,
    expireSaved(candidate: string, mode: typeof updateMode = "normal", listExpired = false) {
      const tab = [...tabs.values()].find(
        (tab) => new URL(tab.url).searchParams.get("appmsgid") === candidate,
      );
      if (!tab) throw new Error("saved fixture missing");
      tab.url = tab.url.replace("token=account", "token=old-account");
      manager.observe({ tabId: tab.id, documentId: `doc:${tab.id}`, url: tab.url });
      expired.add(tab.id);
      captureEnded = true;
      if (listExpired) expired.add(list.tabId);
      updateMode = mode;
      return tab.id;
    },
    navigationStarted(tabId: number) {
      beforeNavigate?.({ tabId, frameId: 0 });
    },
    materialCalls: () => materialCalls,
    materialReply(reply: () => Promise<any>) {
      materialWire = reply;
    },
    id: () => createOperationId(operations.ledgerId),
    decode,
    holdGroup() {
      held = true;
      createdBarrier = new Promise((done) => {
        createdReached = done;
      });
      groupGate = new Promise((done) => {
        groupRelease = done;
      });
    },
    reached: () => createdBarrier,
    release() {
      held = false;
      groupRelease?.();
    },
    failGroup() {
      groupFailure = true;
    },
    failRead() {
      readFailure = true;
    },
    holdRead() {
      holdRead = true;
      readBarrier = new Promise((done) => {
        readReached = done;
      });
    },
    readReached: () => readBarrier,
    releaseRead() {
      readRelease?.();
    },
    expire() {
      alive = false;
    },
    missingHome() {
      tabs.delete(1);
      members.delete(1);
    },
    changeAccount(candidate: string) {
      const target = [...tabs.values()].find(
        (tab) => new URL(tab.url).searchParams.get("appmsgid") === candidate,
      );
      if (!target) throw new Error("saved page unavailable");
      target.url = target.url.replace("token=account", "token=other-account");
      manager.observe({ tabId: target.id, documentId: `doc:${target.id}`, url: target.url });
    },
    async current(candidate?: string) {
      return (
        await articleResultCodec.deserialize(
          await workspace.currentArticle(candidate ? { candidate } : { new: true }),
        )
      ).unwrap();
    },
    addSaved(candidate: string) {
      const id = nextTab++;
      const binding: PageBinding = { tabId: id, documentId: `doc:${id}`, url: savedUrl(candidate) };
      tabs.set(id, { id, url: binding.url });
      members.add(id);
      manager.observe(binding);
      return binding;
    },
    dispose() {
      held = false;
      groupRelease?.();
      readRelease?.();
      main.close();
      isolated.close();
    },
  };
}
