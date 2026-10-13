import { describe, expect, test, spyOn } from "bun:test";
import { Nexus } from "@nexus-js/core";
import { protocolVersion } from "@mpctl/contracts";
import { Result } from "better-result";
import {
  awaitMainWorldReady,
  disposeMainWorldEndpoint,
  mountMainWorldBridge,
} from "../entrypoints/mp-main-world";
import { createPageEndpoint } from "../src/transport/page-bridge";
import {
  pageEditorReadyResultCodec,
  pageEditorContentResultCodec,
  pageEditorWriteResultCodec,
  pageEditorToken,
} from "../src/page-contracts";

describe("MAIN-world bridge startup", () => {
  test.each(["mounted", "peer"] as const)(
    "F2/V2 %s disposal during preflight stops the old native task before set",
    async (disposal) => {
      const target = new EventTarget();
      const channelId = crypto.randomUUID();
      const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
      const script = {
        dataset: {
          mpctlChannel: channelId,
          mpctlInbound: eventNames.fromIsolated,
          mpctlOutbound: eventNames.fromMain,
        },
      } as unknown as HTMLScriptElement;
      const previousDocument = globalThis.document;
      const previousWindow = globalThis.window;
      let reached!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const counts = { read: 0, set: 0 };
      let signalStopped!: () => void;
      const stopped = new Promise<void>((resolve) => {
        signalStopped = resolve;
      });
      const serialize = pageEditorWriteResultCodec.serialize;
      const observation = spyOn(pageEditorWriteResultCodec, "serialize").mockImplementation(
        async (result) => {
          if (result.isOk() && result.value.ended) signalStopped();
          return serialize(result);
        },
      );
      Object.assign(globalThis, {
        document: {
          location: {
            href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&isNew=1",
          },
          querySelectorAll: () => [],
          querySelector: () => null,
          body: { classList: [] },
        },
        window: {
          __MP_Editor_JSAPI__: {
            invoke(request: { apiName: string; sucCb(value: unknown): void }) {
              if (request.apiName === "mp_editor_get_isready")
                request.sucCb({ isReady: true, isNew: true });
              else if (request.apiName === "mp_editor_get_content") {
                counts.read++;
                release = () => request.sucCb({ content: "before" });
                reached();
              } else {
                counts.set++;
                request.sucCb({});
              }
            },
          },
        },
      });
      const endpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
      const client = new Nexus().configure({
        endpoint: { implementation: endpoint, meta: { app: { protocolVersion } } },
      });
      let mounted: Awaited<ReturnType<typeof mountMainWorldBridge>> | undefined;
      try {
        mounted = await mountMainWorldBridge(script, target);
        await client.ready();
        const remote = (await client.connect({ target: {} })).get(pageEditorToken);
        const ready = (await pageEditorReadyResultCodec.deserialize(await remote.ready())).unwrap();
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("before"));
        const expectedHash = [...new Uint8Array(hash)]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
        const execution = {
          operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
          executorId: ready.executorId,
        };
        const pending = Nexus.safeCall(remote.setContent("next", expectedHash, execution));
        await entered;
        if (disposal === "mounted") await mounted.unwrap().dispose();
        else endpoint.close();
        release();
        expect((await pending).isErr()).toBe(true);
        await stopped;
        expect(counts).toEqual({ read: 1, set: 0 });
      } finally {
        observation.mockRestore();
        await mounted?.unwrap().dispose();
        endpoint.close();
        Object.assign(globalThis, { document: previousDocument, window: previousWindow });
      }
    },
  );
  test.each([undefined, "", "0.9.0", protocolVersion])(
    "W2 mounted MAIN refuses isolated version %s before native ready/read/set",
    async (version) => {
      const target = new EventTarget();
      const channelId = crypto.randomUUID();
      const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
      const script = {
        dataset: {
          mpctlChannel: channelId,
          mpctlInbound: eventNames.fromIsolated,
          mpctlOutbound: eventNames.fromMain,
        },
      } as unknown as HTMLScriptElement;
      const previousDocument = globalThis.document;
      const previousWindow = globalThis.window;
      const counters = { ready: 0, read: 0, set: 0 };
      let html = "initial";
      Object.assign(globalThis, {
        document: {
          location: {
            href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&isNew=1",
          },
          querySelectorAll: () => [],
          querySelector: () => null,
          body: { classList: [] },
        },
        window: {
          __MP_Editor_JSAPI__: {
            invoke(request: {
              apiName: string;
              apiParam: { content?: string };
              sucCb(value: unknown): void;
            }) {
              if (request.apiName === "mp_editor_get_isready") {
                counters.ready++;
                request.sucCb({ isReady: true, isNew: true });
              } else if (request.apiName === "mp_editor_get_content") {
                counters.read++;
                request.sucCb({ content: html });
              } else {
                counters.set++;
                html = request.apiParam.content ?? "";
                request.sucCb({});
              }
            },
          },
        },
      });
      const endpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
      const client = new Nexus().configure({
        endpoint: {
          implementation: endpoint,
          meta: version === undefined ? {} : { app: { protocolVersion: version } },
        },
      });
      let mounted: Awaited<ReturnType<typeof mountMainWorldBridge>> | undefined;
      try {
        mounted = await mountMainWorldBridge(script, target);
        expect(mounted.isOk()).toBe(true);
        await client.ready();
        const connected = await client.safeConnect({ target: {}, timeout: 500 });
        if (version !== protocolVersion) {
          expect(connected.isErr()).toBe(true);
          expect(counters).toEqual({ ready: 0, read: 0, set: 0 });
          return;
        }
        if (connected.isErr()) throw connected.error;
        const editor = connected.value.safeGet(pageEditorToken).unwrap();
        const ready = await pageEditorReadyResultCodec.deserialize(
          (await Nexus.safeCall(editor.ready())).unwrap(),
        );
        expect(ready.unwrap()).toMatchObject({ isReady: true, isNew: true });
        const execution = {
          operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
          executorId: ready.unwrap().executorId,
        };
        expect(
          await pageEditorContentResultCodec.deserialize(
            (await Nexus.safeCall(editor.getContent())).unwrap(),
          ),
        ).toEqual(Result.ok("initial"));
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("initial"));
        const expectedHash = [...new Uint8Array(digest)]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
        expect(
          (
            await pageEditorWriteResultCodec.deserialize(
              (await Nexus.safeCall(editor.setContent("next", expectedHash, execution))).unwrap(),
            )
          ).isOk(),
        ).toBe(true);
        expect(counters.set).toBe(1);
        await client.updateIdentity({ app: { protocolVersion: "0.9.0" } });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const observed = { ...counters };
        expect((await Nexus.safeCall(editor.ready())).isErr()).toBe(true);
        expect((await Nexus.safeCall(editor.getContent())).isErr()).toBe(true);
        expect(
          (await Nexus.safeCall(editor.setContent("forbidden", expectedHash, execution))).isErr(),
        ).toBe(true);
        expect(counters).toEqual(observed);
      } finally {
        if (mounted?.isOk()) await mounted.value.dispose();
        endpoint.close();
        Object.assign(globalThis, { document: previousDocument, window: previousWindow });
      }
    },
  );
  test("returns a typed startup Err and closes the endpoint when Nexus ready rejects", async () => {
    const dispatched: string[] = [];
    const result = await awaitMainWorldReady(Promise.reject(new Error("Nexus ready failed")), () =>
      dispatched.push("endpoint-closed"),
    );
    expect(Result.isError(result) && result.error).toEqual({ code: "main_startup_failed" });
    expect(dispatched).toContain("endpoint-closed");
  });

  test("returns cleanup Err when closing after a rejected ready operation also fails", async () => {
    const result = await awaitMainWorldReady(
      Promise.reject(new Error("Nexus ready failed")),
      () => {
        throw new Error("endpoint close failed");
      },
    );

    expect(Result.isError(result) && result.error).toEqual({
      code: "main_startup_failed",
      cleanupFailed: true,
    });
  });

  test("returns cleanup Err from the mounted bridge dispose operation", async () => {
    const target = new EventTarget();
    const remove = target.removeEventListener.bind(target);
    target.removeEventListener = (type, listener, options) => {
      if (type === "dispose-fails:isolated:connect") throw new Error("endpoint close failed");
      return remove(type, listener, options);
    };
    const originalDocument = globalThis.document;
    Object.assign(globalThis, {
      document: {
        location: {
          href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&isNew=1",
        },
        querySelectorAll: () => [],
        querySelector: () => null,
        body: { classList: [] },
      },
    });
    const script = {
      dataset: {
        mpctlChannel: "dispose-fails",
        mpctlInbound: "dispose-fails:isolated",
        mpctlOutbound: "dispose-fails:main",
      },
    } as unknown as HTMLScriptElement;
    try {
      const mounted = await mountMainWorldBridge(script, target);
      expect(Result.isOk(mounted)).toBe(true);
      if (Result.isOk(mounted)) {
        const disposed = await mounted.value.dispose();
        expect(disposed).toEqual(Result.err({ code: "main_cleanup_failed" }));
      }
    } finally {
      Object.assign(globalThis, { document: originalDocument });
    }
  });

  test("adapts a rejected MAIN endpoint close into cleanup Err", async () => {
    const disposed = await disposeMainWorldEndpoint(async () => {
      throw new Error("endpoint close rejected");
    });
    expect(disposed).toEqual(Result.err({ code: "main_cleanup_failed" }));
  });

  test("mounts a valid generated bootstrap and exposes a working readiness service", async () => {
    const target = new EventTarget();
    const channelId = "valid-main-bootstrap";
    const script = {
      dataset: {
        mpctlChannel: channelId,
        mpctlInbound: `${channelId}:isolated`,
        mpctlOutbound: `${channelId}:main`,
      },
    } as unknown as HTMLScriptElement;
    const originalDocument = globalThis.document;
    const fakeDocument = {
      location: {
        href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&isNew=1",
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { classList: [] },
    } as unknown as Document;
    const originalWindow = globalThis.window;
    Object.assign(globalThis, {
      document: fakeDocument,
      window: {
        __MP_Editor_JSAPI__: {
          invoke(request: { apiName: string; sucCb(value: unknown): void }) {
            if (request.apiName === "mp_editor_get_isready")
              request.sucCb({ isReady: true, isNew: true });
          },
        },
      },
    });

    const eventNames = { fromIsolated: `${channelId}:isolated`, fromMain: `${channelId}:main` };
    const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
    const client = new Nexus().configure({
      endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
    });
    try {
      const mounted = await mountMainWorldBridge(script, target);
      expect(Result.isOk(mounted)).toBe(true);
      await client.ready();
      const connection = await client.connect({ target: {} });
      const wire = await connection.get(pageEditorToken).ready();
      const ready = await pageEditorReadyResultCodec.deserialize(wire);
      expect(ready.unwrap()).toMatchObject({ isReady: true, isNew: true });
      if (Result.isOk(mounted)) await mounted.value.dispose();
      await clientEndpoint.close?.();
    } finally {
      await clientEndpoint.close?.();
      Object.assign(globalThis, { document: originalDocument, window: originalWindow });
    }
  });

  test("keeps the ready service fail-closed when MAIN JSAPI is unavailable", async () => {
    const target = new EventTarget();
    const channelId = "missing-main-jsapi";
    const script = {
      dataset: {
        mpctlChannel: channelId,
        mpctlInbound: `${channelId}:isolated`,
        mpctlOutbound: `${channelId}:main`,
      },
    } as unknown as HTMLScriptElement;
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    Object.assign(globalThis, {
      document: {
        location: {
          href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&isNew=1",
        },
        querySelectorAll: () => [],
        querySelector: () => null,
        body: { classList: [] },
      },
      window: {},
    });
    const eventNames = { fromIsolated: `${channelId}:isolated`, fromMain: `${channelId}:main` };
    const clientEndpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
    const client = new Nexus().configure({
      endpoint: { implementation: clientEndpoint, meta: { app: { protocolVersion } } },
    });
    try {
      const mounted = await mountMainWorldBridge(script, target);
      expect(Result.isOk(mounted)).toBe(true);
      await client.ready();
      const connection = await client.connect({ target: {} });
      const wire = await connection.get(pageEditorToken).ready();
      const ready = await pageEditorReadyResultCodec.deserialize(wire);
      expect(ready).toEqual(Result.err({ code: "jsapi_unavailable" }));
      if (Result.isOk(mounted)) await mounted.value.dispose();
      await clientEndpoint.close?.();
    } finally {
      await clientEndpoint.close?.();
      Object.assign(globalThis, { document: originalDocument, window: originalWindow });
    }
  });

  test("keeps malformed trusted generated bootstrap as an invariant defect", async () => {
    const originalDocument = globalThis.document;
    Object.assign(globalThis, {
      document: { location: { href: "https://mp.weixin.qq.com/" }, querySelectorAll: () => [] },
    });
    try {
      await expect(
        mountMainWorldBridge({ dataset: {} } as unknown as HTMLScriptElement, new EventTarget()),
      ).rejects.toThrow("MAIN world editor bridge bootstrap parameters are unavailable");
    } finally {
      Object.assign(globalThis, { document: originalDocument });
    }
  });
});
