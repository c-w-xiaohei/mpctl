import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { hashBody } from "../src/mp/body-hash";

describe("body hashing", () => {
  test("returns the SHA-256 digest as an Ok result", async () => {
    expect(await hashBody("abc")).toEqual(
      Result.ok("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
    );
  });

  test("converts WebCrypto digest rejection into a typed Err", async () => {
    const original = crypto.subtle.digest;
    crypto.subtle.digest = (() => Promise.reject(new Error("offline crypto"))) as typeof original;
    try {
      const result = await hashBody("abc");
      expect(Result.isError(result) && result.error).toEqual({ code: "hash_failed" });
    } finally {
      crypto.subtle.digest = original;
    }
  });
});
