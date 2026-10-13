import { afterEach, expect, test, spyOn } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { Nexus } from "@nexus-js/core";
import { assetCommand } from "../src/asset";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Result } from "better-result";
import { readAssetFile, readAssetHandle } from "../src/asset-file";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function tempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mpctl-asset-"));
  directories.push(directory);
  return directory;
}

const signatures = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff, 0x00],
  gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  webp: [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
} as const;

test.each(["invalid-close", "stat", "read", "close"] as const)(
  "R4 assetCommand retains %s local file failure without remote acquisition",
  async (mode) => {
    const file = path.join(await tempDirectory(), "input.png");
    await writeFile(
      file,
      mode === "invalid-close" ? new Uint8Array() : Uint8Array.from(signatures.png),
    );
    const handle = await open(file, "r");
    let closed = false;
    const opening = spyOn(fsPromises, "open").mockResolvedValue({
      stat: async () => {
        if (mode === "stat") throw new Error("private stat failure");
        return handle.stat();
      },
      read: async (...args: Parameters<typeof handle.read>) => {
        if (mode === "read") throw new Error("private read failure");
        return handle.read(...args);
      },
      close: async () => {
        await handle.close();
        closed = true;
        if (mode === "close" || mode === "invalid-close") throw new Error("private close failure");
      },
    } as typeof handle);
    const remote = spyOn(Nexus.prototype, "safeConnect");
    try {
      const result = await assetCommand("upload", "article", { file });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result))
        expect(result.error).toMatchObject({
          code: mode === "invalid-close" ? "invalid_asset" : "file_error",
          details: {
            ...(mode === "invalid-close" ? { cleanupFailed: true } : {}),
            failure: {
              cause: {
                at: "cli.file_read",
                kind: mode === "invalid-close" ? "domain" : "runtime",
                code: mode === "invalid-close" ? "invalid_asset" : "file_error",
              },
            },
          },
        });
      expect(remote).not.toHaveBeenCalled();
      expect(closed).toBe(true);
    } finally {
      opening.mockRestore();
      remote.mockRestore();
      if (!closed) await handle.close();
    }
  },
);

test("reads supported image bytes into a native Blob with verified MIME and basename", async () => {
  const directory = await tempDirectory();
  const bytes = Uint8Array.from([0xaa, 0xbb, ...signatures.png, 0xcc]);
  const file = path.join(directory, "图.png");
  await writeFile(file, Uint8Array.from(bytes.subarray(2, bytes.length)));

  const result = await readAssetFile(file);

  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) return;
  expect(result.value.filename).toBe("图.png");
  expect(result.value.mimeType).toBe("image/png");
  expect(result.value.blob).toBeInstanceOf(Blob);
  expect(result.value.blob.type).toBe("image/png");
  expect(new Uint8Array(await result.value.blob.arrayBuffer())).toEqual(bytes.subarray(2));
});

test.each([
  ["png", "image/png", "photo.PNG"],
  ["jpeg", "image/jpeg", "photo.JpEg"],
  ["gif", "image/gif", "photo.GIF"],
  ["webp", "image/webp", "photo.webp"],
] as const)(
  "recognizes %s from bytes with case-insensitive extension",
  async (kind, mimeType, name) => {
    const file = path.join(await tempDirectory(), name);
    await writeFile(file, Uint8Array.from(signatures[kind]));
    const result = await readAssetFile(file);
    expect(Result.isOk(result) && result.value.mimeType).toBe(mimeType);
  },
);

test("rejects empty, unsupported, misleading-extension, missing, and non-regular inputs", async () => {
  const directory = await tempDirectory();
  const empty = path.join(directory, "empty.png");
  const svg = path.join(directory, "vector.svg");
  const mismatch = path.join(directory, "not-a-png.png");
  const nested = path.join(directory, "folder");
  await writeFile(empty, new Uint8Array());
  await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(mismatch, Uint8Array.from(signatures.gif));
  await mkdir(nested);

  for (const file of [empty, svg, mismatch, path.join(directory, "missing.png"), nested]) {
    const result = await readAssetFile(file);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) expect(JSON.stringify(result.error)).not.toContain(directory);
  }
});

test("rejects control characters in the basename before IPC", async () => {
  const directory = await tempDirectory();
  const control = path.join(directory, "bad\nname.png");
  await writeFile(control, Uint8Array.from(signatures.png));
  const result = await readAssetFile(control);
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) expect(result.error.code).toBe("invalid_asset");
});

test("rejects files larger than 2 MiB", async () => {
  const file = path.join(await tempDirectory(), "large.png");
  const bytes = new Uint8Array(2 * 1024 * 1024 + 1);
  bytes.set(signatures.png);
  await writeFile(file, bytes);

  const result = await readAssetFile(file);

  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) expect(result.error.code).toBe("asset_too_large");
});

test("preserves the primary validation error and marks a failing close", async () => {
  const file = path.join(await tempDirectory(), "empty.png");
  await writeFile(file, new Uint8Array());
  const handle = await open(file, "r");

  const result = await readAssetHandle(file, {
    stat: () => handle.stat(),
    read: (...args) => handle.read(...args),
    close: async () => {
      await handle.close();
      throw new Error("close failure");
    },
  });

  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result))
    expect(result.error).toMatchObject({ code: "invalid_asset", details: { cleanupFailed: true } });
});

test("rejects a FIFO promptly instead of blocking while opening it", async () => {
  const fifo = path.join(await tempDirectory(), "pipe.png");
  const created = Bun.spawnSync({
    cmd: ["python3", "-c", "import os,sys; os.mkfifo(sys.argv[1])", fifo],
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(created.exitCode).toBe(0);

  const moduleUrl = new URL("../src/asset-file.ts", import.meta.url).href;
  const reader = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { readAssetFile } = await import(${JSON.stringify(moduleUrl)}); const result = await readAssetFile(process.argv[1]); console.log(JSON.stringify(result));`,
      fifo,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    reader.exited.then((exitCode) => ({ exitCode })),
    new Promise<{ timedOut: true }>((resolve) => {
      timeout = setTimeout(() => resolve({ timedOut: true }), 1_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if ("timedOut" in outcome) {
    reader.kill();
    await reader.exited;
    throw new Error("FIFO read subprocess exceeded the one-second bound");
  }

  const stdout = await new Response(reader.stdout).text();
  const stderr = await new Response(reader.stderr).text();
  expect({ exitCode: outcome.exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(stdout)).toMatchObject({ error: { code: "invalid_asset" } });
});
