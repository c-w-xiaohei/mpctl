import {
  coverExecution,
  saveExecution,
  coverIdentity,
  coverReceipt,
  saveReceipt,
} from "./cover-save-fixture";
import { expect, test } from "bun:test";
import { materialIdentity, uploadExecution, uploadReceipt } from "./upload-fixture";
import { Result } from "better-result";
import { createPageManager, restorePagesOnStartup } from "../src/pages";
import { Nexus, type Connection } from "@nexus-js/core";
import {
  createBackgroundScriptConfig,
  createContentScriptConfig,
  type ChromeAdapterModel,
} from "@nexus-js/chrome";
import { protocolVersion } from "@mpctl/contracts";
import { backgroundNexus, type PreparationAppMeta } from "../src/background-runtime";
import { pageEditorToken } from "../src/page-contracts";

const executorId = crypto.randomUUID();
import {
  contentStatusToken,
  articleFieldsToken,
  materialPageToken,
  articleCoverPageToken,
} from "../src/background-contracts";
import { appmsgRouteIdentity } from "../src/pages";

function nativeEvent<A extends unknown[]>() {
  const listeners = new Set<(...args: A) => void>();
  return {
    addListener(listener: (...args: A) => void) {
      listeners.add(listener);
    },
    removeListener(listener: (...args: A) => void) {
      listeners.delete(listener);
    },
    hasListener(listener: (...args: A) => void) {
      return listeners.has(listener);
    },
    hasListeners() {
      return listeners.size > 0;
    },
    addRules() {},
    removeRules() {},
    getRules() {},
    emit(...args: A) {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

function nativePortPair(name: string) {
  const aMessage = nativeEvent<[unknown, chrome.runtime.Port]>();
  const bMessage = nativeEvent<[unknown, chrome.runtime.Port]>();
  const aDisconnect = nativeEvent<[chrome.runtime.Port]>();
  const bDisconnect = nativeEvent<[chrome.runtime.Port]>();
  let closed = false;
  const disconnect = () => {
    if (closed) return;
    closed = true;
    aDisconnect.emit(a);
    bDisconnect.emit(b);
  };
  const a: chrome.runtime.Port = {
    name,
    onMessage: aMessage,
    onDisconnect: aDisconnect,
    disconnect,
    postMessage(message: unknown) {
      if (closed) throw new Error("port closed");
      const copy = structuredClone(message);
      queueMicrotask(() => {
        if (!closed) bMessage.emit(copy, b);
      });
    },
  };
  const b: chrome.runtime.Port = {
    name,
    sender: { id: "w2-extension", url: "chrome-extension://w2-extension/background.html" },
    onMessage: bMessage,
    onDisconnect: bDisconnect,
    disconnect,
    postMessage(message: unknown) {
      if (closed) throw new Error("port closed");
      const copy = structuredClone(message);
      queueMicrotask(() => {
        if (!closed) aMessage.emit(copy, a);
      });
    },
  };
  return { background: a, content: b, disconnect };
}

test("W2 default exact-document Chrome acquisition gates every business service before invocation", async () => {
  const previousChrome = globalThis.chrome;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const incoming = nativeEvent<[chrome.runtime.Port]>();
  const binding = {
    tabId: 41,
    documentId: "exact-w2-document",
    url: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&isNew=1",
  };
  const targets: Array<{ tabId: number; documentId?: string; frameId?: number }> = [];
  const ports: Array<ReturnType<typeof nativePortPair>> = [];
  const sessions: Array<Connection<ChromeAdapterModel<PreparationAppMeta>>> = [];
  Object.assign(globalThis, {
    document: { hidden: false },
    window: { location: { href: binding.url, origin: "https://mp.weixin.qq.com" } },
    chrome: {
      runtime: { id: "w2-extension", getManifest: () => ({ version: "1" }), onConnect: incoming },
      tabs: {
        connect(tabId: number, options: { name: string; documentId?: string; frameId?: number }) {
          targets.push({
            tabId,
            documentId: options.documentId,
            ...(options.frameId === undefined ? {} : { frameId: options.frameId }),
          });
          const pair = nativePortPair(options.name);
          ports.push(pair);
          queueMicrotask(() => incoming.emit(pair.content));
          return pair.background;
        },
      },
    },
  });
  const config = createBackgroundScriptConfig({ app: { protocolVersion } });
  backgroundNexus.configure(config);
  const stopObserving = backgroundNexus.onConnect((connection) => sessions.push(connection));
  try {
    await backgroundNexus.ready();
    for (const version of [undefined, "", "0.9.0", protocolVersion]) {
      const counters = {
        ready: 0,
        fields: 0,
        fieldWrites: 0,
        upload: 0,
        cover: 0,
        save: 0,
        status: 0,
      };
      const contentConfig = createContentScriptConfig({
        app:
          version === undefined
            ? {}
            : {
                protocolVersion: version,
                ...(version === protocolVersion ? { editorReady: true } : {}),
              },
      });
      const content = new Nexus().configure(contentConfig);
      content.provide(pageEditorToken, {
        acquireWrite: async () => ({
          status: "error" as const,
          error: { code: "unsupported" as const },
        }),
        releaseWrite: async () => ({
          status: "error" as const,
          error: { code: "unsupported" as const },
        }),
        async ready() {
          counters.ready++;
          return {
            status: "ok" as const,
            value: { isReady: true as const, isNew: true, executorId },
          };
        },
        async getContent() {
          return { status: "ok" as const, value: "body" };
        },
        async setContent() {
          throw new Error("this test owns acquisition, not MAIN write");
        },
        async getReceipt() {
          return { status: "ok" as const, value: null };
        },
        resolveImage: async () => ({
          status: "error" as const,
          error: { code: "unsupported" as const },
        }),
        setCoverFromBody: async () => ({
          status: "error" as const,
          error: { code: "unsupported" as const },
        }),
        async getCoverReceipt() {
          return { status: "ok" as const, value: null };
        },
      });
      content.provide(contentStatusToken, {
        async status() {
          counters.status++;
          return {
            status: "ok" as const,
            value: {
              state: "ready" as const,
              route: appmsgRouteIdentity(binding.url)!,
              documentReady: true,
            },
          };
        },
      });
      content.provide(articleFieldsToken, {
        ...fieldsProviderIdentity,
        async readArticleFields() {
          counters.fields++;
          return { status: "ok" as const, value: { title: "Title", author: "", summary: "" } };
        },
        async updateArticleFields(fields, hash, execution) {
          counters.fieldWrites++;
          return {
            status: "ok" as const,
            value: await fieldsReceipt(fields, hash, execution, "0".repeat(64)),
          };
        },
      });
      content.provide(materialPageToken, {
        ...materialIdentity,
        async list() {
          return { status: "ok" as const, value: { scope: "visible-page" as const, cards: [] } };
        },
        async upload(payload, execution) {
          counters.upload++;
          return {
            status: "ok" as const,
            value: await uploadReceipt(payload, execution),
          };
        },
      });
      content.provide(articleCoverPageToken, {
        ...coverIdentity,
        async read() {
          return { status: "ok" as const, value: "0".repeat(64) };
        },
        async set(_candidate, expected, execution) {
          counters.cover++;
          return coverReceipt(execution, expected);
        },
        async save(execution) {
          counters.save++;
          return saveReceipt(execution);
        },
      });
      await content.ready();
      const pages = createPageManager({
        async getGroup() {
          return {};
        },
        async createTab() {
          throw new Error("no navigation");
        },
        async groupTabs() {
          return 7;
        },
        async updateGroup() {},
        async queryGroup() {
          return [{ id: binding.tabId, url: binding.url }];
        },
        async getTab() {
          return { id: binding.tabId, url: binding.url };
        },
        async getLocal() {
          return { managedGroupId: 7 };
        },
        async setLocal() {},
        async getSession() {
          return { managedGroupId: 7 };
        },
        async setSession() {},
      });
      pages.observe(binding);
      try {
        const editor = await pages.open(binding);
        if (version === protocolVersion) {
          expect(editor.isOk()).toBe(true);
          if (editor.isOk()) expect((await editor.value.ready()).isOk()).toBe(true);
        } else expect(editor.isErr()).toBe(true);
        const fields = await pages.readArticleFields(binding);
        const status = await pages.pageStatus(binding);
        const fieldWrite = await pages.updateArticleFields(
          binding,
          { title: "next" },
          "0".repeat(64),
          {
            operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
            executorId: fieldsExecutorId,
          },
        );
        const upload = await pages.uploadMaterial(
          binding,
          {
            blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
              type: "image/png",
            }),
            filename: "x.png",
            mimeType: "image/png",
          },
          uploadExecution,
        );
        const cover = await pages.setArticleCover(
          binding,
          { filename: "x.png", thumbnailUrl: "https://mmbiz.qpic.cn/x/300" },
          "0".repeat(64),
          coverExecution(),
        );
        const save = await pages.saveArticle(binding, saveExecution());
        if (version === protocolVersion)
          for (const result of [fields, fieldWrite, status, upload, cover, save])
            expect(result).toMatchObject({ status: "ok" });
        else
          for (const result of [fields, fieldWrite, status, upload, cover, save])
            expect(result.isErr()).toBe(true);
        expect(counters).toEqual(
          version === protocolVersion
            ? { ready: 1, fields: 1, fieldWrites: 1, upload: 1, cover: 1, save: 1, status: 1 }
            : { ready: 0, fields: 0, fieldWrites: 0, upload: 0, cover: 0, save: 0, status: 0 },
        );
      } finally {
        for (const session of sessions.splice(0)) session.disconnect();
        contentConfig.endpoint?.implementation?.close?.();
        pages.dispose();
      }
    }
    expect(targets.length).toBeGreaterThanOrEqual(4);
    for (const target of targets)
      expect(target).toEqual({ tabId: binding.tabId, documentId: binding.documentId });
  } finally {
    stopObserving();
    for (const session of sessions.splice(0)) session.disconnect();
    for (const port of ports) port.disconnect();
    config.endpoint?.implementation?.close?.();
    Object.assign(globalThis, {
      chrome: previousChrome,
      window: previousWindow,
      document: previousDocument,
    });
  }
});

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
import { fieldsProviderIdentity, fieldsExecutorId, fieldsReceipt } from "./fields-fixture";
