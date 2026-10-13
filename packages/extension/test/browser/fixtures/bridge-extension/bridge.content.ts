import { injectScript } from "wxt/utils/inject-script";
import { defineContentScript } from "wxt/utils/define-content-script";
import { ContentScriptEndpoint, chromeTarget, type ChromeAdapterModel } from "@nexus-js/chrome";
import { Nexus, Token } from "@nexus-js/core";
import { createPageEndpoint } from "../../../../src/transport/page-bridge";

const binaryToken = new Token<{
  echo(input: { blob: Blob; bytes: Uint8Array; nested: { blob: Blob } }): Promise<{
    blob: Blob;
    bytes: Uint8Array;
    nested: { blob: Blob };
  }>;
  echoImage(input: { blob: Blob; fileName: string }): Promise<{ blob: Blob; nativeBlob: boolean }>;
}>("mpctl.browser.binary-fixture");

const chromeBinaryToken = new Token<{
  echo(payload: { blob: Blob; bytes: Uint8Array; nested: { blob: Blob } }): Promise<{
    blob: Blob;
    bytes: Uint8Array;
    nested: { blob: Blob };
  }>;
  report(summary: {
    ok: boolean;
    blobType?: string;
    blobByteLength?: number;
    blobChecksum?: number;
    viewBytes?: number[];
    nestedType?: string;
    nestedText?: string;
  }): Promise<void>;
  echoImage(input: { blob: Blob; fileName: string }): Promise<{
    ok: boolean;
    fileName: string;
    mimeType: string;
    byteLength: number;
    sha256: string;
    contentNativeBlob: boolean;
    mainNativeBlob: boolean;
    inputFileName?: string;
    inputMimeType?: string;
    inputByteLength?: number;
    inputSha256?: string;
  }>;
}>("mpctl.browser.chrome-binary-fixture");

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
    const rpcEndpoint = createPageEndpoint({
      target: document,
      channelId: `${channelId}-rpc`,
      side: "isolated",
      eventNames: {
        fromIsolated: `${names.fromIsolated}:rpc`,
        fromMain: `${names.fromMain}:rpc`,
      },
    });
    const nexus = new Nexus().configure({ endpoint: { implementation: rpcEndpoint, meta: {} } });
    await nexus.ready();
    const remote = await nexus.connect({ target: {} });
    document.addEventListener("mpctl-fixture-rpc-command", (event) => {
      const detail = (
        event as CustomEvent<{
          blob: Blob;
          bytes: Uint8Array;
          nested: { blob: Blob };
        }>
      ).detail;
      void remote
        .get(binaryToken)
        .echo(detail)
        .then((result) => {
          document.dispatchEvent(new CustomEvent("mpctl-fixture-rpc-result", { detail: result }));
        });
    });
    document.documentElement.dataset.mpctlFixtureRpcReady = "yes";

    const chromeRuntime = new Nexus<ChromeAdapterModel>();
    chromeRuntime.provide(chromeBinaryToken, {
      async echo(payload) {
        return payload;
      },
      async report(summary) {
        document.documentElement.dataset.mpctlChromeRpcResult = JSON.stringify(summary);
      },
      async echoImage(input) {
        const echoed = await remote.get(binaryToken).echoImage(input);
        const bytes = new Uint8Array(await echoed.blob.arrayBuffer());
        const sha256 = await digest(bytes);
        const file = new File([echoed.blob], input.fileName, { type: echoed.blob.type });
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.dataset.fixtureOnly = "true";
        document.body.append(fileInput);
        const transfer = new DataTransfer();
        transfer.items.add(file);
        fileInput.files = transfer.files;
        const inputFile = fileInput.files?.[0];
        const inputBytes = inputFile
          ? new Uint8Array(await inputFile.arrayBuffer())
          : new Uint8Array();
        const inputSha256 = await digest(inputBytes);
        fileInput.remove();
        const sourceHash = await digest(new Uint8Array(await input.blob.arrayBuffer()));
        return {
          ok:
            echoed.nativeBlob &&
            echoed.blob instanceof Blob &&
            echoed.blob.size === 2 * 1024 * 1024 &&
            echoed.blob.type === "image/png" &&
            sha256 === sourceHash &&
            inputFile?.name === input.fileName &&
            inputFile.type === echoed.blob.type &&
            inputBytes.byteLength === echoed.blob.size &&
            inputSha256 === sha256,
          fileName: input.fileName,
          mimeType: echoed.blob.type,
          byteLength: bytes.byteLength,
          sha256,
          contentNativeBlob: echoed.blob instanceof Blob,
          mainNativeBlob: echoed.nativeBlob,
          inputFileName: inputFile?.name,
          inputMimeType: inputFile?.type,
          inputByteLength: inputBytes.byteLength,
          inputSha256,
        };
      },
    });
    chromeRuntime.configure({
      endpoint: {
        meta: {
          context: "content-script",
          url: location.href,
          origin: location.origin,
        },
        implementation: new ContentScriptEndpoint(),
      },
    });
    await chromeRuntime.ready();
    await chromeRuntime.connect({ target: chromeTarget.background() });
    document.documentElement.dataset.mpctlChromeRpcReady = "yes";
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

async function digest(bytes: Uint8Array): Promise<string> {
  const source = new Uint8Array(bytes.byteLength);
  source.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", source.buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
