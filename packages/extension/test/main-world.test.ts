import { describe, expect, test } from "bun:test";
import { Nexus } from "@nexus-js/core";
import { Result } from "better-result";
import {
  awaitMainWorldReady,
  disposeMainWorldEndpoint,
  mountMainWorldBridge,
} from "../entrypoints/mp-main-world";
import { createPageEndpoint } from "../src/transport/page-bridge";
import { pageEditorReadyResultCodec, pageEditorToken } from "../src/page-contracts";

describe("MAIN-world bridge startup", () => {
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

    expect(Result.isError(result) && result.error).toEqual({ code: "main_cleanup_failed" });
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
      endpoint: { implementation: clientEndpoint, meta: {} },
    });
    try {
      const mounted = await mountMainWorldBridge(script, target);
      expect(Result.isOk(mounted)).toBe(true);
      await client.ready();
      const connection = await client.connect({ target: {} });
      const wire = await connection.get(pageEditorToken).ready();
      const ready = await pageEditorReadyResultCodec.deserialize(wire);
      expect(ready).toEqual(Result.ok({ isReady: true, isNew: true }));
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
      endpoint: { implementation: clientEndpoint, meta: {} },
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
