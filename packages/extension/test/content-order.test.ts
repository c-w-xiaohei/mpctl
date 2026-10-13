import { describe, expect, test, spyOn } from "bun:test";
import { Nexus } from "@nexus-js/core";
import { createOperationId, protocolVersion } from "@mpctl/contracts";
import { Result } from "better-result";
import type { SerializedResult } from "better-result";
import { createPageEndpoint } from "../src/transport/page-bridge";
import { captureNativeNewEditorUrl } from "../src/pages";
import { hashBody } from "../src/mp/body-hash";
import { hashArticleFields } from "../src/mp/article-fields";
import { detectLoginTimeout } from "../src/mp/editor";
import {
  pageEditorReadyResultCodec,
  pageEditorContentResultCodec,
  pageEditorWriteResultCodec,
  pageEditorToken,
  bodyRequestDigest,
} from "../src/page-contracts";

const executorId = crypto.randomUUID();
const ledgerId = crypto.randomUUID();
async function bodyReceipt(
  html: string,
  expectedHash: string,
  execution: { operationId: string; executorId: string },
) {
  return {
    operationId: execution.operationId,
    executorId: execution.executorId,
    requestDigest: await bodyRequestDigest(html, expectedHash),
    effect: { outcome: "confirmed" as const, bodyHash: await hashForTest(html) },
    ended: true,
    result: { status: "ok" as const, value: {} },
  };
}
import {
  listDraftsResultCodec,
  validateDraftResultCodec,
  currentItemCountResultCodec,
  homeIsReadyResultCodec,
  openDraftListResultCodec,
  articleFieldsToken,
  articleFieldsResultCodec,
  articleFieldUpdateResultCodec,
  fieldsIdentityResultCodec,
} from "../src/background-contracts";

async function wire<T, E extends { code: string }>(
  encoded: Promise<Result<SerializedResult<T, E>, E>>,
) {
  const result = await encoded;
  return Result.isOk(result) ? result.value : { status: "error" as const, error: result.error };
}
import {
  createDraftPageService,
  createHomePageService,
  initializeContentServices,
  runContentStartup,
  createArticleFieldsService,
} from "../entrypoints/mp.content";
import contentScript from "../entrypoints/mp.content";
import * as pageBridge from "../src/transport/page-bridge";

const token = pageEditorToken;

function fieldsDocument() {
  const reads = { title: 0, author: 0, summary: 0, body: 0, writes: 0 };
  const values = { author: "Author", summary: "" };
  const element = (
    tagName: string,
    attrs: Record<string, string>,
    key: "title" | "author" | "summary",
  ) => {
    const node: Record<string, unknown> = {
      tagName: tagName.toUpperCase(),
      isConnected: true,
      hidden: false,
      type: "text",
      getAttribute: (name: string) => attrs[name] ?? null,
      getClientRects: () => [{}],
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      },
      disabled: false,
      readOnly: false,
      dispatchEvent() {
        return true;
      },
    };
    if (key === "title")
      Object.defineProperty(node, "innerText", {
        get() {
          reads.title++;
          return "Title";
        },
      });
    else
      Object.defineProperty(node, "value", {
        get() {
          reads[key]++;
          return values[key];
        },
        set(value: string) {
          reads.writes++;
          values[key] = value;
        },
      });
    return node;
  };
  const controls: Record<string, unknown[]> = {
    'div[contenteditable="true"]': [
      element("div", { contenteditable: "true", "data-placeholder": "请在这里输入标题" }, "title"),
    ],
    'input#author[name="author"]': [
      element("input", { id: "author", name: "author", type: "text" }, "author"),
    ],
    'textarea#js_description[name="digest"]': [
      element("textarea", { id: "js_description", name: "digest" }, "summary"),
    ],
  };
  const document = {
    location: {
      href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
    },
    body: { classList: [] },
    querySelector: () => null,
    querySelectorAll(selector: string) {
      return controls[selector] ?? [];
    },
  } as unknown as Document;
  const defaultView = {
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    HTMLInputElement: {
      prototype: {
        set value(value: string) {
          values.author = value;
        },
      },
    },
    HTMLTextAreaElement: {
      prototype: {
        set value(value: string) {
          values.summary = value;
        },
      },
    },
    Event: class {
      constructor(readonly type: string) {}
    },
  };
  Object.defineProperty(document, "defaultView", { value: defaultView });
  for (const node of [
    ...controls['input#author[name="author"]']!,
    ...controls['textarea#js_description[name="digest"]']!,
  ])
    Object.defineProperty(node, "ownerDocument", { value: document });
  return { document, reads, values, controls, defaultView };
}

async function hashForTest(html: string): Promise<string> {
  const result = await hashBody(html);
  expect(Result.isOk(result)).toBe(true);
  return Result.isOk(result) ? result.value : "";
}
async function fieldsExecution(service: ReturnType<typeof createArticleFieldsService>) {
  const identity = await service.identity();
  if (identity.status !== "ok") throw new Error("identity unavailable");
  return { operationId: createOperationId(ledgerId), executorId: identity.value.executorId };
}

