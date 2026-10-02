import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { Token } from "@nexus-js/core";
import { Result } from "better-result";
import {
  contentStatusResultCodec,
  type ContentStatusError,
  listDraftsResultCodec,
  type DraftPageError,
  homeIsReadyResultCodec,
  type HomePageError,
} from "../../extension/src/background-contracts";
import {
  articleCandidateSchema,
  articleInputSchema,
  articleReferenceSchema,
  articleResultSchema,
  bodySchema,
  bodyHashSchema,
  connectionStatusSchema,
  type ConnectionService,
  type ResultProtocolError,
  type ServiceError,
  createPairingSubprotocols,
  type ConnectionStatus,
  type WorkspaceWireResult,
  reloadResultCodec,
  type WorkspaceRemote,
  type WorkspaceService,
  workspaceErrorSchema,
  workspaceResultCodec,
  workspaceToken,
  writeBodyInputSchema,
} from "../src/index";

function expectType<T>(_value: T): void {}

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type CodecError<TCodec> = TCodec extends {
  deserialize(value: unknown): Promise<import("better-result").Result<unknown, infer E>>;
}
  ? E
  : never;

describe("workspace contracts", () => {
  test("rejects empty article candidates and references", () => {
    expect(v.safeParse(articleCandidateSchema, "candidate-1").success).toBe(true);
    expect(v.safeParse(articleCandidateSchema, "").success).toBe(false);
    expect(v.safeParse(articleReferenceSchema, "article-1").success).toBe(true);
    expect(v.safeParse(articleReferenceSchema, "\n").success).toBe(false);
  });

  test("allows an empty HTML body and exposes structured safe errors", () => {
    expect(workspaceToken).toBeInstanceOf(Token);
    expect(workspaceToken.id).toBe("mpctl.workspace.v1");
    expect(v.safeParse(bodySchema, "").success).toBe(true);
    expect(v.safeParse(bodySchema, 1).success).toBe(false);
    expect(v.safeParse(connectionStatusSchema, { connected: false }).success).toBe(true);
    expect(v.safeParse(connectionStatusSchema, { connected: true }).success).toBe(true);
    expect(v.safeParse(connectionStatusSchema, {}).success).toBe(false);
    expect(v.safeParse(workspaceErrorSchema, { code: "write_unknown" }).success).toBe(true);
    expect(
      v.safeParse(workspaceErrorSchema, {
        code: "page_failed",
        stage: "native_target_missing",
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(workspaceErrorSchema, { code: "page_failed", stage: "raw_exception" }).success,
    ).toBe(false);
    expect(
      v.safeParse(workspaceErrorSchema, { code: "write_unknown", token: "secret" }).success,
    ).toBe(false);
    expect(v.safeParse(workspaceErrorSchema, { code: "other" }).success).toBe(false);
  });

  test("validates exact workspace inputs and safe article results", () => {
    expect(v.safeParse(articleInputSchema, { article: "a1" }).success).toBe(true);
    expect(v.safeParse(articleInputSchema, { article: "a1", tabId: 4 }).success).toBe(false);
    const bodyHash = "0".repeat(64);
    expect(
      v.safeParse(writeBodyInputSchema, { article: "a1", html: "", expectedHash: bodyHash })
        .success,
    ).toBe(true);
    expect(
      v.safeParse(writeBodyInputSchema, { article: "a1", html: "", expectedHash: "stale" }).success,
    ).toBe(false);
    expect(v.safeParse(bodyHashSchema, bodyHash).success).toBe(true);
    expect(
      v.safeParse(articleResultSchema, { article: "a1", title: "Title", bodyHash }).success,
    ).toBe(true);
    expect(
      v.safeParse(articleResultSchema, { article: "a1", title: "Title", documentId: "secret" })
        .success,
    ).toBe(false);
  });

  test("round-trips genuine Results over JSON and rejects malformed wire envelopes", async () => {
    const body = { html: "<p>draft</p>", bodyHash: "0".repeat(64) };
    const encoded = await workspaceResultCodec.serialize(Result.ok(body));
    expect(Result.isOk(encoded)).toBe(true);
    if (Result.isError(encoded)) throw new Error("valid result failed serialization");
    const transported: unknown = JSON.parse(JSON.stringify(encoded.value));
    const decoded = await workspaceResultCodec.deserialize(transported);
    expect(Result.isOk(decoded)).toBe(true);
    if (Result.isError(decoded)) throw new Error("valid envelope failed deserialization");
    expect(decoded.value).toEqual(body);
    expect(decoded.status).toBe("ok");
    expect(typeof decoded.map).toBe("function");

    const failure = await workspaceResultCodec.deserialize({
      status: "error",
      error: { code: "page_failed", stage: "native_target_missing" },
    });
    expect(Result.isError(failure)).toBe(true);
    if (Result.isError(failure))
      expect(failure.error).toEqual({
        code: "page_failed",
        stage: "native_target_missing",
      });

    for (const malformed of [
      { status: "ok", value: { html: "bad", bodyHash: "stale" } },
      { status: "error", error: { code: "secret" } },
      { status: "maybe", value: body },
      { status: "ok", value: body, extra: true },
    ]) {
      const invalid = await workspaceResultCodec.deserialize(malformed);
      expect(Result.isError(invalid)).toBe(true);
      if (Result.isError(invalid))
        expect(invalid.error).toEqual({ code: "invalid_result_envelope" });
    }
    expectType<WorkspaceWireResult<{ html: string; bodyHash: string }>>(
      null as unknown as Awaited<ReturnType<WorkspaceService["readBody"]>>,
    );
    expect(typeof decoded.map).toBe("function");
    expectType<Promise<WorkspaceWireResult<{ html: string; bodyHash: string }>>>(
      null as unknown as ReturnType<WorkspaceService["readBody"]>,
    );
    expectType<Promise<WorkspaceWireResult<{ bodyHash: string }>>>(
      null as unknown as ReturnType<WorkspaceService["writeBody"]>,
    );
    expectType<Promise<WorkspaceWireResult<ConnectionStatus>>>(
      null as unknown as ReturnType<ConnectionService["getStatus"]>,
    );
    expectType<WorkspaceWireResult<{ html: string; bodyHash: string }>>(
      null as unknown as Awaited<ReturnType<WorkspaceRemote["readBody"]>>,
    );
    expectType<WorkspaceWireResult<{ bodyHash: string }>>(
      null as unknown as Awaited<ReturnType<WorkspaceRemote["writeBody"]>>,
    );
  });

  test("preserves void success through JSON serialization", async () => {
    const encoded = await reloadResultCodec.serialize(Result.ok(undefined));
    if (Result.isError(encoded)) throw new Error("valid void result failed serialization");
    const transported: unknown = JSON.parse(JSON.stringify(encoded.value));
    const decoded = await reloadResultCodec.deserialize(transported);
    expect(Result.isOk(decoded)).toBe(true);
    if (Result.isOk(decoded)) expect(decoded.value).toEqual(undefined);
  });

  test("keeps extension codec errors narrowed to each service domain", () => {
    expectType<
      Assert<Equal<CodecError<typeof contentStatusResultCodec>, ServiceError<ContentStatusError>>>
    >(true);
    expectType<
      Assert<Equal<CodecError<typeof listDraftsResultCodec>, ServiceError<DraftPageError>>>
    >(true);
    expectType<
      Assert<Equal<CodecError<typeof homeIsReadyResultCodec>, ServiceError<HomePageError>>>
    >(true);
    expectType<Result<unknown, ServiceError<ContentStatusError>>>(
      null as unknown as Awaited<ReturnType<typeof contentStatusResultCodec.deserialize>>,
    );
    expectType<Result<unknown, ServiceError<DraftPageError>>>(
      null as unknown as Awaited<ReturnType<typeof listDraftsResultCodec.deserialize>>,
    );
    expectType<Result<unknown, ServiceError<HomePageError>>>(
      null as unknown as Awaited<ReturnType<typeof homeIsReadyResultCodec.deserialize>>,
    );
  });

  test("returns serialization failures as compact protocol Err values", async () => {
    const result = await workspaceResultCodec.serialize(
      Result.ok({ html: "wrong", bodyHash: "invalid" }),
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) expect(result.error).toEqual({ code: "invalid_result_envelope" });

    const protocolError: ResultProtocolError = { code: "invalid_result_envelope" };
    const encodedError = await workspaceResultCodec.serialize(Result.err(protocolError));
    expect(Result.isOk(encodedError)).toBe(true);
    if (Result.isOk(encodedError)) {
      expect(encodedError.value).toEqual({
        status: "error",
        error: { code: "invalid_result_envelope" },
      });
    }
  });

  test("formats valid credentials and returns a compact error for invalid ones", () => {
    const valid = createPairingSubprotocols("abcDEF_123-~");
    expect(Result.isOk(valid)).toBe(true);
    if (Result.isOk(valid)) expect(valid.value).toEqual(["mpctl.v1", "mpctl.pair.abcDEF_123-~"]);

    const invalidCredentials = ["credential with spaces", "", "bad/credential", "bad\ncredential"];
    for (const credential of invalidCredentials) {
      const invalid = createPairingSubprotocols(credential);
      expect(Result.isError(invalid)).toBe(true);
      if (Result.isError(invalid))
        expect(invalid.error).toEqual({ code: "invalid_pairing_credential" });
    }
  });
});
