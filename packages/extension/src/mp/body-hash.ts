import { Result } from "better-result";

export type BodyHashError = { code: "hash_failed" };
export type BodyHashResult = import("better-result").Result<string, BodyHashError>;

export async function hashBody(html: string): Promise<BodyHashResult> {
  const digest = await Result.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(html)),
    catch: () => ({ code: "hash_failed" as const }),
  });
  if (Result.isError(digest)) return digest;
  return Result.ok(
    [...new Uint8Array(digest.value)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}
