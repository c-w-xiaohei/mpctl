import {
  coverExecution,
  saveExecution,
  coverIdentity,
  coverReceipt,
  saveReceipt,
} from "./cover-save-fixture";
import { expect, test, spyOn } from "bun:test";
import { materialIdentity, uploadExecution, uploadReceipt } from "./upload-fixture";
import { Nexus, type Remote } from "@nexus-js/core";
import { createOperationId, protocolVersion } from "@mpctl/contracts";
import { Result } from "better-result";
import type { SerializedResult } from "better-result";
import { createPageEndpoint } from "../src/transport/page-bridge";
import {
  initializeContentServices,
  contentAuthorizationPolicy,
  createArticleCoverPageService,
} from "../entrypoints/mp.content";
import type { ChromeAdapterModel } from "@nexus-js/chrome";
import type { ContentAppMeta } from "../src/background-runtime";
import {
  articleFieldsToken,
  materialPageToken,
  articleCoverPageToken,
  contentStatusToken,
} from "../src/background-contracts";
import {
  bodyRequestDigest,
  pageEditorContentResultCodec,
  pageEditorToken,
} from "../src/page-contracts";
import { hashBody } from "../src/mp/body-hash";

const executorId = crypto.randomUUID();
const ledgerId = crypto.randomUUID();

async function wire<T, E extends { code: string }>(
  encoded: Promise<Result<SerializedResult<T, E>, E>>,
) {
  const result = await encoded;
  return Result.isOk(result) ? result.value : { status: "error" as const, error: result.error };
}

