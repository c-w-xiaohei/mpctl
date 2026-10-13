import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { Nexus, Token } from "@nexus-js/core";
import { protocolVersion } from "@mpctl/contracts";
import {
  createPageEndpoint,
  type PageBridgeAdapterModel,
} from "../../../../src/transport/page-bridge";
import type { IPort } from "@nexus-js/core";

const binaryToken = new Token<{
  echo(input: { blob: Blob; bytes: Uint8Array; nested: { blob: Blob } }): Promise<{
    blob: Blob;
    bytes: Uint8Array;
    nested: { blob: Blob };
  }>;
  echoImage(input: { blob: Blob; fileName: string }): Promise<{ blob: Blob; nativeBlob: boolean }>;
}>("mpctl.browser.binary-fixture");

export default defineUnlistedScript(() => {
  const script = document.currentScript;
  if (!(script instanceof HTMLScriptElement)) return;
  const {
    mpctlChannel: channelId,
    mpctlInbound: fromIsolated,
    mpctlOutbound: fromMain,
  } = script.dataset;
  if (!channelId || !fromIsolated || !fromMain)
    throw new Error("Missing test bridge bootstrap data");

  const endpoint = createPageEndpoint({
    target: document,
    channelId,
    side: "main",
    eventNames: { fromIsolated, fromMain },
  });
  const rpcEndpoint = createPageEndpoint({
    target: document,
    channelId: `${channelId}-rpc`,
    side: "main",
    eventNames: {
      fromIsolated: `${fromIsolated}:rpc`,
      fromMain: `${fromMain}:rpc`,
    },
  });
  const nexus = new Nexus<PageBridgeAdapterModel>()
    .provide(binaryToken, {
      echo: async (input) => input,
      echoImage: async (input) => ({ blob: input.blob, nativeBlob: input.blob instanceof Blob }),
    })
    .configure({ endpoint: { implementation: rpcEndpoint, meta: { app: { protocolVersion } } } });
  void nexus.ready();
  let activePort: IPort | undefined;
  endpoint.listen?.((port: IPort) => {
    activePort = port;
    port.onMessage((message: unknown) => {
      const received = JSON.parse(
        document.documentElement.dataset.mpctlMainReceived ?? "[]",
      ) as unknown[];
      received.push(message);
      document.documentElement.dataset.mpctlMainReceived = JSON.stringify(received);
      if (
        typeof message === "object" &&
        message !== null &&
        isPlainData(message) &&
        "status" in message
      ) {
        const envelopes = JSON.parse(
          document.documentElement.dataset.mpctlMainPlainEnvelopes ?? "[]",
        ) as boolean[];
        envelopes.push(isPlainData(message));
        document.documentElement.dataset.mpctlMainPlainEnvelopes = JSON.stringify(envelopes);
      }
      if (typeof message === "object" && message !== null && "sequence" in message) {
        const sequenced = message as { sequence: unknown; bytes?: unknown };
        port.postMessage({
          kind: "ack",
          sequence: sequenced.sequence,
          bytes: sequenced.bytes,
        });
      } else {
        port.postMessage(message);
      }
    });
    port.onDisconnect(() => {
      document.documentElement.dataset.mpctlMainDisconnected = "yes";
    });
    document.documentElement.dataset.mpctlMainConnected = "yes";
  });
  document.addEventListener("mpctl-fixture-main-command", (event) => {
    const detail = JSON.parse((event as CustomEvent<string>).detail) as {
      close?: boolean;
      messages?: unknown[];
    };
    if (detail.close) {
      activePort?.close();
      document.documentElement.dataset.mpctlMainClosed = "yes";
      endpoint.close?.();
      return;
    }
    for (const message of detail.messages ?? []) activePort?.postMessage(message);
  });
  document.documentElement.dataset.mpctlMainReady = "yes";
});

function isPlainData(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isPlainData);
  if (value === null || typeof value !== "object") return true;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isPlainData);
}
