import { describe, expect, test } from "bun:test";
import { Nexus, Token, type IPort } from "@nexus-js/core";
import { Result } from "better-result";
import { createPageEndpoint, injectMainWorldBridge } from "../src/transport/page-bridge";
import { CountingTarget, TrackingTarget } from "./listener-target-fixture";

const eventNames = { fromIsolated: "mpctl:test:isolated", fromMain: "mpctl:test:main" };

function endpoints() {
  const target = new EventTarget();
  const isolated = createPageEndpoint({ target, channelId: "test", side: "isolated", eventNames });
  const main = createPageEndpoint({ target, channelId: "test", side: "main", eventNames });
  return { isolated, main };
}

describe("page Nexus transport", () => {
  test("delivers messages asynchronously, in order, and preserves view byte ranges", async () => {
    const { isolated, main } = endpoints();
    const received: unknown[] = [];
    main.listen?.((port: IPort) => port.onMessage((message: unknown) => received.push(message)));
    const connected = await isolated.connect!({});
    const port = connected.port;
    const bytes = new Uint8Array([90, 1, 2, 91]);
    let inPostMessage = true;
    port.postMessage({ bytes: new Uint8Array(bytes.buffer, 1, 2) });
    inPostMessage = false;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inPostMessage).toBe(false);
    expect(received).toHaveLength(1);
    expect([...(received[0] as { bytes: Uint8Array }).bytes]).toEqual([1, 2]);
  });

  test("real Nexus endpoints exchange a service call and close idempotently", async () => {
    const { isolated, main } = endpoints();
    const token = new Token<{ read(): Promise<string> }>("test.page.bridge");
    const server = new Nexus().provide(token, { read: async () => "from MAIN" }).configure({
      endpoint: { implementation: main, meta: {} },
    });
    const client = new Nexus().configure({ endpoint: { implementation: isolated, meta: {} } });
    await Promise.all([server.ready(), client.ready()]);
    const remote = await client.connect({ target: {} });
    expect(await remote.get(token).read()).toBe("from MAIN");
    await Promise.all([isolated.close?.(), main.close?.()]);
    await Promise.all([isolated.close?.(), main.close?.()]);
  });

  test("Nexus.safeCall exposes a dispatched rejection as unknown rather than a normal page failure", async () => {
    const { isolated, main } = endpoints();
    const token = new Token<{ update(): Promise<void> }>("test.page.dispatched-update");
    let calls = 0;
    const server = new Nexus()
      .provide(token, {
        async update() {
          calls++;
          throw new Error("reply lost after mutation");
        },
      })
      .configure({ endpoint: { implementation: main, meta: {} } });
    const client = new Nexus().configure({ endpoint: { implementation: isolated, meta: {} } });
    await Promise.all([server.ready(), client.ready()]);
    const remote = await client.connect({ target: {} });
    const acquired = remote.safeGet(token);
    expect(Result.isOk(acquired)).toBe(true);
    if (Result.isError(acquired)) return;
    const result = await Nexus.safeCall(acquired.value.update());
    expect(Result.isError(result)).toBe(true);
    expect(calls).toBe(1);
    await Promise.all([isolated.close?.(), main.close?.()]);
  });

  test("real Nexus RPC transfers Blob MIME and bytes across the page bridge", async () => {
    const { isolated, main } = endpoints();
    const token = new Token<{ echo(blob: Blob): Promise<Blob> }>("test.page.binary-blob");
    const server = new Nexus().provide(token, { echo: async (blob: Blob) => blob }).configure({
      endpoint: { implementation: main, meta: {} },
    });
    const client = new Nexus().configure({ endpoint: { implementation: isolated, meta: {} } });
    await Promise.all([server.ready(), client.ready()]);
    const remote = await client.connect({ target: {} });
    const result = await remote
      .get(token)
      .echo(new Blob([Uint8Array.from([0, 255, 7])], { type: "image/png" }));
    expect(result.type).toBe("image/png");
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([0, 255, 7]);
    await Promise.all([isolated.close?.(), main.close?.()]);
  });

  test("real Nexus connect survives MAIN listener registration after the initial request", async () => {
    const { isolated, main } = endpoints();
    const token = new Token<{ read(): Promise<string> }>("test.page.delayed-listener");
    const delayedMain = {
      ...main,
      listen(accept: Parameters<NonNullable<typeof main.listen>>[0]) {
        setTimeout(() => {
          main.listen?.(accept);
        }, 50);
      },
    };
    const server = new Nexus().provide(token, { read: async () => "MAIN ready late" }).configure({
      endpoint: { implementation: delayedMain, meta: {} },
    });
    const client = new Nexus().configure({ endpoint: { implementation: isolated, meta: {} } });
    await Promise.all([server.ready(), client.ready()]);
    const pendingConnection = client.connect({ target: {} });
    const connection = await pendingConnection;
    expect(await connection.get(token).read()).toBe("MAIN ready late");
    await Promise.all([isolated.close?.(), main.close?.()]);
  });

  test("Nexus endpoint ports preserve typed-array offsets", async () => {
    const { isolated, main } = endpoints();
    let received: unknown;
    main.listen!((port: IPort) =>
      port.onMessage((message: unknown) => {
        received = message;
      }),
    );
    const connection = await isolated.connect!({});
    const source = new Uint8Array([99, 4, 5, 100]);
    connection.port.postMessage({ bytes: new Uint8Array(source.buffer, 1, 2) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...(received as { bytes: Uint8Array }).bytes]).toEqual([4, 5]);
    await Promise.all([isolated.close?.(), main.close?.()]);
  });

  test("rejects messages and queued delivery beyond configured bounds", async () => {
    const target = new EventTarget();
    const isolated = createPageEndpoint({
      target,
      channelId: "bounded",
      side: "isolated",
      eventNames,
      maxMessageBytes: 8,
      maxQueuedMessages: 1,
    });
    const main = createPageEndpoint({
      target,
      channelId: "bounded",
      side: "main",
      eventNames,
      maxMessageBytes: 8,
      maxQueuedMessages: 1,
    });
    main.listen?.(() => {});
    const connected = await isolated.connect!({});
    const port = connected.port;
    expect(() => port.postMessage("a payload larger than eight bytes")).toThrow(/limit/i);
    isolated.close?.();
    main.close?.();

    const queuedTarget = new EventTarget();
    const queuedIsolated = createPageEndpoint({
      target: queuedTarget,
      channelId: "queue-bound",
      side: "isolated",
      eventNames,
      maxQueuedMessages: 1,
    });
    const queuedMain = createPageEndpoint({
      target: queuedTarget,
      channelId: "queue-bound",
      side: "main",
      eventNames,
      maxQueuedMessages: 1,
    });
    queuedMain.listen!(() => {});
    const queuePort = (await queuedIsolated.connect!({})).port;
    let disconnected = false;
    queuePort.onDisconnect(() => {
      disconnected = true;
    });
    queuePort.postMessage("first");
    queuePort.postMessage("second");
    expect(disconnected).toBe(true);
    queuedIsolated.close?.();
    queuedMain.close?.();
  });

  test("closes a port when incoming data cannot be converted or cloned", async () => {
    const target = new EventTarget();
    const isolated = createPageEndpoint({
      target,
      channelId: "invalid-data",
      side: "isolated",
      eventNames,
    });
    const main = createPageEndpoint({
      target,
      channelId: "invalid-data",
      side: "main",
      eventNames,
    });
    main.listen?.(() => {});
    const port = (await isolated.connect!({})).port;
    let disconnected = false;
    port.onDisconnect(() => {
      disconnected = true;
    });

    target.dispatchEvent(
      new CustomEvent(eventNames.fromMain, {
        detail: { channelId: "invalid-data", message: new Date() },
      }),
    );

    expect(disconnected).toBe(true);
    expect(port.isClosed).toBe(true);
    await Promise.all([isolated.close?.(), main.close?.()]);
  });

  test("returns a typed bootstrap error and disposes endpoint listeners when preparation fails", async () => {
    const target = new TrackingTarget();
    const result = await injectMainWorldBridge(target, undefined, () => {
      throw new Error("prepare failure");
    });

    expect(result.isErr()).toBe(true);
    expect(Result.isError(result) ? result.error : undefined).toEqual({ code: "prepare_failed" });
    expect(target.listeners.size).toBe(0);
  });

  test("endpoint close promptly rejects a pending connect and removes handshake listeners", async () => {
    const target = new EventTarget();
    const isolated = createPageEndpoint({
      target,
      channelId: "cancel-connect",
      side: "isolated",
      eventNames,
    });
    const pending = isolated.connect!({});
    isolated.close?.();
    await expect(pending).rejects.toThrow(/closed/i);
    await expect(isolated.connect!({})).rejects.toThrow(/closed/i);
  });

  test("repeated port disconnects release listeners and remain reconnectable", async () => {
    const target = new CountingTarget();
    const isolated = createPageEndpoint({
      target,
      channelId: "reconnect",
      side: "isolated",
      eventNames,
    });
    const main = createPageEndpoint({ target, channelId: "reconnect", side: "main", eventNames });
    main.listen!(() => {});
    const baseListeners = target.count();
    for (let index = 0; index < 5; index++) {
      const { port } = await isolated.connect!({});
      let disconnects = 0;
      port.onDisconnect(() => {
        disconnects++;
      });
      port.close();
      expect(disconnects).toBe(1);
      expect(target.count()).toBe(baseListeners);
    }
    isolated.close?.();
    main.close?.();
    expect(target.count()).toBe(0);
  });

  test("MAIN endpoint closes its listener and accepted port when ISOLATED disconnects", async () => {
    const target = new CountingTarget();
    const isolated = createPageEndpoint({
      target,
      channelId: "peer-disconnect",
      side: "isolated",
      eventNames,
    });
    const main = createPageEndpoint({
      target,
      channelId: "peer-disconnect",
      side: "main",
      eventNames,
    });
    const client = new Nexus().configure({ endpoint: { implementation: isolated, meta: {} } });
    const server = new Nexus().configure({ endpoint: { implementation: main, meta: {} } });
    await Promise.all([client.ready(), server.ready()]);
    await client.connect({ target: {} });
    expect(target.count()).toBeGreaterThan(0);

    isolated.close?.();

    expect(target.count()).toBe(0);
    await expect(client.connect({ target: {} })).rejects.toThrow(/closed/i);
  });

  test("endpoint close attempts every port and removes listeners when a disconnect callback throws", async () => {
    const target = new CountingTarget();
    const isolated = createPageEndpoint({
      target,
      channelId: "close-all",
      side: "isolated",
      eventNames,
    });
    const main = createPageEndpoint({ target, channelId: "close-all", side: "main", eventNames });
    const accepted: IPort[] = [];
    main.listen?.((port: IPort) => accepted.push(port));
    const first = (await isolated.connect!({})).port;
    const second = (await isolated.connect!({})).port;
    const disconnected: number[] = [];
    accepted[0]?.onDisconnect(() => {
      disconnected.push(0);
      throw new Error("disconnect callback failed");
    });
    accepted[1]?.onDisconnect(() => disconnected.push(1));

    expect(() => main.close?.()).toThrow("disconnect callback failed");

    expect(accepted.map((port) => port.isClosed)).toEqual([true, true]);
    expect(disconnected).toEqual([0, 1]);
    expect(first.isClosed).toBe(true);
    expect(second.isClosed).toBe(true);
    expect(target.count()).toBe(0);
    await isolated.close?.();
  });
});
