import { chromium, expect, test } from "@playwright/test";
import { createHash as createHashSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeBridgeFixture, collectBridgeDiagnostics } from "./fixtures/bridge-routing";

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const fixtureExtension = path.join(
  root,
  "packages/extension/.output/browser-bridge-fixture/chrome-mv3",
);
const fixtureRoot = path.join(root, "packages/extension/test/browser/fixtures/bridge");
const fixtureUrl = "https://mp.weixin.qq.com/cgi-bin/appmsg?t=chrome-binary-fixture";

test("Chrome background and the bound content frame round-trip binary Nexus RPC", async () => {
  test.setTimeout(30_000);
  const temp = await mkdtemp(path.join(os.tmpdir(), "mpctl-chrome-binary-"));
  const diagnostics: string[] = [];
  const context = await chromium.launchPersistentContext(path.join(temp, "profile"), {
    channel: "chromium",
    headless: true,
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${fixtureExtension}`,
      `--load-extension=${fixtureExtension}`,
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--host-resolver-rules=MAP mp.weixin.qq.com ~NOTFOUND, EXCLUDE localhost",
    ],
  });

  try {
    await routeBridgeFixture(context, fixtureRoot, fixtureExtension, diagnostics);

    const page = await context.newPage();
    collectBridgeDiagnostics(page, diagnostics);

    await page.goto(fixtureUrl);
    try {
      await expect
        .poll(() => page.locator("html").getAttribute("data-mpctl-chrome-rpc-ready"))
        .toBe("yes");
    } catch (error) {
      diagnostics.push(`html=${await page.locator("html").evaluate((node) => node.outerHTML)}`);
      diagnostics.push(
        `workers=${JSON.stringify(context.serviceWorkers().map((worker) => new URL(worker.url()).pathname))}`,
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${diagnostics.join("\n")}`,
      );
    }
    await expect
      .poll(() => page.locator("html").getAttribute("data-mpctl-chrome-rpc-result"))
      .not.toBeNull();

    const result = JSON.parse(
      (await page.locator("html").getAttribute("data-mpctl-chrome-rpc-result")) ?? "null",
    ) as {
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
    const expectedChecksum = Array.from({ length: 100 * 1024 }, (_, index) => index % 251).reduce(
      (sum, byte) => (sum + byte) % 65_521,
      0,
    );
    expect(result).toEqual({
      ok: true,
      frameId: 0,
      hasTabId: true,
      hasDocumentId: true,
      blobType: "image/png",
      blobByteLength: 100 * 1024,
      blobChecksum: expectedChecksum,
      viewBytes: [41, 42],
      nestedType: "text/plain",
      nestedText: "nested",
      image: {
        ok: true,
        fileName: "fixture-image.png",
        mimeType: "image/png",
        byteLength: 2 * 1024 * 1024,
        sha256: createHash(2 * 1024 * 1024),
        contentNativeBlob: true,
        mainNativeBlob: true,
        inputFileName: "fixture-image.png",
        inputMimeType: "image/png",
        inputByteLength: 2 * 1024 * 1024,
        inputSha256: createHash(2 * 1024 * 1024),
      },
    });
  } finally {
    await context.close();
    await rm(temp, { recursive: true, force: true });
  }
});

function createHash(byteLength: number): string {
  const bytes = Buffer.allocUnsafe(byteLength);
  for (let index = 0; index < byteLength; index++) bytes[index] = index % 251;
  return createHashSync("sha256").update(bytes).digest("hex");
}
