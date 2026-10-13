import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { Token } from "@nexus-js/core";
import { Result } from "better-result";
import { bodyReceiptSchema } from "../../extension/src/page-contracts";
import {
  fieldsReceiptSchema,
  uploadReceiptSchema,
  coverReceiptSchema,
  saveReceiptSchema,
} from "../../extension/src/background-contracts";
import {
  contentStatusResultCodec,
  type ContentStatusError,
  listDraftsResultCodec,
  type DraftPageError,
  homeIsReadyResultCodec,
  type HomePageError,
  articleFieldUpdateResultCodec as providerFieldsCodec,
  articleCoverHashResultCodec as providerCoverCodec,
  coverWriteResultCodec,
  saveWriteResultCodec,
  materialListResultCodec,
} from "../../extension/src/background-contracts";
import {
  pageEditorWriteResultCodec,
  pageEditorContentResultCodec,
  pageEditorReadyResultCodec,
} from "../../extension/src/page-contracts";
import {
  operationResultCodec,
  createOperationId,
  operationSnapshotSchema,
  updateFieldsInputSchema,
  fieldsEffectSchema,
  articleNewInputSchema,
  articleOpenInputSchema,
} from "../src/index";

test("specific native receipt envelopes retain strict effect, identity and terminal rules", () => {
  const fields = {
    outcome: "confirmed",
    requested: ["author"],
    attempted: ["author"],
    confirmed: ["author"],
    unknown: [],
    fieldsHash: "a".repeat(64),
  };
  const effects = [
    { outcome: "confirmed", bodyHash: "a".repeat(64) },
    fields,
    { outcome: "confirmed", filename: "x.png", thumbnailUrl: "https://mmbiz.qpic.cn/x" },
    { cover: true, outcome: "confirmed", coverHash: "a".repeat(64) },
    { outcome: "confirmed", persistence: "unverified" },
  ];
  const schemas = [
    bodyReceiptSchema,
    fieldsReceiptSchema,
    uploadReceiptSchema,
    coverReceiptSchema,
    saveReceiptSchema,
  ];
  for (const [index, schema] of schemas.entries()) {
    const receipt = {
      operationId: createOperationId(crypto.randomUUID()),
      executorId: crypto.randomUUID(),
      requestDigest: "a".repeat(64),
      effect: effects[index],
      ended: true,
      result: { status: "ok", value: {} },
    };
    expect(v.safeParse(schema, receipt).success).toBe(true);
    expect(
      v.safeParse(schema, {
        ...receipt,
        result: { status: "error", error: { code: "cleanup_failed" } },
      }).success,
    ).toBe(true);
    for (const delta of [
      { operationId: "old" },
      { executorId: "wrong" },
      { requestDigest: "bad" },
      { extra: true },
      { result: undefined },
      { ended: false },
      { effect: { ...effects[index], outcome: "not_dispatched" } },
    ])
      expect(v.safeParse(schema, { ...receipt, ...delta }).success).toBe(false);
    for (const [otherIndex, effect] of effects.entries())
      if (otherIndex !== index)
        expect(v.safeParse(schema, { ...receipt, effect }).success).toBe(false);
    expect(v.safeParse(schema, { ...receipt, ended: false, result: undefined }).success).toBe(true);
  }
});

test("body cover requires exclusive positive index and both version guards", () => {
  const input = {
    operationId: createOperationId(crypto.randomUUID()),
    article: "ephemeral:body",
    bodyImage: 1,
    expectedBodyHash: "a".repeat(64),
    expectedCoverHash: "b".repeat(64),
  };
  expect(v.safeParse(articleCoverSetInputSchema, input).success).toBe(true);
  for (const bodyImage of [0, -1, 1.5, Infinity, "1"])
    expect(v.safeParse(articleCoverSetInputSchema, { ...input, bodyImage }).success).toBe(false);
  expect(v.safeParse(articleCoverSetInputSchema, { ...input, asset: "old" }).success).toBe(false);
  const { expectedBodyHash: _, ...incomplete } = input;
  expect(v.safeParse(articleCoverSetInputSchema, incomplete).success).toBe(false);
});

