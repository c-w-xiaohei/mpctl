import { BackgroundEndpoint, type ChromeAdapterModel } from "@nexus-js/chrome";
import { Nexus, Token } from "@nexus-js/core";
import { Result } from "better-result";
import { defineBackground } from "wxt/utils/define-background";

type BinaryPayload = {
  blob: Blob;
  bytes: Uint8Array;
  nested: { blob: Blob };
};

type RpcSummary = {
  ok: boolean;
  frameId?: number;
  hasTabId?: boolean;
  hasDocumentId?: boolean;
  blobType?: string;
  blobByteLength?: number;
  blobChecksum?: number;
  viewBytes?: number[];
  nestedType?: string;
  nestedText?: string;
  image?: {
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
  };
};

const binaryToken = new Token<{
  echo(payload: BinaryPayload): Promise<BinaryPayload>;
  echoImage(input: { blob: Blob; fileName: string }): Promise<RpcSummary["image"]>;
  report(summary: RpcSummary): Promise<void>;
}>("mpctl.browser.chrome-binary-fixture");

export default defineBackground(() => {
  const nexus = new Nexus<ChromeAdapterModel>();
  nexus.configure({
    endpoint: {
      meta: { context: "background", extensionId: chrome.runtime.id, version: "0.0.1" },
      implementation: new BackgroundEndpoint(),
    },
  });
  nexus.onConnect((connection) => {
    const { tabId, frameId, sender } = connection.connectionMeta.observed;
    if (
      tabId === undefined ||
      frameId === undefined ||
      !sender?.documentId ||
      !sender.url ||
      new URL(sender.url).pathname !== "/cgi-bin/appmsg"
    )
      return;

    void verifyChromeBinaryRpc(connection, {
      frameId,
      hasTabId: tabId !== undefined,
      hasDocumentId: sender.documentId !== undefined,
    }).catch(() => undefined);
  });
  void nexus.ready();
});

async function verifyChromeBinaryRpc(
  connection: import("@nexus-js/core").Connection<ChromeAdapterModel>,
  frame: Pick<RpcSummary, "frameId" | "hasTabId" | "hasDocumentId">,
): Promise<void> {
  const acquired = connection.safeGet(binaryToken);
  if (Result.isError(acquired)) return;

  const expected = Uint8Array.from({ length: 100 * 1024 }, (_, index) => index % 251);
  const backing = new Uint8Array([0xaa, 41, 42, 0xbb]);
  const echoed = await Nexus.safeCall(
    acquired.value.echo({
      blob: new Blob([expected], { type: "image/png" }),
      bytes: new Uint8Array(backing.buffer, 1, 2),
      nested: { blob: new Blob(["nested"], { type: "text/plain" }) },
    }),
  );
  if (Result.isError(echoed)) return;

  const bytes = new Uint8Array(await echoed.value.blob.arrayBuffer());
  const matchesExpected =
    bytes.byteLength === expected.byteLength &&
    bytes.every((value, index) => value === expected[index]);
  const summary: RpcSummary = {
    ...frame,
    ok:
      frame.frameId === 0 &&
      frame.hasTabId === true &&
      frame.hasDocumentId === true &&
      matchesExpected &&
      echoed.value.blob.type === "image/png" &&
      echoed.value.bytes.length === 2 &&
      echoed.value.bytes[0] === 41 &&
      echoed.value.bytes[1] === 42 &&
      echoed.value.nested.blob.type === "text/plain" &&
      (await echoed.value.nested.blob.text()) === "nested",
    blobType: echoed.value.blob.type,
    blobByteLength: bytes.byteLength,
    blobChecksum: bytes.reduce((sum, value) => (sum + value) % 65_521, 0),
    viewBytes: [...echoed.value.bytes],
    nestedType: echoed.value.nested.blob.type,
    nestedText: await echoed.value.nested.blob.text(),
  };
  const imageBytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 251);
  const image = await Nexus.safeCall(
    acquired.value.echoImage({
      blob: new Blob([imageBytes], { type: "image/png" }),
      fileName: "fixture-image.png",
    }),
  );
  if (Result.isError(image)) return;
  summary.image = image.value;
  summary.ok = summary.ok && image.value?.ok === true;
  const reported = await Nexus.safeCall(acquired.value.report(summary));
  if (Result.isError(reported)) return;
}
