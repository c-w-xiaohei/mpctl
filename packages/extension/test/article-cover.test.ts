import { expect, test } from "bun:test";
import { Result } from "better-result";
import { hashArticleCover, readArticleCover } from "../src/mp/article-cover";

// CSS, URL parsing and preview state are exercised with real DOM/CSS in
// browser/article-cover.spec.ts. These cover only injected runtime failures.
test("cover DOM query failures return page_failed", () => {
  const document = {
    querySelectorAll() {
      throw new Error("query unavailable");
    },
  } as unknown as Document;
  expect(readArticleCover(document)).toEqual(Result.err({ code: "page_failed" }));
});

test("cover WebCrypto failures return hash_failed", async () => {
  const original = crypto.subtle.digest;
  crypto.subtle.digest = (() => Promise.reject(new Error("crypto unavailable"))) as typeof original;
  try {
    expect(
      await hashArticleCover({
        primary: { visible: true, url: "https://mmbiz.qpic.cn/mmbiz_png/abc/0" },
        square: { visible: false, url: null },
      }),
    ).toEqual(Result.err({ code: "hash_failed" }));
  } finally {
    crypto.subtle.digest = original;
  }
});