describe("content-script readiness ordering", () => {
  test.each(["failed", "invalidated-during-inject", "late-dispose-error"] as const)(
    "B1 MAIN bootstrap %s owns the document and late bridge",
    async (mode) => {
      const url =
        "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77";
      let expired = false;
      let mutation!: () => void;
      let disconnected = 0;
      const invalidations: Array<() => void> = [];
      const identities: Array<unknown> = [];
      const originals = ["document", "location", "window", "MutationObserver"].map(
        (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
      );
      const document = {
        location: { href: url },
        readyState: "complete",
        body: {
          get classList() {
            return expired ? ["page_error", "page_timeout"] : [];
          },
        },
        querySelector(selector: string) {
          return !expired
            ? null
            : selector === "#info"
              ? { textContent: "登录超时，请重新登录" }
              : selector === "#jumpUrl"
                ? { href: "https://mp.weixin.qq.com/cgi-bin/loginpage" }
                : null;
        },
      };
      Object.defineProperty(globalThis, "document", { configurable: true, value: document });
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: document.location,
      });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location: { href: url, origin: "https://mp.weixin.qq.com" } },
      });
      Object.defineProperty(globalThis, "MutationObserver", {
        configurable: true,
        value: class {
          constructor(callback: () => void) {
            mutation = callback;
          }
          observe() {}
          disconnect() {
            disconnected++;
          }
        },
      });
      const configure = spyOn(Nexus.prototype, "configure").mockImplementation(
        function (this: Nexus) {
          return this;
        },
      );
      const ready = spyOn(Nexus.prototype, "ready").mockResolvedValue();
      const provide = spyOn(Nexus.prototype, "provide").mockImplementation(function (this: Nexus) {
        return this;
      });
      const connect = spyOn(Nexus.prototype, "connect").mockResolvedValue({} as never);
      const update = spyOn(Nexus.prototype, "updateIdentity").mockImplementation(async (meta) => {
        identities.push(structuredClone(meta));
      });
      let entered!: () => void;
      const injecting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const injection = new Promise<void>((resolve) => {
        release = resolve;
      });
      let disposals = 0;
      const disposeResult =
        mode === "late-dispose-error"
          ? Result.err({ code: "cleanup_failed" as const, cause: "disposal_failed" as const })
          : Result.ok();
      let disposed: Promise<typeof disposeResult> | undefined;
      const inject = spyOn(pageBridge, "injectMainWorldBridge").mockImplementation(
        async (_document, _ctx, prepare) => {
          if (mode === "failed") return Result.err({ code: "inject_failed" });
          await prepare?.({} as never);
          entered();
          await injection;
          return Result.ok({
            endpoint: {} as never,
            channelId: "late-bridge",
            dispose: () => (disposed ??= (disposals++, Promise.resolve(disposeResult))),
          });
        },
      );
      const log = spyOn(console, "error").mockImplementation(() => {});
      try {
        const starting = contentScript.main!({
          onInvalidated(callback: () => void) {
            invalidations.push(callback);
          },
        } as never);
        if (mode !== "failed") {
          await injecting;
          // WXT abort listeners do not replay for later registrations.
          for (const invalidated of [...invalidations]) invalidated();
          release();
          await starting;
          expect(disposals).toBe(1);
          expect(connect).toHaveBeenCalledTimes(1);
          expect(identities.some((meta: any) => meta.app?.editorReady === true)).toBe(false);
          expect(disconnected).toBe(1);
          if (mode === "late-dispose-error")
            expect(log.mock.calls.some((call) => (call[1] as any)?.code === "cleanup_failed")).toBe(
              true,
            );
          return;
        }
        await starting;
        expect(inject).toHaveBeenCalledTimes(1);
        expect(disconnected).toBe(0);
        expired = true;
        mutation();
        expect(identities).toContainEqual({
          app: { protocolVersion, editorReady: false, loginExpired: true },
        });
        // A route change cannot publish the old document's positive login fact.
        const count = identities.length;
        document.location.href = "https://mp.weixin.qq.com/cgi-bin/home?t=home";
        mutation();
        expect(identities).toHaveLength(count);
        for (const invalidated of invalidations) invalidated();
        await Promise.resolve();
        expect(disconnected).toBe(1);
        document.location.href = url;
        expired = false;
        mutation();
        expect(identities).toHaveLength(count);
      } finally {
        release();
        for (const spy of [configure, ready, provide, connect, update, inject, log])
          spy.mockRestore();
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  );
  test("V2/V3 genuine Nexus replacement cannot consume the original fields execution binding", async () => {
    const fixture = fieldsDocument();
    const target = new EventTarget();
    const channelId = crypto.randomUUID();
    const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
    const server = createPageEndpoint({ target, channelId, side: "main", eventNames });
    const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
    let valid = true;
    const original = createArticleFieldsService(fixture.document, () => valid);
    const provider = new Nexus()
      .configure({ endpoint: { implementation: server, meta: { app: { protocolVersion } } } })
      .provide(articleFieldsToken, original);
    const client = new Nexus().configure({
      endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
    });
    try {
      await Promise.all([provider.ready(), client.ready()]);
      const connection = await client.connect({ target: {} });
      const remote = connection.get(articleFieldsToken);
      const identity = (
        await fieldsIdentityResultCodec.deserialize(
          (await Nexus.safeCall(remote.identity())).unwrap(),
        )
      ).unwrap();
      const execution = {
        operationId: createOperationId(ledgerId),
        executorId: identity.executorId,
      };
      const hash = (
        await hashArticleFields({ title: "Title", author: "Author", summary: "" })
      ).unwrap();
      const first = (
        await articleFieldUpdateResultCodec.deserialize(
          (
            await Nexus.safeCall(remote.updateArticleFields({ author: "new" }, hash, execution))
          ).unwrap(),
        )
      ).unwrap();
      expect(first.effect).toMatchObject({ attempted: ["author"], confirmed: ["author"] });
      valid = false;
      provider.provide(
        articleFieldsToken,
        createArticleFieldsService(fixture.document, () => true),
      );
      await provider.updateIdentity({ app: { protocolVersion } });
      const next = connection.get(articleFieldsToken);
      const replacementIdentity = (
        await fieldsIdentityResultCodec.deserialize(
          (await Nexus.safeCall(next.identity())).unwrap(),
        )
      ).unwrap();
      expect(replacementIdentity.executorId).not.toBe(identity.executorId);
      const received = await Nexus.safeCall(
        next.updateArticleFields({ author: "new" }, hash, execution),
      );
      expect(received.isOk()).toBe(true);
      expect(await articleFieldUpdateResultCodec.deserialize(received.unwrap())).toEqual(
        Result.err({ code: "executor_mismatch" }),
      );
      expect(fixture.values).toEqual({ author: "new", summary: "" });
      const before = { ...fixture.reads };
      expect(await original.getReceipt(execution.operationId)).toMatchObject({
        status: "ok",
        value: first,
      });
      expect(fixture.reads).toEqual(before);
    } finally {
      server.close?.();
      clientEndpoint.close?.();
    }
  });
  test("G1 unkeyed field provider entry is rejected before any DOM read or mutation", async () => {
    const fixture = fieldsDocument();
    const service = createArticleFieldsService(fixture.document, () => true);
    const unkeyed = await (
      service.updateArticleFields as unknown as (fields: unknown, hash: string) => Promise<unknown>
    )({ author: "new" }, "a".repeat(64));
    expect(unkeyed).toEqual({ status: "error", error: { code: "invalid_operation" } });
    expect(fixture.reads).toEqual({ title: 0, author: 0, summary: 0, body: 0, writes: 0 });
    expect(fixture.values).toEqual({ author: "Author", summary: "" });
  });
  test("K0/K1/K3/V2 fields reserves before digest, distinguishes omission/value/hash, replays historical receipt and refuses replacement", async () => {
    const fixture = fieldsDocument();
    let valid = true;
    let sets = 0;
    const events: string[] = [];
    Object.defineProperty(fixture.defaultView.HTMLInputElement.prototype, "value", {
      configurable: true,
      set(value: string) {
        sets++;
        fixture.values.author = value;
      },
    });
    (
      fixture.controls['input#author[name="author"]']![0] as {
        dispatchEvent(event: Event): boolean;
      }
    ).dispatchEvent = (event) => {
      events.push(event.type);
      return true;
    };
    const service = createArticleFieldsService(fixture.document, () => valid);
    const execution = await fieldsExecution(service);
    const hash = (
      await hashArticleFields({ title: "Title", author: "Author", summary: "" })
    ).unwrap();
    const digest = crypto.subtle.digest;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let reached!: () => void;
    const entered = new Promise<void>((done) => {
      reached = done;
    });
    let first = true;
    crypto.subtle.digest = (async (...args: Parameters<typeof digest>) => {
      if (first) {
        first = false;
        reached();
        await gate;
      }
      return digest.apply(crypto.subtle, args);
    }) as typeof digest;
    try {
      const original = service.updateArticleFields({ author: "new" }, hash, execution);
      await entered;
      const duplicate = service.updateArticleFields({ author: "new" }, hash, execution);
      expect(duplicate).toBe(original);
      for (const [fields, expected] of [
        [{ author: "other" }, hash],
        [{ author: "new", summary: "" }, hash],
        [{ author: "new" }, "0".repeat(64)],
      ] as const) {
        expect(await service.updateArticleFields(fields, expected, execution)).toMatchObject({
          status: "error",
          error: { code: "operation_conflict" },
        });
      }
      expect(sets).toBe(0);
      release();
      const result = await original;
      expect(await duplicate).toEqual(result);
      expect(sets).toBe(1);
      expect(events).toEqual(["input", "change"]);
      valid = false;
      const before = { ...fixture.reads };
      expect(await service.updateArticleFields({ author: "new" }, hash, execution)).toEqual(result);
      expect(await service.getReceipt(execution.operationId)).toEqual(result);
      expect(fixture.reads).toEqual(before);
      const replacement = createArticleFieldsService(fixture.document, () => true);
      expect(
        await replacement.updateArticleFields({ author: "new" }, hash, execution),
      ).toMatchObject({ status: "error", error: { code: "executor_mismatch" } });
      expect(sets).toBe(1);
    } finally {
      release();
      crypto.subtle.digest = digest;
    }
  });
  test("B-F1 omission, explicit empty and no-op fields use native events only for actual changes", async () => {
    const fixture = fieldsDocument();
    const service = createArticleFieldsService(fixture.document, () => true);
    const events: string[] = [];
    let sets = 0;
    Object.defineProperty(fixture.defaultView.HTMLInputElement.prototype, "value", {
      configurable: true,
      set(value: string) {
        sets++;
        fixture.values.author = value;
      },
    });
    (
      fixture.controls['input#author[name="author"]']![0] as {
        dispatchEvent(event: Event): boolean;
      }
    ).dispatchEvent = (event) => {
      events.push(event.type);
      return true;
    };
    const hash = (
      await hashArticleFields({ title: "Title", author: "Author", summary: "" })
    ).unwrap();
    const same = await service.updateArticleFields(
      { author: "Author" },
      hash,
      await fieldsExecution(service),
    );
    expect(same).toMatchObject({
      status: "ok",
      value: {
        effect: {
          outcome: "confirmed",
          requested: ["author"],
          attempted: [],
          confirmed: [],
          unknown: [],
          fieldsHash: hash,
        },
      },
    });
    expect(sets).toBe(0);
    expect(events).toEqual([]);
    const cleared = await service.updateArticleFields(
      { author: "" },
      hash,
      await fieldsExecution(service),
    );
    expect(cleared).toMatchObject({
      status: "ok",
      value: { effect: { attempted: ["author"], confirmed: ["author"], unknown: [] } },
    });
    expect(sets).toBe(1);
    expect(events).toEqual(["input", "change"]);
    expect(fixture.values).toEqual({ author: "", summary: "" });
  });
  test("F3 fields failed digest cannot open the queue ahead of a held predecessor", async () => {
    const fixture = fieldsDocument();
    const service = createArticleFieldsService(fixture.document, () => true);
    const a = await fieldsExecution(service),
      b = await fieldsExecution(service),
      c = await fieldsExecution(service);
    const hash = (
      await hashArticleFields({ title: "Title", author: "Author", summary: "" })
    ).unwrap();
    const digest = crypto.subtle.digest;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let reached!: () => void;
    const entered = new Promise<void>((done) => {
      reached = done;
    });
    let calls = 0;
    crypto.subtle.digest = (async (...args: Parameters<typeof digest>) => {
      const call = ++calls;
      if (call === 1) {
        reached();
        await gate;
      }
      if (call === 2) throw new Error("digest failed");
      return digest.apply(crypto.subtle, args);
    }) as typeof digest;
    try {
      const first = service.updateArticleFields({ author: "first" }, hash, a);
      await entered;
      expect(await service.updateArticleFields({ author: "bad" }, hash, b)).toMatchObject({
        status: "error",
        error: { code: "hash_failed" },
      });
      let finished = false;
      const last = service.updateArticleFields({ author: "last" }, hash, c).then((value) => {
        finished = true;
        return value;
      });
      await new Promise((done) => setTimeout(done, 0));
      expect(finished).toBe(false);
      expect(fixture.values.author).toBe("Author");
      release();
      expect(await first).toMatchObject({
        status: "ok",
        value: { effect: { outcome: "confirmed" } },
      });
      expect(await last).toMatchObject({
        status: "ok",
        value: {
          effect: { attempted: [] },
          result: { status: "error", error: { code: "content_conflict" } },
        },
      });
      expect(fixture.values.author).toBe("first");
    } finally {
      release();
      crypto.subtle.digest = digest;
    }
  });
  test("B-F2 preserves the first guard failure and exact setter/input boundary without attempting summary", async () => {
    const fixture = fieldsDocument();
    let valid = true;
    const events: string[] = [];
    const author = fixture.controls['input#author[name="author"]']![0] as {
      dispatchEvent(event: Event): boolean;
    };
    author.dispatchEvent = (event) => {
      events.push(event.type);
      return true;
    };
    Object.defineProperty(fixture.defaultView.HTMLInputElement.prototype, "value", {
      set(value: string) {
        fixture.values.author = value;
        valid = false;
      },
      configurable: true,
    });
    const service = createArticleFieldsService(fixture.document, () => valid);
    const hash = (
      await hashArticleFields({ title: "Title", author: "Author", summary: "" })
    ).unwrap();
    const identity = await service.identity();
    if (identity.status !== "ok") throw new Error("identity unavailable");
    const result = await service.updateArticleFields({ author: "new", summary: "later" }, hash, {
      operationId: createOperationId(ledgerId),
      executorId: identity.value.executorId,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value).toMatchObject({
      effect: {
        requested: ["author", "summary"],
        attempted: ["author"],
        confirmed: [],
        unknown: ["author"],
      },
      ended: true,
      result: { status: "error", error: { code: "target_unavailable" } },
    });
    expect(fixture.values).toEqual({ author: "new", summary: "" });
    expect(events).toEqual([]);
  });
  test("reads article fields as an isolated read-only content service with target guards", async () => {
    const fixture = fieldsDocument();
    let valid = true;
    const service = createArticleFieldsService(fixture.document, () => valid);
    expect(await articleFieldsResultCodec.deserialize(await service.readArticleFields())).toEqual(
      Result.ok({ title: "Title", author: "Author", summary: "" }),
    );
    valid = false;
    expect(await articleFieldsResultCodec.deserialize(await service.readArticleFields())).toEqual(
      Result.err({ code: "route_changed" }),
    );
    expect(fixture.reads).toEqual({ title: 1, author: 1, summary: 1, body: 0, writes: 0 });
    expect(articleFieldsToken.id).toBe("mpctl.extension.article-fields.v1");
  });

  test("reports only a dispatched changed field when a post-write target check fails", async () => {
    const fixture = fieldsDocument();
    let targetChecks = 0;
    const service = createArticleFieldsService(fixture.document, () => ++targetChecks !== 13);
    const hash = await hashArticleFields({ title: "Title", author: "Author", summary: "" });
    expect(Result.isOk(hash)).toBe(true);
    if (Result.isError(hash)) return;
    const encoded = await service.updateArticleFields(
      { author: "Author", summary: "new summary" },
      hash.value,
      await fieldsExecution(service),
    );
    const result = await articleFieldUpdateResultCodec.deserialize(encoded);
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value).toMatchObject({
        effect: {
          requested: ["author", "summary"],
          attempted: ["summary"],
          confirmed: ["summary"],
          unknown: [],
        },
      });
    expect(fixture.values).toEqual({ author: "Author", summary: "new summary" });
  });

  test("does not report a no-op field as updated when final hashing fails", async () => {
    const fixture = fieldsDocument();
    const service = createArticleFieldsService(fixture.document, () => true);
    const originalDigest = crypto.subtle.digest;
    let digestCalls = 0;
    crypto.subtle.digest = ((...args: Parameters<typeof originalDigest>) => {
      if (++digestCalls === 3) return Promise.reject(new Error("final hash unavailable"));
      return originalDigest.apply(crypto.subtle, args);
    }) as typeof originalDigest;
    try {
      const hash = await hashArticleFields({ title: "Title", author: "Author", summary: "" });
      expect(Result.isOk(hash)).toBe(true);
      if (Result.isError(hash)) return;
      digestCalls = 0;
      const encoded = await service.updateArticleFields(
        { author: "Author", summary: "new summary" },
        hash.value,
        await fieldsExecution(service),
      );
      const result = await articleFieldUpdateResultCodec.deserialize(encoded);
      expect(result.isOk()).toBe(true);
      if (result.isOk())
        expect(result.value).toMatchObject({
          effect: {
            outcome: "partial",
            requested: ["author", "summary"],
            attempted: ["summary"],
            confirmed: ["summary"],
            unknown: [],
          },
          result: { status: "error", error: { code: "hash_failed" } },
        });
    } finally {
      crypto.subtle.digest = originalDigest;
    }
  });
  test("returns document timeout as Err and cleans login watcher and bridge without throwing", async () => {
    let watcherStopped = 0;
    let bridgeDisposed = 0;
    let prepared = 0;
    const startup = await runContentStartup({
      document: markerFreeDocument(),
      ctx: { onInvalidated() {} },
      route: { kind: "new" } as never,
      stopWatchingLogin: () => {
        watcherStopped++;
      },
      cleanupEditor: async () => {
        bridgeDisposed++;
        return Result.ok();
      },
      waitForDocument: async () => false,
      waitForDraftDecision: async () => "ready",
      prepareEditor: async () => {
        prepared++;
        return Result.ok();
      },
    });

    expect(startup).toEqual(Result.err({ code: "document_not_ready" }));
    expect([watcherStopped, bridgeDisposed, prepared]).toEqual([1, 1, 0]);
  });

  test("returns unsupported route and ambiguous draft readiness as Err without rejection", async () => {
    let watcherStopped = 0;
    const base = {
      document: markerFreeDocument(),
      ctx: { onInvalidated() {} },
      stopWatchingLogin: () => {
        watcherStopped++;
      },
      async cleanupEditor() {
        return Result.ok();
      },
      waitForDocument: async () => true,
      waitForDraftDecision: async () => "loading" as const,
      prepareEditor: async () => Result.ok(),
    };

    expect(await runContentStartup({ ...base, route: { kind: "unsupported" } as never })).toEqual(
      Result.err({ code: "route_unsupported" }),
    );
    expect(await runContentStartup({ ...base, route: { kind: "draft-list" } as never })).toEqual(
      Result.err({ code: "setup_failed" }),
    );
    expect(watcherStopped).toBe(2);
  });

  test("returns invalidation registration failure and cleans login watcher on each route", async () => {
    let watcherStopped = 0;
    const startup = await runContentStartup({
      document: markerFreeDocument(),
      ctx: {
        onInvalidated() {
          throw new Error("context invalidated");
        },
      },
      route: { kind: "home" } as never,
      stopWatchingLogin: () => {
        watcherStopped++;
      },
      waitForDocument: async () => true,
      waitForDraftDecision: async () => "ready",
      prepareEditor: async () => Result.ok(),
    });
    expect(startup).toEqual(Result.err({ code: "setup_failed" }));
    expect(watcherStopped).toBe(1);
  });

  test.each(["ready", "not_logged_in"] as const)(
    "draft startup keeps one watcher registration for %s without preparing an editor",
    async (decision) => {
      let stopped = 0;
      let prepared = 0;
      const registered: Array<() => void> = [];
      const result = await runContentStartup({
        document: markerFreeDocument(),
        route: { kind: "draft-list" } as never,
        ctx: { onInvalidated: (cleanup) => void registered.push(cleanup) },
        waitForDocument: async () => true,
        waitForDraftDecision: async () => decision,
        stopWatchingLogin: () => void stopped++,
        prepareEditor: async () => {
          prepared++;
          return Result.ok();
        },
      });
      expect(result).toEqual(Result.ok());
      expect([registered.length, stopped, prepared]).toEqual([1, 0, 0]);
      registered[0]!();
      await Promise.resolve();
      expect(stopped).toBe(1);
    },
  );

  test("cleans the editor bridge when expected editor setup returns Err", async () => {
    let watcherStopped = 0;
    let bridgeDisposed = 0;
    let invalidated!: () => void;
    const startup = await runContentStartup({
      document: markerFreeDocument(),
      ctx: {
        onInvalidated(callback) {
          invalidated = callback;
        },
      },
      route: { kind: "saved-editor" } as never,
      stopWatchingLogin: () => {
        watcherStopped++;
      },
      cleanupEditor: async () => {
        bridgeDisposed++;
        return Result.ok();
      },
      waitForDocument: async () => true,
      waitForDraftDecision: async () => "ready",
      prepareEditor: async () => Result.err({ code: "page_failed" }),
    });

    expect(startup).toEqual(Result.err({ code: "setup_failed" }));
    expect([watcherStopped, bridgeDisposed]).toEqual([0, 1]);
    invalidated();
    await Promise.resolve();
    expect(watcherStopped).toBe(1);
  });

  test("awaits bridge cleanup Err and still stops login observation", async () => {
    let watcherStopped = 0;
    let cleanupCount = 0;
    const registered: Array<() => void> = [];
    const startup = await runContentStartup({
      document: markerFreeDocument(),
      ctx: {
        onInvalidated(callback) {
          registered.push(callback);
        },
      },
      route: { kind: "saved-editor" } as never,
      stopWatchingLogin: () => {
        watcherStopped++;
      },
      cleanupEditor: async () => {
        cleanupCount++;
        return Result.err({ code: "cleanup_failed", cause: "disposal_failed" });
      },
      waitForDocument: async () => true,
      waitForDraftDecision: async () => "ready",
      prepareEditor: async () => Result.ok(),
    });
    expect(startup).toEqual(Result.ok());
    registered[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect([watcherStopped, cleanupCount]).toEqual([1, 1]);
  });

  test("rejects draft list reads after the same document drifts to another route or page", async () => {
    for (const nextUrl of [
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=group",
      "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=10&count=10",
      "https://mp.weixin.qq.com/cgi-bin/appmsg?action=unknown&type=77",
    ]) {
      let href =
        "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10";
      let cardReads = 0;
      const fixtureDocument = {
        location: {
          get href() {
            return href;
          },
        },
        querySelectorAll() {
          cardReads++;
          return [draftCard("group")];
        },
      } as unknown as Document;
      const service = createDraftPageService(fixtureDocument);
      href = nextUrl;

      expect(await listDraftsResultCodec.deserialize(await service.listDrafts())).toEqual(
        Result.err({ code: "route_changed" }),
      );
      expect(cardReads).toBe(0);
    }
  });

  test("allows accepted context-only list URL changes and keeps saved-draft validation", async () => {
    let href = "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10";
    const fixtureDocument = {
      location: {
        get href() {
          return href;
        },
      },
      body: { classList: [] },
      querySelector: () => null,
      querySelectorAll(selector: string) {
        if (selector === ".weui-desktop-card[data-appid]") return [draftCard("group")];
        if (selector === ".js_appmsg_item") return [documentItem("0", true, true)];
        return [];
      },
    } as unknown as Document;
    const service = createDraftPageService(fixtureDocument);
    href += "&lang=en_US&token=synthetic-context-token";
    expect(await listDraftsResultCodec.deserialize(await service.listDrafts())).toEqual(
      Result.ok([{ candidate: "group", title: "title" }]),
    );

    href =
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=group";
    expect(
      await validateDraftResultCodec.deserialize(await service.validateDraft("group")),
    ).toEqual(Result.ok({ valid: true, title: "" }));
    expect(await currentItemCountResultCodec.deserialize(await service.currentItemCount())).toEqual(
      Result.ok(1),
    );
  });

  test("counts every visible appmsg item through the draft page service", async () => {
    const current = documentItem("0", true, true);
    const nonCurrent = documentItem("1", true, false);
    const hidden = documentItem("2", false, false);
    const fixtureDocument = {
      location: {
        href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=group",
      },
      querySelectorAll(selector: string) {
        return selector === ".js_appmsg_item" ? [current, nonCurrent, hidden] : [];
      },
    } as unknown as Document;
    expect(
      await currentItemCountResultCodec.deserialize(
        await createDraftPageService(fixtureDocument).currentItemCount(),
      ),
    ).toEqual(Result.ok(2));
    expect(
      await validateDraftResultCodec.deserialize(
        await createDraftPageService(fixtureDocument).validateDraft("group"),
      ),
    ).toEqual(
      Result.ok({
        valid: false,
        title: "",
      }),
    );
  });

  test("opens only uniquely visible observed native home controls", async () => {
    let draftClicks = 0;
    let articleClicks = 0;
    const visibleDraftLink = (click: () => void) =>
      ({
        textContent: "草稿箱",
        classList: {
          contains: (name: string) => name === "weui-desktop-menu__link" || name === "menu_report",
        },
        href: "https://mp.weixin.qq.com/cgi-bin/appmsg?begin=synthetic&count=synthetic&type=synthetic&action=synthetic&token=synthetic&lang=synthetic",
        hidden: false,
        getAttribute: () => null,
        getClientRects: () => [1],
        ownerDocument: {
          defaultView: {
            getComputedStyle: () => ({ display: "block", visibility: "visible" }),
          },
        },
        click,
      }) as unknown as HTMLElement;
    const visibleArticleItem = (click: () => void) =>
      ({
        tagName: "DIV",
        textContent: "文章",
        classList: { contains: (name: string) => name === "new-creation__menu-item" },
        hidden: false,
        getAttribute: () => null,
        getClientRects: () => [1],
        ownerDocument: {
          defaultView: {
            getComputedStyle: () => ({ display: "block", visibility: "visible" }),
          },
        },
        click,
      }) as unknown as HTMLElement;
    const fixtureDocument = {
      location: {
        href: "https://mp.weixin.qq.com/cgi-bin/home?t=synthetic&lang=synthetic&token=synthetic",
      },
      querySelectorAll(selector: string) {
        if (selector === "a.weui-desktop-menu__link.menu_report")
          return [visibleDraftLink(() => draftClicks++)];
        if (selector === "div.new-creation__menu-item")
          return [visibleArticleItem(() => articleClicks++)];
        return [];
      },
    };
    const home = createHomePageService(fixtureDocument as unknown as Document);

    expect(await homeIsReadyResultCodec.deserialize(await home.isReady())).toEqual(Result.ok(true));
    expect(await openDraftListResultCodec.deserialize(await home.openDraftList())).toEqual(
      Result.ok(
        "https://mp.weixin.qq.com/cgi-bin/appmsg?begin=synthetic&count=synthetic&type=synthetic&action=synthetic&token=synthetic&lang=synthetic",
      ),
    );
    expect([draftClicks, articleClicks]).toEqual([0, 0]);

    fixtureDocument.querySelectorAll = (selector: string) =>
      selector === "a.weui-desktop-menu__link.menu_report"
        ? [visibleDraftLink(() => draftClicks++), visibleDraftLink(() => draftClicks++)]
        : [];
    expect(await openDraftListResultCodec.deserialize(await home.openDraftList())).toEqual(
      Result.err({ code: "control_unavailable" }),
    );
    expect(await homeIsReadyResultCodec.deserialize(await home.isReady())).toEqual(
      Result.ok(false),
    );
    expect(draftClicks).toBe(0);
  });

  test("unsupported Article control is never clicked or allowed to replace window.open", async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    let clicks = 0;
    let opens = 0;
    const pageWindow = {
      open: () => {
        opens++;
        return null;
      },
    };
    const originalOpen = pageWindow.open;
    const control = {
      textContent: "文章",
      hidden: false,
      classList: { contains: (name: string) => name === "new-creation__menu-item" },
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      },
      getClientRects: () => [1],
      click() {
        clicks++;
        pageWindow.open();
      },
    };
    Object.assign(globalThis, {
      window: pageWindow,
      document: {
        location: {
          href: "https://mp.weixin.qq.com/cgi-bin/home?t=home&lang=en_US&token=synthetic",
        },
        querySelectorAll: () => [control],
      },
    });
    try {
      expect(await captureNativeNewEditorUrl()).toEqual({
        kind: "control_unavailable",
        ended: true,
      });
      expect(clicks).toBe(0);
      expect(opens).toBe(0);
      expect(pageWindow.open).toBe(originalOpen);
    } finally {
      Object.assign(globalThis, { window: originalWindow, document: originalDocument });
    }
  });

  test("does not expose MAIN or background editor readiness on a login-timeout page", async () => {
    let connects = 0;
    const result = await initializeContentServices({
      document: markerFreeDocument(),
      pageRuntime: { connect: async () => (connects++, {}) } as never,
      chromeRuntime: {} as never,
      pageState: async () => ({
        state: "not_logged_in",
        route: "saved-route",
        documentReady: true,
      }),
      validateTarget: () => true,
    });
    expect(result).toEqual(Result.err({ code: "not_logged_in" }));
    expect(connects).toBe(0);
  });

  test("fails closed for an unsupported editor version over a real page endpoint", async () => {
    const target = new EventTarget();
    const eventNames = { fromIsolated: "test:isolated:legacy", fromMain: "test:main:legacy" };
    const isolated = createPageEndpoint({
      target,
      channelId: "legacy",
      side: "isolated",
      eventNames,
    });
    const main = createPageEndpoint({ target, channelId: "legacy", side: "main", eventNames });
    const mainRuntime = new Nexus()
      .provide(token, {
        ready: async () =>
          wire(
            pageEditorReadyResultCodec.serialize(
              Result.ok({ isReady: true as const, isNew: false as const, executorId }),
            ),
          ),
        getContent: async () =>
          wire(pageEditorContentResultCodec.serialize(Result.ok("must not read"))),
        setContent: async () => {
          throw new Error("must not write");
        },
        getReceipt: async () => ({ status: "ok" as const, value: null }),
        setCoverFromBody: async () => ({
          status: "error" as const,
          error: { code: "unsupported" as const },
        }),
        getCoverReceipt: async () => ({ status: "ok" as const, value: null }),
      } as never)
      .configure({ endpoint: { implementation: main, meta: { app: { protocolVersion } } } });
    const pageRuntime = new Nexus().configure({
      endpoint: { implementation: isolated, meta: { app: { protocolVersion } } },
    });
    await Promise.all([mainRuntime.ready(), pageRuntime.ready()]);
    try {
      const result = await initializeContentServices(
        {
          document: markerFreeDocument(),
          pageRuntime,
          chromeRuntime: {} as never,
          validateTarget: () => true,
          pageState: async () => ({ state: "ready", route: "saved", documentReady: true }),
        },
        token,
      );
      expect(result).toEqual(Result.err({ code: "unsupported_editor" }));
    } finally {
      await Promise.all([isolated.close?.(), main.close?.()]);
    }
  });

  test("disconnects the acquired page connection when invalidation disposer registration throws", async () => {
    let disconnected = 0;
    let registrations = 0;
    const target = new EventTarget();
    const eventNames = {
      fromIsolated: "test:isolated:dispose-fail",
      fromMain: "test:main:dispose-fail",
    };
    const isolated = createPageEndpoint({
      target,
      channelId: "dispose-fail",
      side: "isolated",
      eventNames,
    });
    const mainEndpoint = createPageEndpoint({
      target,
      channelId: "dispose-fail",
      side: "main",
      eventNames,
    });
    const main = new Nexus()
      .provide(token, {
        ready: async () =>
          wire(
            pageEditorReadyResultCodec.serialize(
              Result.ok({ isReady: true as const, isNew: true, executorId }),
            ),
          ),
        getContent: async () => wire(pageEditorContentResultCodec.serialize(Result.ok("body"))),
        setContent: async (html, hash, execution) =>
          wire(
            pageEditorWriteResultCodec.serialize(
              Result.ok(await bodyReceipt(html, hash, execution)),
            ),
          ),
        getReceipt: async () => ({ status: "ok" as const, value: null }),
        setCoverFromBody: async () => ({
          status: "error" as const,
          error: { code: "unsupported" as const },
        }),
        getCoverReceipt: async () => ({ status: "ok" as const, value: null }),
      })
      .configure({
        endpoint: { implementation: mainEndpoint, meta: { app: { protocolVersion } } },
      });
    const page = new Nexus().configure({
      endpoint: { implementation: isolated, meta: { app: { protocolVersion } } },
    });
    const chrome = localNexusPeer("dispose-fail-chrome");
    await Promise.all([main.ready(), page.ready(), chrome.server.ready(), chrome.client.ready()]);
    const connection = await page.connect({ target: {} });
    const prototype = Object.getPrototypeOf(connection);
    const originalDisconnect = prototype.disconnect;
    const disconnect = spyOn(prototype, "disconnect").mockImplementation(
      function (this: import("@nexus-js/core").Connection) {
        disconnected++;
        originalDisconnect.call(this);
      },
    );
    try {
      const result = await initializeContentServices({
        document: markerFreeDocument(),
        pageRuntime: page,
        chromeRuntime: chrome.server as never,
        validateTarget: () => true,
        pageState: async () => ({ state: "ready" as const, route: "fixture", documentReady: true }),
        onDispose() {
          registrations++;
          throw new Error("WXT invalidation registration failed");
        },
      });
      expect(Result.isError(result)).toBe(true);
      expect(registrations).toBe(1);
      expect(disconnected).toBe(1);
      expect((await chrome.client.connect({ target: {} })).safeGet(token).isErr()).toBe(true);
    } finally {
      disconnect.mockRestore();
      await Promise.all([isolated.close?.(), mainEndpoint.close?.(), chrome.close()]);
    }
  });

  test("disconnects acquired page connection when Relay creation fails", async () => {
    let disconnected = 0;
    const peer = localNexusPeer("relay-creation-failure");
    peer.server.provide(token, {
      ready: async () =>
        wire(
          pageEditorReadyResultCodec.serialize(
            Result.ok({ isReady: true as const, isNew: true, executorId }),
          ),
        ),
      getContent: async () => wire(pageEditorContentResultCodec.serialize(Result.ok("body"))),
      setContent: async (html, hash, execution) =>
        wire(
          pageEditorWriteResultCodec.serialize(Result.ok(await bodyReceipt(html, hash, execution))),
        ),
      getReceipt: async () => ({ status: "ok" as const, value: null }),
      setCoverFromBody: async () => ({
        status: "error" as const,
        error: { code: "unsupported" as const },
      }),
      getCoverReceipt: async () => ({ status: "ok" as const, value: null }),
    });
    await Promise.all([peer.server.ready(), peer.client.ready()]);
    const connection = await peer.client.connect({ target: {} });
    connection.disconnect = () => {
      disconnected++;
      throw new Error("page disconnect failed");
    };
    spyOn(peer.client, "connect").mockResolvedValue(connection);
    const result = await initializeContentServices({
      document: markerFreeDocument(),
      pageRuntime: peer.client,
      chromeRuntime: {} as never,
      validateTarget: () => true,
      pageState: async () => ({ state: "ready" as const, route: "fixture", documentReady: true }),
    });
    expect(result).toEqual(Result.err({ code: "page_failed" }));
    expect(disconnected).toBe(1);
    await peer.close();
  });

  test("reports page disconnect cleanup Err while preserving Relay creation Err", async () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args[1]);
    let disconnected = 0;
    const peer = localNexusPeer("relay-creation-cleanup-failure");
    peer.server.provide(token, {
      ready: async () =>
        wire(
          pageEditorReadyResultCodec.serialize(
            Result.ok({ isReady: true as const, isNew: true, executorId }),
          ),
        ),
      getContent: async () => wire(pageEditorContentResultCodec.serialize(Result.ok("body"))),
      setContent: async (html, hash, execution) =>
        wire(
          pageEditorWriteResultCodec.serialize(Result.ok(await bodyReceipt(html, hash, execution))),
        ),
      getReceipt: async () => ({ status: "ok" as const, value: null }),
      setCoverFromBody: async () => ({
        status: "error" as const,
        error: { code: "unsupported" as const },
      }),
      getCoverReceipt: async () => ({ status: "ok" as const, value: null }),
    });
    await Promise.all([peer.server.ready(), peer.client.ready()]);
    const connection = await peer.client.connect({ target: {} });
    connection.disconnect = () => {
      disconnected++;
      throw new Error("disconnect failed");
    };
    spyOn(peer.client, "connect").mockResolvedValue(connection);
    try {
      const result = await initializeContentServices({
        document: markerFreeDocument(),
        pageRuntime: peer.client,
        chromeRuntime: {} as never,
        validateTarget: () => true,
        pageState: async () => ({ state: "ready" as const, route: "fixture", documentReady: true }),
      });
      expect(result).toEqual(Result.err({ code: "page_failed" }));
      expect(disconnected).toBe(1);
      expect(errors).toEqual([{ code: "page_failed" }]);
    } finally {
      console.error = originalError;
      await peer.close();
    }
  });

  test("does not publish a page or background service when MAIN handshake fails", async () => {
    const pageRuntime = {
      connect: async () => {
        throw new Error("MAIN handshake failed");
      },
    };
    const chrome = localNexusPeer("handshake-failure");
    const result = await initializeContentServices(
      {
        document: markerFreeDocument(),
        pageRuntime: pageRuntime as never,
        chromeRuntime: chrome.server as never,
        validateTarget: () => true,
        pageState: async () => ({
          state: "ready" as const,
          route: "fixture",
          documentReady: true,
        }),
      },
      token,
    );
    expect(result).toEqual(Result.err({ code: "page_failed" }));
    const clientConnection = await chrome.client.connect({ target: {} });
    let editorReady = false;
    clientConnection.subscribeIdentity((meta) => {
      editorReady = (meta as { app?: { editorReady?: boolean } }).app?.editorReady === true;
    });
    expect(editorReady).toBe(false);
    await chrome.close();
  });

  test("fails closed and disconnects when MAIN has no JSAPI", async () => {
    let disconnected = false;
    const chrome = localNexusPeer("missing-jsapi");
    const peer = localNexusPeer("missing-jsapi-main");
    peer.server.provide(token, {
      ready: async () =>
        wire(pageEditorReadyResultCodec.serialize(Result.err({ code: "jsapi_unavailable" }))),
      getContent: async () => {
        throw new Error("must not read");
      },
      setContent: async () => {
        throw new Error("must not write");
      },
      getReceipt: async () => ({ status: "ok" as const, value: null }),
      setCoverFromBody: async () => ({
        status: "error" as const,
        error: { code: "unsupported" as const },
      }),
      getCoverReceipt: async () => ({ status: "ok" as const, value: null }),
    });
    await Promise.all([peer.server.ready(), peer.client.ready()]);
    const connection = await peer.client.connect({ target: {} });
    connection.onDisconnected(() => {
      disconnected = true;
    });
    spyOn(peer.client, "connect").mockResolvedValue(connection);

    const result = await initializeContentServices(
      {
        document: markerFreeDocument(),
        pageRuntime: peer.client,
        chromeRuntime: chrome.server as never,
        validateTarget: () => true,
        pageState: async () => ({ state: "ready" as const, route: "fixture", documentReady: true }),
      },
      token,
    );

    expect(result).toEqual(Result.err({ code: "jsapi_unavailable" }));
    expect(disconnected).toBe(true);
    const clientConnection = await chrome.client.connect({ target: {} });
    let editorReady = false;
    clientConnection.subscribeIdentity((meta) => {
      editorReady = (meta as { app?: { editorReady?: boolean } }).app?.editorReady === true;
    });
    expect(editorReady).toBe(false);
    await chrome.close();
    await peer.close();
  });

  test("allows editor service calls after trusted user interaction", async () => {
    const target = new EventTarget();
    const eventNames = { fromIsolated: "test:isolated:guard", fromMain: "test:main:guard" };
    const isolated = createPageEndpoint({
      target,
      channelId: "guard",
      side: "isolated",
      eventNames,
    });
    const main = createPageEndpoint({ target, channelId: "guard", side: "main", eventNames });
    let mainWrites = 0;
    const mainRuntime = new Nexus()
      .provide(token, {
        ready: async () =>
          wire(
            pageEditorReadyResultCodec.serialize(
              Result.ok({ isReady: true as const, isNew: true as const, executorId }),
            ),
          ),
        getContent: async () => wire(pageEditorContentResultCodec.serialize(Result.ok(""))),
        setContent: async (html, hash, execution) => {
          mainWrites++;
          return wire(
            pageEditorWriteResultCodec.serialize(
              Result.ok(await bodyReceipt(html, hash, execution)),
            ),
          );
        },
        getReceipt: async () => ({ status: "ok" as const, value: null }),
        setCoverFromBody: async () => ({
          status: "error" as const,
          error: { code: "unsupported" as const },
        }),
        getCoverReceipt: async () => ({ status: "ok" as const, value: null }),
      })
      .configure({ endpoint: { implementation: main, meta: { app: { protocolVersion } } } });
    const pageRuntime = new Nexus().configure({
      endpoint: { implementation: isolated, meta: { app: { protocolVersion } } },
    });
    await Promise.all([mainRuntime.ready(), pageRuntime.ready()]);
    const chrome = localNexusPeer("trusted");
    await initializeContentServices(
      {
        document: markerFreeDocument(),
        pageRuntime,
        chromeRuntime: chrome.server as never,
        validateTarget: () => true,
        pageState: async () => ({ state: "ready" as const, route: "fixture", documentReady: true }),
      },
      token,
    );
    const writesBeforeCall = mainWrites;
    const remote = await chrome.client.connect({ target: {} });
    const service = await remote.get(token);
    await service.setContent("<p>offline file edit</p>", await hashForTest(""), {
      operationId: createOperationId(ledgerId),
      executorId,
    });
    expect(mainWrites).toBeGreaterThan(writesBeforeCall);
    await Promise.all([isolated.close?.(), main.close?.(), chrome.close()]);
  });

  test("rechecks complete login-timeout markers before forwarding body calls to MAIN", async () => {
    const target = new EventTarget();
    const eventNames = { fromIsolated: "test:isolated:timeout", fromMain: "test:main:timeout" };
    const isolated = createPageEndpoint({
      target,
      channelId: "timeout",
      side: "isolated",
      eventNames,
    });
    const main = createPageEndpoint({ target, channelId: "timeout", side: "main", eventNames });
    let mainReads = 0;
    let mainWrites = 0;
    const mainRuntime = new Nexus()
      .provide(token, {
        ready: async () =>
          wire(
            pageEditorReadyResultCodec.serialize(
              Result.ok({ isReady: true as const, isNew: true as const, executorId }),
            ),
          ),
        getContent: async () => {
          mainReads++;
          return wire(pageEditorContentResultCodec.serialize(Result.ok("MAIN body")));
        },
        setContent: async (html, hash, execution) => {
          mainWrites++;
          return wire(
            pageEditorWriteResultCodec.serialize(
              Result.ok(await bodyReceipt(html, hash, execution)),
            ),
          );
        },
        getReceipt: async () => ({ status: "ok" as const, value: null }),
        setCoverFromBody: async () => ({
          status: "error" as const,
          error: { code: "unsupported" as const },
        }),
        getCoverReceipt: async () => ({ status: "ok" as const, value: null }),
      })
      .configure({ endpoint: { implementation: main, meta: { app: { protocolVersion } } } });
    const pageRuntime = new Nexus().configure({
      endpoint: { implementation: isolated, meta: { app: { protocolVersion } } },
    });
    await Promise.all([mainRuntime.ready(), pageRuntime.ready()]);

    let markers: { bodyClasses: string[]; infoText: string; jumpUrl: string } = {
      bodyClasses: [],
      infoText: "",
      jumpUrl: "",
    };
    const document = {
      body: {
        get classList() {
          return markers.bodyClasses;
        },
      },
      querySelector(selector: string) {
        if (selector === "#info") return { textContent: markers.infoText };
        if (selector === "#jumpUrl") return { href: markers.jumpUrl };
        return null;
      },
    } as unknown as Document;
    const chrome = localNexusPeer(
      "login-timeout",
      () => detectLoginTimeout(document).state !== "not_logged_in",
    );

    await initializeContentServices(
      {
        document,
        pageRuntime,
        chromeRuntime: chrome.server as never,
        validateTarget: () => true,
        pageState: async () => ({ state: "ready" as const, route: "fixture", documentReady: true }),
      },
      token,
    );
    const readsAtInitialization = mainReads;
    const writesAtInitialization = mainWrites;

    const remote = await chrome.client.connect({ target: {} });
    const service = await remote.get(token);
    expect(await pageEditorContentResultCodec.deserialize(await service.getContent())).toEqual(
      Result.ok("MAIN body"),
    );
    await service.setContent("stable body", await hashForTest("MAIN body"), {
      operationId: createOperationId(ledgerId),
      executorId,
    });
    expect(mainReads).toBeGreaterThan(readsAtInitialization);
    expect(mainWrites).toBeGreaterThan(writesAtInitialization);

    for (const incompleteMarkers of [
      {
        bodyClasses: ["page_error", "page_timeout"],
        infoText: "登录超时",
        jumpUrl: "https://mp.weixin.qq.com/cgi-bin/other",
      },
      {
        bodyClasses: ["page_error"],
        infoText: "登录超时",
        jumpUrl: "https://mp.weixin.qq.com/cgi-bin/loginpage",
      },
      {
        bodyClasses: ["page_error", "page_timeout"],
        infoText: "",
        jumpUrl: "https://mp.weixin.qq.com/cgi-bin/loginpage",
      },
    ]) {
      markers = incompleteMarkers;
      expect(await pageEditorContentResultCodec.deserialize(await service.getContent())).toEqual(
        Result.ok("MAIN body"),
      );
      await service.setContent("partial markers do not block", await hashForTest("MAIN body"), {
        operationId: createOperationId(ledgerId),
        executorId,
      });
    }
    expect(mainReads).toBeGreaterThan(readsAtInitialization);
    expect(mainWrites).toBeGreaterThan(writesAtInitialization);
    const forwardedReads = mainReads;
    const forwardedWrites = mainWrites;

    // Change the same document synchronously; no MutationObserver callback or status query runs.
    markers = {
      bodyClasses: ["page_error", "page_timeout"],
      infoText: "登录超时",
      jumpUrl: "https://mp.weixin.qq.com/cgi-bin/loginpage",
    };
    const blockedCalls = await Promise.allSettled([
      service.getContent(),
      service.setContent("must not reach MAIN", await hashForTest("MAIN body"), {
        operationId: createOperationId(ledgerId),
        executorId,
      }),
    ]);
    expect(blockedCalls.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect([mainReads, mainWrites]).toEqual([forwardedReads, forwardedWrites]);

    await Promise.all([isolated.close?.(), main.close?.(), chrome.close()]);
  });
});

