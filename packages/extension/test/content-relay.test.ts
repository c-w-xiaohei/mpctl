import { expect, test } from "bun:test";
import { Nexus } from "@nexus-js/core";
import { Result } from "better-result";
import type { SerializedResult } from "better-result";
import { createPageEndpoint } from "../src/transport/page-bridge";
import { initializeContentServices } from "../entrypoints/mp.content";
import { pageEditorContentResultCodec, pageEditorToken } from "../src/page-contracts";

async function wire<T, E extends { code: string }>(
  encoded: Promise<Result<SerializedResult<T, E>, E>>,
) {
  const result = await encoded;
  return Result.isOk(result) ? result.value : { status: "error" as const, error: result.error };
}

test("content publishes an editor Relay and business readiness over an existing connection", async () => {
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
  const editorService = {
    ready: async () => ({ status: "ok" as const, value: { isReady: true as const, isNew: true } }),
    getContent: async () => {
      mainReads++;
      return wire(
        pageEditorContentResultCodec.serialize(
          failRead ? Result.err({ code: "page_failed" }) : Result.ok(html),
        ),
      );
    },
    setContent: async (next: string) => {
      mainWrites++;
      html = next;
      return { status: "ok" as const, value: { bodyHash: "0".repeat(64) } };
    },
  };
  const main = new Nexus()
    .configure({ endpoint: { implementation: endpoints[0], meta: {} } })
    .provide(pageEditorToken, editorService);
  const page = new Nexus().configure({ endpoint: { implementation: endpoints[1], meta: {} } });
  const content = new Nexus().configure({
    endpoint: { implementation: endpoints[2], meta: { app: { editorReady: false } } },
  });
  const background = new Nexus().configure({
    endpoint: { implementation: endpoints[3], meta: {} },
  });
  try {
    await Promise.all([main.ready(), page.ready(), content.ready(), background.ready()]);
    const connection = await background.connect({ target: {} });
    let ready = false;
    connection.subscribeIdentity((meta) => {
      ready = (meta as { app?: { editorReady?: boolean } }).app?.editorReady === true;
    });
    await initializeContentServices({
      document: { body: { classList: [] }, querySelector: () => null } as never,
      pageRuntime: page,
      chromeRuntime: content as never,
      validateTarget: () => true,
      pageState: async () => ({ state: "ready", route: "new", documentReady: true }),
    });
    const readsAfterInitialization = mainReads;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ready).toBe(true);
    const remote = connection.get(pageEditorToken);
    expect(await remote.getContent()).toEqual({ status: "ok", value: html });
    failRead = true;
    const remoteError = await pageEditorContentResultCodec.deserialize(await remote.getContent());
    expect(Result.isError(remoteError) && remoteError.error).toEqual({ code: "page_failed" });
    failRead = false;
    expect(await remote.ready()).toEqual({ status: "ok", value: { isReady: true, isNew: true } });
    expect(mainReads).toBeGreaterThan(readsAfterInitialization);
    expect(mainWrites).toBe(0);

    connection.disconnect();
    const reconnected = await background.connect({ target: {} });
    expect(await reconnected.get(pageEditorToken).getContent()).toEqual({
      status: "ok",
      value: html,
    });
    expect(mainWrites).toBe(0);
  } finally {
    for (const endpoint of endpoints) endpoint.close?.();
  }
});
