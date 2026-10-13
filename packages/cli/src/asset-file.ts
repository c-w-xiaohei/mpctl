import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { Result } from "better-result";
import { assetFileLimits } from "@mpctl/contracts";
import { cliError, type CliError } from "./connection.js";

const MAX_ASSET_BYTES = assetFileLimits.maxBytes;
const READ_LIMIT = MAX_ASSET_BYTES + 1;

type AssetFileHandle = {
  stat(): Promise<Stats>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  close(): Promise<void>;
};

type AssetFormat = {
  mimeType: string;
  extensions: readonly string[];
  matches: (bytes: Uint8Array) => boolean;
};

const formats: readonly AssetFormat[] = [
  {
    mimeType: "image/png",
    extensions: [".png"],
    matches: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    mimeType: "image/jpeg",
    extensions: [".jpg", ".jpeg"],
    matches: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  },
  {
    mimeType: "image/gif",
    extensions: [".gif"],
    matches: (bytes) =>
      startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  },
  {
    mimeType: "image/webp",
    extensions: [".webp"],
    matches: (bytes) =>
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes.length >= 12 &&
      startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  },
];

/** Reads a bounded local raster image. Magic-byte acceptance is not full image decoding. */
export async function readAssetFile(file: string): Promise<Result<AssetFile, CliError>> {
  const opened = await Result.tryPromise({
    try: () => open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    catch: () => assetError("file_error"),
  });
  if (Result.isError(opened)) return opened;
  return readAssetHandle(file, opened.value);
}

export async function readAssetHandle(
  file: string,
  handle: AssetFileHandle,
): Promise<Result<AssetFile, CliError>> {
  const inspected = await Result.tryPromise({
    try: async () => {
      const metadata = await handle.stat();
      if (!metadata.isFile()) return Result.err(assetError("invalid_asset"));
      if (metadata.size > MAX_ASSET_BYTES) return Result.err(assetError("asset_too_large"));

      const buffer = new Uint8Array(READ_LIMIT);
      let length = 0;
      while (length < READ_LIMIT) {
        const { bytesRead } = await handle.read(buffer, length, READ_LIMIT - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_ASSET_BYTES) return Result.err(assetError("asset_too_large"));
      if (length === 0) return Result.err(assetError("invalid_asset"));

      const bytes = buffer.subarray(0, length);
      const format = formats.find((candidate) => candidate.matches(bytes));
      const extension = path.extname(file).toLowerCase();
      if (!format || !format.extensions.includes(extension))
        return Result.err(assetError("invalid_asset"));

      const filename = path.basename(file);
      if (
        !filename ||
        filename.length > assetFileLimits.maxFilenameLength ||
        hasControlCharacter(filename) ||
        filename.includes("/") ||
        filename.includes("\\")
      )
        return Result.err(assetError("invalid_asset"));
      return Result.ok({
        blob: new Blob([bytes], { type: format.mimeType }),
        filename,
        mimeType: format.mimeType as AssetFile["mimeType"],
      });
    },
    catch: () => assetError("file_error"),
  });

  const closed = await Result.tryPromise({
    try: () => handle.close(),
    catch: () => assetError("file_error"),
  });
  const primary = Result.isError(inspected)
    ? inspected.error
    : Result.isError(inspected.value)
      ? inspected.value.error
      : undefined;
  if (Result.isError(closed))
    return Result.err(
      primary
        ? cliError(primary.code, primary.instruction, {
            ...primary.details,
            cleanupFailed: true,
            ...(primary.details?.failure
              ? {
                  failure: {
                    ...primary.details.failure,
                    cleanup: { at: "cli.file_read", kind: "runtime", code: "file_close_failed" },
                  },
                }
              : {}),
          })
        : closed.error,
    );
  if (Result.isError(inspected)) return inspected;
  return inspected.value;
}

type AssetFile = import("@mpctl/contracts").AssetPayload;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

function assetError(code: string): CliError {
  return cliError(
    code,
    code === "asset_too_large"
      ? "图片文件超过本地读取上限 2 MiB。"
      : "检查图片文件是否存在、可读且为支持的 PNG、JPEG、GIF 或 WebP。",
    {
      failure: {
        code: code === "file_error" ? "page_failed" : "invalid_asset",
        cause: { at: "cli.file_read", kind: code === "file_error" ? "runtime" : "domain", code },
      },
    },
  );
}
