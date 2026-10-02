import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { hashBody } from "../src/mp/body-hash";
import { createEditorService } from "../src/mp/jsapi";
import {
  pageEditorContentResultCodec,
  pageEditorReadyResultCodec,
  pageEditorWriteResultCodec,
} from "../src/page-contracts";

async function hashForTest(html: string): Promise<string> {
  const result = await hashBody(html);
  expect(Result.isOk(result)).toBe(true);
  return Result.isOk(result) ? result.value : "";
}

async function decodeWrite(
  wire: Awaited<ReturnType<ReturnType<typeof createEditorService>["setContent"]>>,
) {
  return pageEditorWriteResultCodec.deserialize(wire);
}

async function decodeReady(
  wire: Awaited<ReturnType<ReturnType<typeof createEditorService>["ready"]>>,
) {
  return pageEditorReadyResultCodec.deserialize(wire);
}

async function decodeContent(
  wire: Awaited<ReturnType<ReturnType<typeof createEditorService>["getContent"]>>,
) {
  return pageEditorContentResultCodec.deserialize(wire);
}

describe("MAIN editor service", () => {
  test("checks readiness and editor version before reading, preserving empty HTML", async () => {
    const calls: string[] = [];
    const service = createEditorService({
      timeoutMs: 100,
      invoke(request) {
        calls.push(request.apiName);
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        if (request.apiName === "mp_editor_get_content") request.sucCb({ content: "" });
      },
    });
    expect(await decodeReady(await service.ready())).toEqual(
      Result.ok({ isReady: true, isNew: true }),
    );
    expect(await decodeContent(await service.getContent())).toEqual(Result.ok(""));
    expect(calls).toEqual(["mp_editor_get_isready", "mp_editor_get_content"]);
  });

  test("returns a serialized domain Err for an invalid target instead of rejecting RPC", async () => {
    const service = createEditorService({
      validateTarget: () => false,
      invoke() {
        throw new Error("JSAPI must not be called for an invalid target");
      },
    });

    const wire = await service.ready();
    expect(wire).toEqual({ status: "error", error: { code: "target_unavailable" } });
    expect(await decodeReady(wire)).toEqual(Result.err({ code: "target_unavailable" }));
  });

  test("maps external readiness and content getter traps to typed Err values", async () => {
    const readiness = createEditorService({
      invoke(request) {
        request.sucCb(
          new Proxy(
            {},
            {
              get(_target, key) {
                if (key === "isReady") throw new Error("proxy trap");
                return undefined;
              },
            },
          ),
        );
      },
    });
    expect(await decodeReady(await readiness.ready())).toEqual(Result.err({ code: "page_failed" }));

    const content = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else
          request.sucCb({
            get content() {
              throw new Error("content getter trap");
            },
          });
      },
    });
    expect(await decodeContent(await content.getContent())).toEqual(
      Result.err({ code: "page_failed" }),
    );
  });

  test("preflight content getter trap is page_failed and does not dispatch a write", async () => {
    let writes = 0;
    const service = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content")
          request.sucCb({
            get content() {
              throw new Error("preflight getter trap");
            },
          });
        else writes++;
      },
    });

    expect(
      await decodeWrite(await service.setContent("next", await hashForTest("before"))),
    ).toEqual(Result.err({ code: "page_failed" }));
    expect(writes).toBe(0);
  });

  test("post-dispatch content getter trap is write_unknown and releases the serialized writer queue", async () => {
    let contentReads = 0;
    let writes = 0;
    const service = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready") {
          request.sucCb({ isReady: true, isNew: true });
        } else if (request.apiName === "mp_editor_get_content") {
          contentReads++;
          if (contentReads === 2) {
            request.sucCb({
              get content() {
                throw new Error("post-write getter trap");
              },
            });
          } else {
            request.sucCb({ content: "before" });
          }
        } else {
          writes++;
          request.sucCb({ msg: "ok" });
        }
      },
    });
    const expectedHash = await hashForTest("before");

    expect(await decodeWrite(await service.setContent("first", expectedHash))).toEqual(
      Result.err({ code: "write_unknown" }),
    );
    expect(await decodeWrite(await service.setContent("second", expectedHash))).toEqual(
      Result.ok({ bodyHash: expectedHash }),
    );
    expect({ contentReads, writes }).toEqual({ contentReads: 4, writes: 2 });
  });

  test("keeps a stale snapshot from dispatching a write", async () => {
    let writes = 0;
    const service = createEditorService({
      timeoutMs: 100,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: "changed" });
        else writes++;
      },
    });
    expect(
      await decodeWrite(await service.setContent("replacement", await hashForTest("before"))),
    ).toEqual(Result.err({ code: "content_conflict" }));
    expect(writes).toBe(0);
  });

  test("serializes two writes based on the same snapshot so only one succeeds", async () => {
    let body = "original";
    let writeCount = 0;
    const service = createEditorService({
      timeoutMs: 100,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: body });
        else {
          writeCount++;
          body = `<p>${request.apiParam.content}</p>`;
          request.sucCb({ msg: "ok" });
        }
      },
    });
    const snapshotHash = await hashForTest(body);
    const results = await Promise.all([
      service.setContent("first", snapshotHash),
      service.setContent("second", snapshotHash),
    ]);
    const decoded = await Promise.all(results.map(decodeWrite));
    expect(decoded.filter(Result.isOk)).toHaveLength(1);
    expect(decoded.filter(Result.isError)).toEqual([Result.err({ code: "content_conflict" })]);
    expect(writeCount).toBe(1);
    expect(decoded.find(Result.isOk)).toEqual(Result.ok({ bodyHash: await hashForTest(body) }));
  });

  test("returns hash of normalized content read back after the write", async () => {
    let body = "before";
    const normalized = "<p>normalized by editor</p>";
    const service = createEditorService({
      timeoutMs: 100,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: body });
        else {
          body = normalized;
          request.sucCb({ msg: "ok" });
        }
      },
    });
    expect(
      await decodeWrite(await service.setContent("input", await hashForTest("before"))),
    ).toEqual(Result.ok({ bodyHash: await hashForTest(normalized) }));
  });

  test("reports set timeout as unknown and never retries the write", async () => {
    let writes = 0;
    const service = createEditorService({
      timeoutMs: 5,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: "before" });
        else writes++;
      },
    });
    expect(
      await decodeWrite(await service.setContent("next", await hashForTest("before"))),
    ).toEqual(Result.err({ code: "write_unknown" }));
    expect(writes).toBe(1);
  });

  test("reports malformed preflight content as a page failure without writing", async () => {
    let writes = 0;
    const service = createEditorService({
      timeoutMs: 100,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") request.sucCb({ content: 4 });
        else writes++;
      },
    });
    expect(
      await decodeWrite(await service.setContent("next", await hashForTest("before"))),
    ).toEqual(Result.err({ code: "page_failed" }));
    expect(writes).toBe(0);
  });

  test("CSS-only changes are conflicts even when visible text is unchanged", async () => {
    const before = '<p style="color:red">same text</p>';
    let writes = 0;
    const service = createEditorService({
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content")
          request.sucCb({ content: before.replace("red", "blue") });
        else writes++;
      },
    });
    expect(
      await decodeWrite(await service.setContent("replacement", await hashForTest(before))),
    ).toEqual(Result.err({ code: "content_conflict" }));
    expect(writes).toBe(0);
  });

  test("rechecks the target at mutation dispatch after reading and hashing", async () => {
    let current = true;
    let writes = 0;
    const service = createEditorService({
      validateTarget: () => current,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") {
          request.sucCb({ content: "before" });
          current = false;
        } else writes++;
      },
    });
    expect(
      await decodeWrite(await service.setContent("replacement", await hashForTest("before"))),
    ).toEqual(Result.err({ code: "target_unavailable" }));
    expect(writes).toBe(0);
  });

  test("a second queued writer rechecks its target before any JSAPI read", async () => {
    let current = true;
    let completeWrite: (() => void) | undefined;
    let reads = 0;
    let writes = 0;
    let body = "before";
    const service = createEditorService({
      validateTarget: () => current,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else if (request.apiName === "mp_editor_get_content") {
          reads++;
          request.sucCb({ content: body });
        } else {
          writes++;
          completeWrite = () => {
            body = "first";
            request.sucCb({ msg: "ok" });
          };
        }
      },
    });
    const hash = await hashForTest(body);
    const first = service.setContent("first", hash);
    const second = service.setContent("second", hash);
    while (!completeWrite) await new Promise((resolve) => setTimeout(resolve, 0));
    current = false;
    completeWrite();
    expect(await decodeWrite(await first)).toEqual(Result.err({ code: "write_unknown" }));
    expect(await decodeWrite(await second)).toEqual(Result.err({ code: "target_unavailable" }));
    expect([reads, writes]).toEqual([1, 1]);
  });

  test("preserves read errors, malformed results, ready identity checks, and unsupported versions", async () => {
    const errorService = createEditorService({
      timeoutMs: 10,
      invoke(request) {
        request.errCb({ reason: "rejected" });
      },
    });
    expect(await decodeContent(await errorService.getContent())).toEqual(
      Result.err({ code: "page_failed" }),
    );

    const malformed = createEditorService({
      timeoutMs: 10,
      invoke(request) {
        if (request.apiName === "mp_editor_get_isready")
          request.sucCb({ isReady: true, isNew: true });
        else request.sucCb({ content: 3 });
      },
    });
    expect(await decodeContent(await malformed.getContent())).toEqual(
      Result.err({ code: "page_failed" }),
    );

    const legacy = createEditorService({
      timeoutMs: 10,
      invoke(request) {
        request.sucCb({ isReady: true, isNew: false });
      },
    });
    expect(await decodeReady(await legacy.ready())).toEqual(
      Result.err({ code: "unsupported_editor" }),
    );

    const ambiguous = createEditorService({
      timeoutMs: 10,
      invoke(request) {
        request.sucCb({ isReady: true });
      },
    });
    expect(await decodeReady(await ambiguous.ready())).toEqual(
      Result.err({ code: "identity_unavailable" }),
    );
  });
});