function documentItem(index: string, visible: boolean, current: boolean): HTMLElement {
  return {
    hidden: !visible,
    classList: { contains: (name: string) => name === "current" && current },
    getAttribute(name: string) {
      return name === "data-msgindex" ? index : null;
    },
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({ display: visible ? "block" : "none", visibility: "visible" }),
      },
    },
    getClientRects: () => (visible ? [1] : []),
  } as unknown as HTMLElement;
}

function markerFreeDocument(): Document {
  return {
    body: { classList: [] },
    querySelector: () => null,
  } as unknown as Document;
}

function localNexusPeer(channelId: string, allowsCalls: () => boolean = () => true) {
  const target = new EventTarget();
  const eventNames = {
    fromIsolated: `${channelId}:isolated`,
    fromMain: `${channelId}:main`,
  };
  const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
  const serverEndpoint = createPageEndpoint({ target, channelId, side: "main", eventNames });
  const client = new Nexus().configure({
    endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
  });
  const server = new Nexus().configure({
    endpoint: {
      implementation: serverEndpoint,
      meta: { app: { protocolVersion, editorReady: false } },
    },
    policy: { canCall: () => allowsCalls() },
  });
  return {
    client,
    server,
    async close() {
      await Promise.all([clientEndpoint.close?.(), serverEndpoint.close?.()]);
    },
  };
}

function draftCard(groupId: string): Element {
  return {
    getAttribute: (name: string) => (name === "data-appid" ? groupId : null),
    querySelector: (selector: string) =>
      selector === ".weui-desktop-publish__cover__title" ? { textContent: "title" } : null,
  } as unknown as Element;
}