test("navigation history stays handle-free; only confirmed live replies may carry a matching reference", async () => {
  const operationId = createOperationId(crypto.randomUUID());
  expect(v.safeParse(articleNewInputSchema, {}).success).toBe(false);
  expect(v.safeParse(articleOpenInputSchema, "A").success).toBe(false);
  expect(v.safeParse(articleOpenInputSchema, { operationId, candidate: "A" }).success).toBe(true);
  const reply = {
    snapshot: {
      operationId,
      operation: "new",
      state: "settled",
      effect: {
        navigation: true,
        outcome: "confirmed",
        pageCreated: false,
        auxiliaryCreated: [],
        targetBound: true,
        bodyHash: "a".repeat(64),
      },
      result: { status: "ok", value: {} },
    },
  };
  expect((await operationResultCodec.deserialize({ status: "ok", value: reply })).isOk()).toBe(
    true,
  );
  expect(
    (
      await operationResultCodec.deserialize({
        status: "ok",
        value: {
          snapshot: { ...reply.snapshot, result: { status: "ok", value: { article: "old" } } },
        },
      })
    ).isErr(),
  ).toBe(true);
  expect(
    v.safeParse(operationSnapshotSchema, {
      ...reply.snapshot,
      effect: { ...reply.snapshot.effect, targetBound: false },
    }).success,
  ).toBe(false);
  const live = { ...reply, article: "ephemeral:live", bodyHash: "a".repeat(64) };
  expect((await operationResultCodec.deserialize({ status: "ok", value: live })).isOk()).toBe(true);
  for (const change of [
    { bodyHash: "b".repeat(64) },
    { bodyHash: undefined },
    { issue: { failure: { code: "storage_failed" } } },
    {
      snapshot: {
        ...reply.snapshot,
        state: "unresolved",
        result: { status: "error", error: { code: "operation_unresolved" } },
      },
    },
  ])
    expect(
      (
        await operationResultCodec.deserialize({ status: "ok", value: { ...live, ...change } })
      ).isErr(),
    ).toBe(true);
});
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
  articleFieldsSchema,
  articleFieldsResultCodec,
  articleFieldUpdateInputSchema,
  articleFieldLimits,
  articleCheckResultSchema,
  articleCheckResultCodec,
  assetListResultCodec,
  assetUploadInputSchema,
  assetFileLimits,
  articleCoverHashSchema,
  articleCoverResultCodec,
  articleSaveInputSchema,
  articleCoverSetInputSchema,
  protocolVersion,
  connectResultCodec,
  disconnectResultCodec,
  controlStatusResultCodec,
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
  test("B-F1/G1 fields require actual requested values and bound effect subsets", () => {
    const input = {
      operationId: createOperationId(crypto.randomUUID()),
      article: "ref",
      expectedHash: "a".repeat(64),
    };
    expect(v.safeParse(updateFieldsInputSchema, { ...input, fields: { author: "" } }).success).toBe(
      true,
    );
    expect(
      v.safeParse(updateFieldsInputSchema, { ...input, fields: { author: undefined } }).success,
    ).toBe(false);
    expect(v.safeParse(updateFieldsInputSchema, { ...input, fields: {} }).success).toBe(false);
    const partial = {
      outcome: "partial",
      requested: ["title", "author", "summary"],
      attempted: ["title", "author"],
      confirmed: ["title"],
      unknown: ["author"],
    };
    expect(v.safeParse(fieldsEffectSchema, partial).success).toBe(true);
    for (const effect of [
      { ...partial, confirmed: ["summary"] },
      { ...partial, unknown: ["title", "author"] },
      { ...partial, attempted: ["title", "author", "title"] },
      { ...partial, attempted: ["title", "author", "summary"] },
      { ...partial, outcome: "not_dispatched" },
      { ...partial, outcome: "confirmed", fieldsHash: "b".repeat(64) },
      { ...partial, fieldsHash: "b".repeat(64) },
    ])
      expect(v.safeParse(fieldsEffectSchema, effect).success).toBe(false);
  });
  test("R3 terminal MAIN receipts require a result and confirmed success/end evidence", async () => {
    const receipt = {
      operationId: createOperationId(crypto.randomUUID()),
      executorId: crypto.randomUUID(),
      requestDigest: "a".repeat(64),
      ended: true,
      effect: { outcome: "unknown" },
    };
    for (const value of [
      receipt,
      { ...receipt, result: { status: "ok", value: {} } },
      {
        ...receipt,
        ended: false,
        effect: { outcome: "confirmed", bodyHash: "b".repeat(64) },
        result: { status: "ok", value: {} },
      },
    ]) {
      expect(await pageEditorWriteResultCodec.deserialize({ status: "ok", value })).toEqual(
        Result.err({ code: "invalid_result_envelope" }),
      );
    }
  });
  test("E3 status preserves a failed business snapshot as a successful query", async () => {
    const snapshot = {
      operationId: createOperationId(crypto.randomUUID()),
      operation: "body" as const,
      state: "settled" as const,
      effect: { outcome: "not_dispatched" as const },
      result: { status: "error" as const, error: { code: "content_conflict" as const } },
    };
    expect(await operationResultCodec.deserialize({ status: "ok", value: { snapshot } })).toEqual(
      Result.ok({ snapshot }),
    );
  });
  test("E2 impossible BODY success and pre-issue confirmation are rejected", () => {
    const base = { operationId: createOperationId(crypto.randomUUID()), operation: "body" };
    expect(
      v.safeParse(operationSnapshotSchema, {
        ...base,
        state: "settled",
        effect: { outcome: "unknown" },
        result: { status: "ok", value: {} },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(operationSnapshotSchema, {
        ...base,
        state: "accepted",
        effect: { outcome: "confirmed", bodyHash: "a".repeat(64) },
      }).success,
    ).toBe(false);
  });
  test("G1 BODY rejects the former unkeyed payload before any mutation", () => {
    expect(
      v.safeParse(writeBodyInputSchema, {
        article: "ephemeral:x",
        html: "next",
        expectedHash: "a".repeat(64),
      }).success,
    ).toBe(false);
  });
  test("G1 connected status requires its admitted ledger identity", () => {
    expect(v.safeParse(connectionStatusSchema, { connected: true }).success).toBe(false);
    expect(v.safeParse(connectionStatusSchema, { connected: false }).success).toBe(true);
  });
  test("cover hashes, cover receipts and save versions use strict independent schemas", async () => {
    const hash = "a".repeat(64);
    expect(v.safeParse(articleCoverHashSchema, hash).success).toBe(true);
    expect(v.safeParse(articleCoverHashSchema, hash.toUpperCase()).success).toBe(false);
    expect(
      v.safeParse(articleSaveInputSchema, {
        operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        article: "ephemeral:x",
        expectedBodyHash: hash,
        expectedFieldsHash: hash,
        expectedCoverHash: hash,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(articleSaveInputSchema, {
        operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        article: "ephemeral:x",
        expectedBodyHash: hash,
        expectedFieldsHash: hash,
        expectedCoverHash: hash,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      await articleCoverResultCodec.deserialize({ status: "ok", value: { coverHash: hash } }),
    ).toEqual(Result.ok({ coverHash: hash }));
  });
  test("asset operations expose a bounded visible-page snapshot and strict upload receipt", async () => {
    expect(assetFileLimits).toEqual({ maxBytes: 2 * 1024 * 1024, maxFilenameLength: 255 });
    expect(
      v.safeParse(assetUploadInputSchema, {
        operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        article: "article-1",
        blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
        filename: "image.png",
        mimeType: "image/png",
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(assetUploadInputSchema, {
        article: "article-1",
        blob: "base64",
        filename: "image.png",
        mimeType: "image/png",
      }).success,
    ).toBe(false);
    const listed = await assetListResultCodec.deserialize({
      status: "ok",
      value: {
        scope: "visible-page",
        cards: [
          { asset: "ephemeral:x", filename: "image.png", thumbnailUrl: "https://mmbiz.qpic.cn/x" },
        ],
      },
    });
    expect(Result.isOk(listed)).toBe(true);
    expect(
      await assetListResultCodec.deserialize({
        status: "ok",
        value: { scope: "account", cards: [] },
      }),
    ).toEqual(Result.err({ code: "invalid_result_envelope" }));
    expect(
      await operationResultCodec.deserialize({
        status: "ok",
        value: {
          asset: "ephemeral:x",
          filename: "image.png",
          thumbnailUrl: "https://mmbiz.qpic.cn/x",
          originalUrl: "https://mmbiz.qpic.cn/o",
        },
      }),
    ).toEqual(Result.err({ code: "invalid_result_envelope" }));
    const unknownUpload = await operationResultCodec.deserialize({
      status: "error",
      error: { code: "asset_upload_unknown", assetCreated: true, cleanupFailed: true },
    });
    expect(unknownUpload).toEqual(Result.err({ code: "invalid_result_envelope" }));
  });

  test("accepts title, author, and summary partial updates within declared UTF-16 limits", () => {
    expect(v.safeParse(articleFieldUpdateInputSchema, { author: "" }).success).toBe(true);
    expect(v.safeParse(articleFieldUpdateInputSchema, { summary: "🌱".repeat(60) }).success).toBe(
      true,
    );
    expect(v.safeParse(articleFieldUpdateInputSchema, { summary: "🌱".repeat(61) }).success).toBe(
      false,
    );
    expect(v.safeParse(articleFieldUpdateInputSchema, { title: "🌱".repeat(32) }).success).toBe(
      true,
    );
    for (const title of ["x".repeat(65), "a\nb", "a\0b"])
      expect(v.safeParse(articleFieldUpdateInputSchema, { title }).success).toBe(false);
    expect(v.safeParse(articleFieldUpdateInputSchema, { title: "" }).success).toBe(true);
    expect(
      v.safeParse(articleFieldUpdateInputSchema, { title: "a", author: "b", summary: "c" }).success,
    ).toBe(true);
    expect(v.safeParse(articleFieldUpdateInputSchema, {}).success).toBe(false);
    expect(v.safeParse(articleFieldUpdateInputSchema, { typo: "unsupported" }).success).toBe(false);
    expect(v.safeParse(articleFieldUpdateInputSchema, { author: null }).success).toBe(false);
    expect(articleFieldLimits).toEqual({ author: 8, summary: 120 });
  });

  test("upload failure diagnostics serialize stage/cause/outcome without accepting raw secrets", async () => {
    const failure = {
      code: "asset_upload_unknown" as const,
      cause: { at: "bg.page_call" as const, kind: "nexus" as const, code: "E_CALL_TIMEOUT" },
    };
    const encoded = await operationResultCodec.serialize(Result.err({ failure }));
    if (Result.isError(encoded)) throw new Error("encoding failed");
    expect(await operationResultCodec.deserialize(encoded.value)).toEqual(Result.err({ failure }));
    expect(
      await operationResultCodec.deserialize({
        status: "error",
        error: {
          failure: { ...failure, cause: { ...failure.cause, code: "https://private.test/token" } },
        },
      }),
    ).toEqual(Result.err({ code: "invalid_result_envelope" }));
  });
  test("rejects duplicate and unbounded field names in update outcomes", () => {
    expect(
      v.safeParse(workspaceErrorSchema, {
        code: "field_update_unknown",
        updatedFields: ["author", "author"],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(workspaceErrorSchema, {
        code: "field_update_unknown",
        unknownFields: ["author", "summary", "author"],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(workspaceErrorSchema, {
        code: "field_update_unknown",
        unknownFields: ["title", "author", "summary"],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(workspaceErrorSchema, {
        code: "field_update_unknown",
        unknownFields: ["title", "author", "summary", "title"],
      }).success,
    ).toBe(false);
  });
  test("check contract uses only finite unique issue picklists and exact result keys", async () => {
    const value = { errors: ["title_empty"], warnings: ["cover_unchecked"] };
    expect(v.safeParse(articleCheckResultSchema, value).success).toBe(true);
    expect(v.safeParse(articleCheckResultSchema, { ...value, ready: true }).success).toBe(false);
    expect(
      v.safeParse(articleCheckResultSchema, { errors: ["unknown"], warnings: [] }).success,
    ).toBe(false);
    expect(
      v.safeParse(articleCheckResultSchema, {
        errors: ["title_empty", "title_empty"],
        warnings: [],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(articleCheckResultSchema, {
        errors: ["title_empty", "title_invalid", "author_invalid", "summary_invalid", "body_empty"],
        warnings: [],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(articleCheckResultSchema, { errors: ["cover_unchecked"], warnings: [] }).success,
    ).toBe(false);
    expect(
      v.safeParse(articleCheckResultSchema, { errors: [], warnings: ["title_empty"] }).success,
    ).toBe(false);
    expect(
      v.safeParse(articleCheckResultSchema, {
        errors: [],
        warnings: [
          "body_semantics_unchecked",
          "summary_platform_default_unchecked",
          "cover_unchecked",
          "platform_settings_unchecked",
          "body_semantics_unchecked",
        ],
      }).success,
    ).toBe(false);
    expect(await articleCheckResultCodec.deserialize({ status: "ok", value })).toEqual(
      Result.ok(value),
    );
  });
  test("strictly validates fields-only snapshots and result envelopes", async () => {
    const fields = { title: " t ", author: "作者", summary: "", fieldsHash: "a".repeat(64) };
    expect(v.safeParse(articleFieldsSchema, fields).success).toBe(true);
    expect(v.safeParse(articleFieldsSchema, { ...fields, coverHash: "b".repeat(64) }).success).toBe(
      false,
    );
    expect(
      v.safeParse(articleFieldsSchema, { ...fields, fieldsHash: "A".repeat(64) }).success,
    ).toBe(false);
    const validResult = await articleFieldsResultCodec.deserialize({ status: "ok", value: fields });
    expect(Result.isOk(validResult)).toBe(true);
    if (Result.isOk(validResult)) expect(validResult.value).toEqual(fields);
    expect(
      await articleFieldsResultCodec.deserialize({
        status: "ok",
        value: { ...fields, body: "private" },
      }),
    ).toEqual(Result.err({ code: "invalid_result_envelope" }));
  });
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
    expect(
      v.safeParse(connectionStatusSchema, { connected: true, ledgerId: crypto.randomUUID() })
        .success,
    ).toBe(true);
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
      v.safeParse(writeBodyInputSchema, {
        operationId: createOperationId(crypto.randomUUID()),
        article: "a1",
        html: "",
        expectedHash: bodyHash,
      }).success,
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
    expectType<Promise<import("../src/index").OperationWireResult>>(
      null as unknown as ReturnType<WorkspaceService["writeBody"]>,
    );
    expectType<Promise<WorkspaceWireResult<ConnectionStatus>>>(
      null as unknown as ReturnType<ConnectionService["getStatus"]>,
    );
    expectType<WorkspaceWireResult<{ html: string; bodyHash: string }>>(
      null as unknown as Awaited<ReturnType<WorkspaceRemote["readBody"]>>,
    );
    expectType<import("../src/index").OperationWireResult>(
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

describe("preparation operation error codecs", () => {
  const invalid = Result.err({ code: "invalid_result_envelope" });
  const cause = { kind: "runtime", causeCode: "guard_threw" } as const;
  const brokerCleanup = {
    stage: "broker_cleanup",
    kind: "runtime",
    causeCode: "broker_disconnect_failed",
  } as const;
  const read = {
    stage: "native_read",
    ...cause,
    component: "body",
    cleanup: brokerCleanup,
  } as const;
  const connection = {
    action: "connect",
    stage: "version_check",
    kind: "protocol",
    causeCode: "version_mismatch",
    cleanup: brokerCleanup,
  } as const;

  test("advertises the coordinated breaking wire version", () => {
    expect(protocolVersion).toBe("0.15.0");
  });

  test("current mutation errors reject the retired top-level forwarding shapes", async () => {
    for (const key of [
      "bodyFailure",
      "fieldsFailure",
      "coverFailure",
      "saveFailure",
      "saveConfirmed",
      "updatedFields",
      "unknownFields",
    ]) {
      const wire = { status: "error", error: { code: "page_failed" as const, [key]: true } };
      expect(await workspaceResultCodec.deserialize(wire)).toEqual(invalid);
      expect(await workspaceResultCodec.serialize(Result.err(wire.error))).toEqual(invalid);
    }
  });

  test("current Failure cause and cleanup accept the control then reject one invalid field", async () => {
    const error = {
      code: "page_failed",
      cause: { at: "content.field_edit", kind: "runtime", code: "field_setter_failed" },
      cleanup: { at: "content.history_cleanup", kind: "domain", code: "cleanup_failed" },
    } as const;
    const encoded = (await providerFieldsCodec.serialize(Result.err(error))).unwrap();
    expect(await providerFieldsCodec.deserialize(JSON.parse(JSON.stringify(encoded)))).toEqual(
      Result.err(error),
    );
    for (const key of ["cause", "cleanup"] as const) {
      for (const field of [
        { at: "unknown" },
        { kind: "exception" },
        { code: "private raw message" },
        { message: "private" },
      ]) {
        const bad = { ...error, [key]: { ...error[key], ...field } };
        expect(await providerFieldsCodec.deserialize({ status: "error", error: bad })).toEqual(
          invalid,
        );
        expect(await providerFieldsCodec.serialize(Result.err(bad))).toEqual(invalid);
      }
    }
  });

  test("current read and connection diagnostic negatives reach their own finite schemas", async () => {
    for (const [key, detail] of [
      ["readFailure", read],
      ["connectionFailure", connection],
    ] as const) {
      const error = { code: "page_failed" as const, [key]: detail };
      const encoded = (await workspaceResultCodec.serialize(Result.err(error))).unwrap();
      expect(await workspaceResultCodec.deserialize(encoded)).toEqual(Result.err(error));
      expect(await workspaceResultCodec.deserialize({ ...encoded, extra: true })).toEqual(invalid);
      for (const field of [
        { stage: "unexpected" },
        { kind: "exception" },
        { causeCode: "private raw message" },
        { url: "https://private.test" },
        { cleanup: { ...brokerCleanup, stage: "unexpected" } },
        { cleanup: { ...brokerCleanup, extra: true } },
      ]) {
        const bad = { ...error, [key]: { ...detail, ...field } };
        expect(await workspaceResultCodec.deserialize({ status: "error", error: bad })).toEqual(
          invalid,
        );
        expect(await workspaceResultCodec.serialize(Result.err(bad))).toEqual(invalid);
      }
    }
    const control = { status: "error", error: { code: "page_failed", readFailure: read } };
    expect(await workspaceResultCodec.deserialize(control)).toEqual(Result.err(control.error));
    expect(
      await workspaceResultCodec.deserialize({
        ...control,
        error: { ...control.error, readFailure: { ...read, component: "other" } },
      }),
    ).toEqual(invalid);
    expect(
      await workspaceResultCodec.deserialize({
        status: "error",
        error: { code: "page_failed", connectionFailure: { ...connection, action: "other" } },
      }),
    ).toEqual(invalid);
  });

  test("current read and control services accept their legitimate success envelopes", async () => {
    expect(
      await workspaceResultCodec.deserialize({
        status: "ok",
        value: { html: "", bodyHash: "a".repeat(64) },
      }),
    ).toEqual(Result.ok({ html: "", bodyHash: "a".repeat(64) }));
    const status = { state: "ready", route: "/editor", documentReady: true };
    expect(await contentStatusResultCodec.deserialize({ status: "ok", value: status })).toEqual(
      Result.ok(status),
    );
    expect(await homeIsReadyResultCodec.deserialize({ status: "ok", value: true })).toEqual(
      Result.ok(true),
    );
    const materials = {
      scope: "visible-page",
      cards: [{ filename: "image.png", thumbnailUrl: "https://mmbiz.qpic.cn/x" }],
    };
    expect(await materialListResultCodec.deserialize({ status: "ok", value: materials })).toEqual(
      Result.ok(materials),
    );
    expect(
      await connectResultCodec.deserialize({ status: "ok", value: { connected: true } }),
    ).toEqual(Result.ok({ connected: true }));
    expect(await providerCoverCodec.deserialize({ status: "ok", value: "a".repeat(64) })).toEqual(
      Result.ok("a".repeat(64)),
    );
  });

  test("B-S2/B-S4 native confirmation cannot manufacture verified persistence", async () => {
    const receipt = {
      operationId: createOperationId(crypto.randomUUID()),
      executorId: crypto.randomUUID(),
      requestDigest: "a".repeat(64),
      effect: { outcome: "confirmed", persistence: "unverified" },
      ended: true,
      result: { status: "ok", value: {} },
    };
    expect((await saveWriteResultCodec.deserialize({ status: "ok", value: receipt })).isOk()).toBe(
      true,
    );
    const verified = {
      outcome: "confirmed",
      persistence: "verified",
      bodyHash: "a".repeat(64),
      fieldsHash: "b".repeat(64),
      coverHash: "c".repeat(64),
    };
    expect(
      await saveWriteResultCodec.deserialize({
        status: "ok",
        value: { ...receipt, effect: verified },
      }),
    ).toEqual(invalid);
    expect(
      (
        await operationResultCodec.deserialize({
          status: "ok",
          value: {
            snapshot: {
              operationId: receipt.operationId,
              operation: "save",
              state: "settled",
              effect: verified,
              result: { status: "ok", value: {} },
            },
          },
        })
      ).isOk(),
    ).toBe(true);
    expect(
      (
        await operationResultCodec.deserialize({
          status: "ok",
          value: {
            snapshot: {
              operationId: receipt.operationId,
              operation: "save",
              state: "settled",
              effect: receipt.effect,
              result: { status: "ok", value: {} },
            },
          },
        })
      ).isOk(),
    ).toBe(true);
  });
  for (const operation of ["cover", "save"] as const) {
    test(`${operation} preserves first cause and cleanup through JSON`, async () => {
      const at = operation === "cover" ? "content.cover_confirm" : "content.save_confirm";
      const effect =
        operation === "cover"
          ? { cover: true, outcome: "confirmed", coverHash: "c".repeat(64) }
          : { outcome: "confirmed", persistence: "unverified" };
      for (const kind of ["domain", "nexus", "protocol", "runtime"] as const) {
        const error = {
          code: "page_failed",
          cause: { at, kind, code: "first_cause" },
          cleanup: {
            at: operation === "cover" ? "content.cover_cleanup" : "content.history_cleanup",
            kind: "runtime",
            code: "cleanup_failed",
          },
        };
        const reply = {
          snapshot: {
            operationId: createOperationId(crypto.randomUUID()),
            operation,
            effect,
            state: "settled",
            result: { status: "error", error },
          },
        };
        const wire = JSON.parse(JSON.stringify({ status: "ok", value: reply }));
        expect(await operationResultCodec.deserialize(wire)).toEqual(Result.ok(reply));
      }
    });
    for (const outcome of ["not_dispatched", "unknown", "confirmed"] as const)
      test(`T4 ${operation} ${outcome} cannot acquire a fake writable historical handle`, async () => {
        const effect =
          operation === "cover"
            ? {
                cover: true,
                outcome,
                ...(outcome === "confirmed" ? { coverHash: "c".repeat(64) } : {}),
              }
            : { outcome, persistence: "unverified" };
        const snapshot = {
          operationId: createOperationId(crypto.randomUUID()),
          operation,
          effect,
          state: "settled",
          result: { status: "error", error: { code: "operation_interrupted" } },
        };
        expect(
          (await operationResultCodec.deserialize({ status: "ok", value: { snapshot } })).isOk(),
        ).toBe(true);
        expect(
          await operationResultCodec.deserialize({
            status: "ok",
            value: {
              snapshot: { ...snapshot, result: { status: "ok", value: { article: "revived" } } },
            },
          }),
        ).toEqual(invalid);
      });
    test(`T4 ${operation} unkeyed payload is rejected before any execution`, () => {
      const input =
        operation === "cover"
          ? { article: "ref", asset: "asset", expectedCoverHash: "c".repeat(64) }
          : {
              article: "ref",
              expectedBodyHash: "a".repeat(64),
              expectedFieldsHash: "b".repeat(64),
              expectedCoverHash: "c".repeat(64),
            };
      expect(
        v.safeParse(
          operation === "cover" ? articleCoverSetInputSchema : articleSaveInputSchema,
          input,
        ).success,
      ).toBe(false);
    });
  }
  for (const operation of ["cover", "save"] as const)
    test(`G1 ${operation} current writer and reader reject 0.9 mutation envelopes`, async () => {
      const legacy =
        operation === "cover"
          ? { status: "ok", value: { coverHash: "c".repeat(64) } }
          : { status: "ok", value: { confirmed: true } };
      const current = operation === "cover" ? coverWriteResultCodec : saveWriteResultCodec;
      expect(await current.deserialize(legacy)).toEqual(invalid);
      const receipt = {
        operationId: createOperationId(crypto.randomUUID()),
        executorId: crypto.randomUUID(),
        requestDigest: "a".repeat(64),
        effect:
          operation === "cover"
            ? { cover: true, outcome: "confirmed", coverHash: "c".repeat(64) }
            : { outcome: "confirmed", persistence: "unverified" },
        ended: true,
        result: { status: "ok", value: {} },
      };
      expect((await current.deserialize({ status: "ok", value: receipt })).isOk()).toBe(true);
    });

  test("read and connection diagnostics accept declared components, actions and cleanup owners", async () => {
    for (const component of ["body", "fields", "cover", "assets", "drafts", "status"] as const) {
      const error = { code: "page_failed" as const, readFailure: { ...read, component } };
      const encoded = await workspaceResultCodec.serialize(Result.err(error));
      if (Result.isError(encoded)) throw new Error("read component rejected");
      expect(await workspaceResultCodec.deserialize(encoded.value)).toEqual(Result.err(error));
    }
    for (const action of ["connect", "status", "reload", "disconnect"] as const) {
      const error = {
        code: "connect_failed" as const,
        connectionFailure: { ...connection, action },
      };
      const encoded = await connectResultCodec.serialize(Result.err(error));
      if (Result.isError(encoded)) throw new Error("connection action rejected");
      expect(await connectResultCodec.deserialize(encoded.value)).toEqual(Result.err(error));
    }
    for (const [operation, stages] of Object.entries({
      readFailure: ["library_cleanup", "file_cleanup", "broker_cleanup"],
      connectionFailure: ["settings_cleanup", "broker_cleanup", "disconnect"],
    })) {
      for (const stage of stages) {
        const details = {
          readFailure: read,
          connectionFailure: connection,
        };
        const detail = Object.entries(details).find(([key]) => key === operation)?.[1];
        const error = {
          code: "page_failed" as const,
          [operation]: { ...detail, cleanup: { ...brokerCleanup, stage } },
        };
        const encoded = await workspaceResultCodec.serialize(Result.err(error));
        if (Result.isError(encoded)) throw new Error("cleanup owner rejected");
        expect(await workspaceResultCodec.deserialize(encoded.value)).toEqual(Result.err(error));
      }
    }
  });

  test("G1 workspace rejects superseded fields forwarding", async () => {
    const old = {
      status: "error",
      error: { code: "field_update_unknown", updatedFields: ["author"] },
    };
    expect(await workspaceResultCodec.deserialize(old)).toEqual(invalid);
  });

  test("G1 fields provider rejects unkeyed replies and accepts its current typed receipt", async () => {
    const legacy = { status: "ok", value: { fieldsHash: "b".repeat(64) } };
    expect(await providerFieldsCodec.deserialize(legacy)).toEqual(invalid);
    const receipt = {
      operationId: createOperationId(crypto.randomUUID()),
      executorId: crypto.randomUUID(),
      requestDigest: "a".repeat(64),
      effect: {
        outcome: "confirmed",
        requested: ["author"],
        attempted: ["author"],
        confirmed: ["author"],
        unknown: [],
        fieldsHash: "b".repeat(64),
      },
      ended: true,
      result: { status: "ok", value: {} },
    };
    expect((await providerFieldsCodec.deserialize({ status: "ok", value: receipt })).isOk()).toBe(
      true,
    );
  });

  test("keyed MAIN BODY rejects superseded unkeyed success", async () => {
    expect(
      await pageEditorWriteResultCodec.deserialize({
        status: "ok",
        value: { bodyHash: "d".repeat(64) },
      }),
    ).toEqual(invalid);
  });

  test("read diagnostics remain available on combined page/draft/cover providers and control methods", async () => {
    for (const codec of [
      pageEditorReadyResultCodec,
      pageEditorContentResultCodec,
      listDraftsResultCodec,
      articleFieldsResultCodec,
      providerCoverCodec,
    ]) {
      const encoded: Result<unknown, ResultProtocolError> = await codec.serialize(
        Result.err({ code: "page_failed" as const, readFailure: read }),
      );
      if (Result.isError(encoded)) throw new Error("read provider serialization failed");
      expect(await codec.deserialize(encoded.value)).toEqual(
        Result.err({ code: "page_failed", readFailure: read }),
      );
    }
    for (const codec of [disconnectResultCodec, controlStatusResultCodec, reloadResultCodec]) {
      const encoded: Result<unknown, ResultProtocolError> = await codec.serialize(
        Result.err({ code: "status_failed" as const, connectionFailure: connection }),
      );
      if (Result.isError(encoded)) throw new Error("control serialization failed");
      expect(await codec.deserialize(encoded.value)).toEqual(
        Result.err({ code: "status_failed", connectionFailure: connection }),
      );
    }
  });
});
