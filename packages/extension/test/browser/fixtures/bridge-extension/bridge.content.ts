import { injectScript } from "wxt/utils/inject-script";
import { defineContentScript } from "wxt/utils/define-content-script";
import { createPageEndpoint } from "../../../../src/transport/page-bridge";

export default defineContentScript({
  matches: ["https://mp.weixin.qq.com/cgi-bin/appmsg*"],
  runAt: "document_start",
  async main() {
    const channelId = crypto.randomUUID();
    const names = {
      fromIsolated: `mpctl-fixture:${channelId}:isolated`,
      fromMain: `mpctl-fixture:${channelId}:main`,
    };
    const endpoint = createPageEndpoint({
      target: document,
      channelId,
      side: "isolated",
      eventNames: names,
    });
    const script = await injectScript("/bridge-main.js", {
      modifyScript(element) {
        element.dataset.mpctlChannel = channelId;
        element.dataset.mpctlInbound = names.fromIsolated;
        element.dataset.mpctlOutbound = names.fromMain;
      },
    });
    const connection = await endpoint.connect?.({});
    const port = connection?.port;
    if (!port) throw new Error("Fixture page endpoint did not connect");
    port.onMessage((message: unknown) => {
      const log = JSON.parse(
        document.documentElement.dataset.mpctlFixtureReceived ?? "[]",
      ) as unknown[];
      log.push(message);
      document.documentElement.dataset.mpctlFixtureReceived = JSON.stringify(log);
      document.dispatchEvent(
        new CustomEvent("mpctl-fixture-message", { detail: JSON.stringify(serialize(message)) }),
      );
      if (
        typeof message === "object" &&
        message !== null &&
        isPlainData(message) &&
        "status" in message
      ) {
        const envelopes = JSON.parse(
          document.documentElement.dataset.mpctlIsolatedPlainEnvelopes ?? "[]",
        ) as boolean[];
        envelopes.push(isPlainData(message));
        document.documentElement.dataset.mpctlIsolatedPlainEnvelopes = JSON.stringify(envelopes);
      }
      if (
        typeof message === "object" &&
        message !== null &&
        "kind" in message &&
        message.kind === "ack" &&
        (message as { sequence?: number }).sequence === 1
      ) {
        port.postMessage({ sequence: 3, bytes: new Uint8Array([8, 9]) });
      }
    });
    port.onDisconnect(() => {
      document.documentElement.dataset.mpctlFixturePeerClosed = "yes";
    });
    document.documentElement.dataset.mpctlFixtureChannel = channelId;
    document.documentElement.dataset.mpctlFixtureReady = "yes";
    document.documentElement.dataset.mpctlFixturePortReady = "yes";

    document.addEventListener("mpctl-fixture-command", (event) => {
      const detail = JSON.parse((event as CustomEvent<string>).detail) as {
        messages?: Array<{ sequence: number; bytes: number[]; view?: "dataview" }>;
        envelopes?: unknown[];
        close?: boolean;
      };
      if (detail.close) {
        port.close();
        document.documentElement.dataset.mpctlFixtureClosed = "isolated";
        return;
      }
      for (const message of detail.messages ?? []) {
        const backing = Uint8Array.from([0xaa, ...message.bytes, 0xbb]);
        const view =
          message.view === "dataview"
            ? new DataView(backing.buffer, 1, message.bytes.length)
            : new Uint8Array(backing.buffer, 1, message.bytes.length);
        port.postMessage({ sequence: message.sequence, bytes: view });
      }
      for (const envelope of detail.envelopes ?? []) port.postMessage(envelope);
    });

    const invalidated = () => {
      port.close();
      endpoint.close?.();
      script.script.remove();
    };
    window.addEventListener("pagehide", invalidated, { once: true });
  },
});

function isPlainData(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isPlainData);
  if (value === null || typeof value !== "object") return true;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isPlainData);
}

function serialize(message: unknown): unknown {
  if (message instanceof Uint8Array) return { type: "Uint8Array", values: [...message] };
  if (message instanceof DataView)
    return {
      type: "DataView",
      values: [...new Uint8Array(message.buffer, message.byteOffset, message.byteLength)],
    };
  if (ArrayBuffer.isView(message))
    return {
      type: message.constructor.name,
      values: [...new Uint8Array(message.buffer, message.byteOffset, message.byteLength)],
    };
  if (Array.isArray(message)) return message.map(serialize);
  if (message && typeof message === "object")
    return Object.fromEntries(
      Object.entries(message).map(([key, value]) => [key, serialize(value)]),
    );
  return message;
}