test.each(["ready", "during-status", "late-registration", "during-publication"] as const)(
  "content Relay %s keeps readiness inside document lifetime",
  async (mode) => {
    const mainBus = new EventTarget();
    const chromeBus = new EventTarget();
    const make = (target: EventTarget, side: "isolated" | "main", channelId: string) =>
      createPageEndpoint({
        target,
        side,
        channelId,
        eventNames: { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` },
      });
    const endpoints = [
      make(mainBus, "main", "page"),
      make(mainBus, "isolated", "page"),
      make(chromeBus, "main", "chrome"),
      make(chromeBus, "isolated", "chrome"),
    ];
    let html = "<p>fixture</p>";
    let failRead = false;
    let mainReads = 0;
    let mainWrites = 0;
    let readyCalls = 0;
    let receiptCalls = 0;
    let existingEditor:
      | (() =>
          | Remote<
              import("../src/page-contracts").PageEditorService,
              import("../src/transport/page-bridge").PageBridgeAdapterModel
            >
          | undefined)
      | undefined;
    const coverProvider = createArticleCoverPageService(
      {
        location: {
          href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
        },
      } as never,
      () => valid,
      () => existingEditor?.(),
    );
    let valid = true;
    let invalidate: (() => void | Promise<void>) | undefined;
    const app: ContentAppMeta = { protocolVersion, editorReady: false, loginExpired: false };
    const editorService = {
      ready: async () => (
        readyCalls++,
        {
          status: "ok" as const,
          value: { isReady: true as const, isNew: true, executorId },
        }
      ),
      getContent: async () => {
        mainReads++;
        return wire(
          pageEditorContentResultCodec.serialize(
            failRead ? Result.err({ code: "page_failed" }) : Result.ok(html),
          ),
        );
      },
      setContent: async (
        next: string,
        expectedHash: string,
        execution: { operationId: string; executorId: string },
      ) => {
        mainWrites++;
        html = next;
        const hash = await hashBody(next);
        return {
          status: "ok" as const,
          value: {
            operationId: execution.operationId,
            executorId: execution.executorId,
            requestDigest: await bodyRequestDigest(next, expectedHash),
            effect: {
              outcome: "confirmed" as const,
              bodyHash: Result.isOk(hash) ? hash.value : "0".repeat(64),
            },
            ended: true,
            result: { status: "ok" as const, value: {} },
          },
        };
      },
      getReceipt: async () => ({ status: "ok" as const, value: null }),
      setCoverFromBody: async () => ({
        status: "error" as const,
        error: { code: "unsupported" as const },
      }),
      getCoverReceipt: async () => (receiptCalls++, { status: "ok" as const, value: null }),
    };
    const main = new Nexus()
      .configure({ endpoint: { implementation: endpoints[0], meta: { app: { protocolVersion } } } })
      .provide(pageEditorToken, editorService);
    const page = new Nexus().configure({
      endpoint: { implementation: endpoints[1], meta: { app: { protocolVersion } } },
    });
    const content = new Nexus().configure({
      endpoint: {
        implementation: endpoints[2],
        meta: { app: { ...app } },
      },
      policy: contentAuthorizationPolicy(() => valid) as never,
    });
    const background = new Nexus().configure({
      endpoint: { implementation: endpoints[3], meta: { app: { protocolVersion } } },
    });
    try {
      await Promise.all([main.ready(), page.ready(), content.ready(), background.ready()]);
      const connection = await background.connect({ target: {} });
      let ready = false;
      connection.subscribeIdentity((meta) => {
        ready = (meta as { app?: { editorReady?: boolean } }).app?.editorReady === true;
      });
      const updateIdentity = content.updateIdentity.bind(content);
      const identityUpdate = spyOn(content, "updateIdentity").mockImplementation(async (meta) => {
        if (mode === "during-publication" && (meta as any).app?.editorReady === true) {
          valid = false;
          await invalidate?.();
        }
        return updateIdentity(meta);
      });
      let statusCalls = 0;
      const initialized = await initializeContentServices({
        document: { body: { classList: [] }, querySelector: () => null } as never,
        pageRuntime: page,
        chromeRuntime: content as never,
        app,
        validateTarget: () => valid,
        onEditor(accessor) {
          existingEditor = accessor;
        },
        onDispose: (cleanup) => {
          invalidate = cleanup;
          if (mode === "late-registration") valid = false;
        },
        pageState: async () => {
          if (++statusCalls === 2 && mode === "during-status") valid = false;
          return { state: "ready", route: "new", documentReady: true };
        },
      });
      identityUpdate.mockRestore();
      if (mode !== "ready") {
        expect(initialized).toEqual(Result.err({ code: "target_unavailable" }));
        expect(app.editorReady).toBe(false);
        expect(connection.contextMeta).toMatchObject({
          app: { editorReady: false, loginExpired: false },
        });
        const body = connection.safeGet(pageEditorToken);
        if (body.isOk()) expect((await Nexus.safeCall(body.value.getContent())).isErr()).toBe(true);
        expect([mainReads, mainWrites]).toEqual([0, 0]);
        return;
      }
      const readsAfterInitialization = mainReads;
      const beforeReceipt = [readyCalls, mainReads, mainWrites];
      expect(await coverProvider.getReceipt(createOperationId(ledgerId))).toEqual({
        status: "ok",
        value: null,
      });
      expect([readyCalls, mainReads, mainWrites]).toEqual(beforeReceipt);
      expect(receiptCalls).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(ready).toBe(true);
      expect(connection.contextMeta).toEqual({
        app: { protocolVersion, editorReady: true, loginExpired: false },
      });
      const remote = connection.get(pageEditorToken);
      expect(await remote.getContent()).toEqual({ status: "ok", value: html });
      failRead = true;
      const remoteError = await pageEditorContentResultCodec.deserialize(await remote.getContent());
      expect(Result.isError(remoteError) && remoteError.error).toEqual({ code: "page_failed" });
      failRead = false;
      expect(await remote.ready()).toEqual({
        status: "ok",
        value: { isReady: true, isNew: true, executorId },
      });
      expect(mainReads).toBeGreaterThan(readsAfterInitialization);
      expect(mainWrites).toBe(0);

      connection.disconnect();
      const reconnected = await background.connect({ target: {} });
      expect(await reconnected.get(pageEditorToken).getContent()).toEqual({
        status: "ok",
        value: html,
      });
      expect(mainWrites).toBe(0);
      const cached = reconnected.get(pageEditorToken);
      app.loginExpired = true;
      await content.updateIdentity({ app: { ...app } });
      expect(reconnected.contextMeta).toEqual({
        app: { protocolVersion, editorReady: true, loginExpired: true },
      });
      // Positive login identity cannot authorize BODY even if the caller's
      // synthetic target validator still returns true.
      expect(
        (
          await Nexus.safeCall(
            cached.setContent("must not write", "0".repeat(64), {
              operationId: createOperationId(ledgerId),
              executorId,
            }),
          )
        ).isErr(),
      ).toBe(true);
      expect(mainWrites).toBe(0);
      await main.updateIdentity({ app: { protocolVersion: "0.9.0" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        (
          await Nexus.safeCall(
            cached.setContent("must not write", "0".repeat(64), {
              operationId: createOperationId(ledgerId),
              executorId,
            }),
          )
        ).isErr(),
      ).toBe(true);
      expect(mainWrites).toBe(0);
      expect(reconnected.contextMeta).toEqual({
        app: { protocolVersion, editorReady: false, loginExpired: true },
      });
      const beforeRevokedReceipt = [readyCalls, mainReads, mainWrites, receiptCalls];
      expect(await coverProvider.getReceipt(createOperationId(ledgerId))).toMatchObject({
        status: "error",
        error: { code: "receipt_unreachable" },
      });
      expect([readyCalls, mainReads, mainWrites, receiptCalls]).toEqual(beforeRevokedReceipt);
    } finally {
      for (const endpoint of endpoints) endpoint.close?.();
    }
  },
);

test.each([undefined, "", "0.9.0", "0.12.0"])(
  "W2 refuses MAIN metadata %s before editor ready or Relay",
  async (version) => {
    const target = new EventTarget();
    const eventNames = { fromIsolated: "w2-main:in", fromMain: "w2-main:out" };
    const mainEndpoint = createPageEndpoint({
      target,
      channelId: "w2-main",
      side: "main",
      eventNames,
    });
    const pageEndpoint = createPageEndpoint({
      target,
      channelId: "w2-main",
      side: "isolated",
      eventNames,
    });
    let readyCalls = 0;
    const main = new Nexus()
      .configure({
        endpoint: {
          implementation: mainEndpoint,
          meta: version === undefined ? {} : { app: { protocolVersion: version } },
        },
      })
      .provide(pageEditorToken, {
        async ready() {
          readyCalls++;
          return {
            status: "ok" as const,
            value: { isReady: true as const, isNew: true, executorId },
          };
        },
        async getContent() {
          throw new Error("unexpected read");
        },
        async setContent() {
          throw new Error("unexpected write");
        },
        async getReceipt() {
          return { status: "ok" as const, value: null };
        },
        setCoverFromBody: async () => ({
          status: "error" as const,
          error: { code: "unsupported" as const },
        }),
        async getCoverReceipt() {
          return { status: "ok" as const, value: null };
        },
      });
    const page = new Nexus().configure({
      endpoint: { implementation: pageEndpoint, meta: { app: { protocolVersion } } },
    });
    const chromeTarget = new EventTarget();
    const chromeId = crypto.randomUUID();
    const chromeNames = { fromIsolated: `${chromeId}:in`, fromMain: `${chromeId}:out` };
    const contentEndpoint = createPageEndpoint({
      target: chromeTarget,
      channelId: chromeId,
      side: "main",
      eventNames: chromeNames,
    });
    const backgroundEndpoint = createPageEndpoint({
      target: chromeTarget,
      channelId: chromeId,
      side: "isolated",
      eventNames: chromeNames,
    });
    const content = new Nexus<ChromeAdapterModel<ContentAppMeta>>().configure({
      endpoint: {
        implementation: contentEndpoint,
        meta: {
          context: "content-script",
          url: "https://mp.weixin.qq.com/",
          origin: "https://mp.weixin.qq.com",
          app: { protocolVersion, editorReady: false },
        },
      },
      policy: contentAuthorizationPolicy(() => true),
    });
    const background = new Nexus().configure({
      endpoint: { implementation: backgroundEndpoint, meta: { app: { protocolVersion } } },
    });
    try {
      await Promise.all([main.ready(), page.ready(), content.ready(), background.ready()]);
      const result = await initializeContentServices({
        document: { body: { classList: [] }, querySelector: () => null } as never,
        pageRuntime: page,
        chromeRuntime: content,
        validateTarget: () => true,
        pageState: async () => ({ state: "ready", route: "new", documentReady: true }),
      });
      expect(result).toEqual(Result.err({ code: "version_mismatch" }));
      expect(readyCalls).toBe(0);
      const remote = await background.connect({ target: {} });
      expect(remote.safeGet(pageEditorToken).isErr()).toBe(true);
      expect(remote.contextMeta).toMatchObject({ app: { protocolVersion, editorReady: false } });
    } finally {
      mainEndpoint.close();
      pageEndpoint.close();
      contentEndpoint.close();
      backgroundEndpoint.close();
    }
  },
);

test.each([undefined, "", "0.9.0", protocolVersion])(
  "W2 production content policy refuses background %s before any DOM/BODY provider",
  async (version) => {
    const target = new EventTarget();
    const channelId = crypto.randomUUID();
    const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
    const contentEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
    const backgroundEndpoint = createPageEndpoint({
      target,
      channelId,
      side: "isolated",
      eventNames,
    });
    const counters = { fields: 0, upload: 0, cover: 0, save: 0, body: 0, status: 0 };
    const content = new Nexus<ChromeAdapterModel<ContentAppMeta>>().configure({
      endpoint: {
        implementation: contentEndpoint,
        meta: {
          context: "content-script",
          url: "https://mp.weixin.qq.com/",
          origin: "https://mp.weixin.qq.com",
          app: { protocolVersion, editorReady: true },
        },
      },
      policy: contentAuthorizationPolicy(() => true),
    });
    content.provide(articleFieldsToken, {
      ...fieldsProviderIdentity,
      async readArticleFields() {
        return { status: "ok" as const, value: { title: "Title", author: "", summary: "" } };
      },
      async updateArticleFields(fields, hash, execution) {
        counters.fields++;
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
    content.provide(pageEditorToken, {
      async ready() {
        return {
          status: "ok" as const,
          value: { isReady: true as const, isNew: true, executorId },
        };
      },
      async getContent() {
        return { status: "ok" as const, value: "body" };
      },
      async setContent(
        html: string,
        expectedHash: string,
        execution: { operationId: string; executorId: string },
      ) {
        counters.body++;
        const hash = await hashBody(html);
        return {
          status: "ok" as const,
          value: {
            operationId: execution.operationId,
            executorId: execution.executorId,
            requestDigest: await bodyRequestDigest(html, expectedHash),
            effect: {
              outcome: "confirmed" as const,
              bodyHash: Result.isOk(hash) ? hash.value : "0".repeat(64),
            },
            ended: true,
            result: { status: "ok" as const, value: {} },
          },
        };
      },
      async getReceipt() {
        return { status: "ok" as const, value: null };
      },
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
          value: { state: "ready" as const, route: "fixture", documentReady: true },
        };
      },
    });
    const background = new Nexus().configure({
      endpoint: {
        implementation: backgroundEndpoint,
        meta: {
          context: "background",
          ...(version === undefined ? {} : { app: { protocolVersion: version } }),
        },
      },
    });
    try {
      await Promise.all([content.ready(), background.ready()]);
      const connection = await background.safeConnect({ target: {}, timeout: 500 });
      if (version !== protocolVersion) {
        expect(connection.isErr()).toBe(true);
        expect(counters).toEqual({ fields: 0, upload: 0, cover: 0, save: 0, body: 0, status: 0 });
        return;
      }
      if (connection.isErr()) throw connection.error;
      const fields = connection.value.safeGet(articleFieldsToken).unwrap();
      const materials = connection.value.safeGet(materialPageToken).unwrap();
      const cover = connection.value.safeGet(articleCoverPageToken).unwrap();
      const editor = connection.value.safeGet(pageEditorToken).unwrap();
      const status = connection.value.safeGet(contentStatusToken).unwrap();
      expect(
        (
          await Nexus.safeCall(
            fields.updateArticleFields({ title: "next" }, "0".repeat(64), {
              operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
              executorId: fieldsExecutorId,
            }),
          )
        ).isOk(),
      ).toBe(true);
      expect(
        (
          await Nexus.safeCall(
            materials.upload(
              {
                blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
                  type: "image/png",
                }),
                filename: "x.png",
                mimeType: "image/png",
              },
              uploadExecution,
            ),
          )
        ).isOk(),
      ).toBe(true);
      expect(
        (
          await Nexus.safeCall(
            cover.set(
              { filename: "x.png", thumbnailUrl: "https://mmbiz.qpic.cn/x/300" },
              "0".repeat(64),
              coverExecution(),
            ),
          )
        ).isOk(),
      ).toBe(true);
      expect((await Nexus.safeCall(cover.save(saveExecution()))).isOk()).toBe(true);
      expect(
        (
          await Nexus.safeCall(
            editor.setContent("next", "0".repeat(64), {
              operationId: createOperationId(ledgerId),
              executorId,
            }),
          )
        ).isOk(),
      ).toBe(true);
      expect((await Nexus.safeCall(status.status())).isOk()).toBe(true);
      expect(counters).toEqual({ fields: 1, upload: 1, cover: 1, save: 1, body: 1, status: 1 });
      await background.updateIdentity({ app: { protocolVersion: "0.9.0" } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        (
          await Nexus.safeCall(
            fields.updateArticleFields({ title: "forbidden" }, "0".repeat(64), {
              operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
              executorId: fieldsExecutorId,
            }),
          )
        ).isErr(),
      ).toBe(true);
      expect(
        (
          await Nexus.safeCall(
            materials.upload(
              {
                blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
                  type: "image/png",
                }),
                filename: "x.png",
                mimeType: "image/png",
              },
              uploadExecution,
            ),
          )
        ).isErr(),
      ).toBe(true);
      expect(
        (
          await Nexus.safeCall(
            cover.set(
              { filename: "x.png", thumbnailUrl: "https://mmbiz.qpic.cn/x/300" },
              "0".repeat(64),
              coverExecution(),
            ),
          )
        ).isErr(),
      ).toBe(true);
      expect((await Nexus.safeCall(cover.save(saveExecution()))).isErr()).toBe(true);
      expect(
        (
          await Nexus.safeCall(
            editor.setContent("forbidden", "0".repeat(64), {
              operationId: createOperationId(ledgerId),
              executorId,
            }),
          )
        ).isErr(),
      ).toBe(true);
      expect(counters).toEqual({ fields: 1, upload: 1, cover: 1, save: 1, body: 1, status: 1 });
    } finally {
      contentEndpoint.close();
      backgroundEndpoint.close();
    }
  },
);
import { fieldsProviderIdentity, fieldsExecutorId, fieldsReceipt } from "./fields-fixture";
