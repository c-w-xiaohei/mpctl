import { Token } from "@nexus-js/core";
import type { SerializedResult } from "better-result";
import * as v from "valibot";
import { nativeReceiptSchema } from "./page-contracts";
import {
  articleFieldUpdateInputSchema,
  assetFileLimits,
  assetPayloadSchema,
  uploadEffectSchema,
  articleCoverHashSchema,
  createServiceResultCodec,
  fieldsEffectSchema,
  coverEffectSchema,
  saveEffectSchema,
  operationIdSchema,
  ledgerIdSchema,
  failureSchema,
  readFailureSchema,
  type ServiceError,
} from "@mpctl/contracts";

export { backgroundControlToken, type BackgroundControlService } from "@mpctl/contracts";

export const contentStatusErrorCodes = ["route_changed", "page_failed"] as const;
export const contentStatusErrorSchema = v.strictObject({
  code: v.picklist(contentStatusErrorCodes),
  readFailure: v.optional(readFailureSchema),
});
export type ContentStatusError = v.InferOutput<typeof contentStatusErrorSchema>;
export type ContentStatusResult<T> = import("better-result").Result<
  T,
  ServiceError<ContentStatusError>
>;
export type ContentStatusWireResult<T> = SerializedResult<T, ServiceError<ContentStatusError>>;

export const draftPageErrorCodes = [
  "route_changed",
  "draft_unavailable",
  "not_logged_in",
  "page_failed",
] as const;
export const draftPageErrorSchema = v.pipe(
  v.strictObject({
    code: v.picklist([
      ...draftPageErrorCodes,
      "content_conflict",
      "invalid_fields",
      "field_update_unknown",
      "target_unavailable",
    ]),
    readFailure: v.optional(readFailureSchema),
  }),
);
export type DraftPageError = v.InferOutput<typeof draftPageErrorSchema>;
export type DraftPageResult<T> = import("better-result").Result<T, ServiceError<DraftPageError>>;
export type DraftPageWireResult<T> = SerializedResult<T, ServiceError<DraftPageError>>;

export const homePageErrorCodes = ["control_unavailable", "page_failed"] as const;
export const homePageErrorSchema = v.strictObject({
  code: v.picklist(homePageErrorCodes),
  readFailure: v.optional(readFailureSchema),
});
export type HomePageError = v.InferOutput<typeof homePageErrorSchema>;
export type HomePageResult<T> = import("better-result").Result<T, ServiceError<HomePageError>>;
export type HomePageWireResult<T> = SerializedResult<T, ServiceError<HomePageError>>;

function resultCodec<
  ESchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(errorSchema: ESchema, valueSchema: TSchema) {
  return createServiceResultCodec(valueSchema, errorSchema);
}

const statusSchema = v.strictObject({
  state: v.picklist(["ready", "not_logged_in", "loading"]),
  route: v.string(),
  documentReady: v.boolean(),
});
const draftsSchema = v.array(v.strictObject({ candidate: v.string(), title: v.string() }));
const draftValidationSchema = v.strictObject({ valid: v.boolean(), title: v.string() });
const countSchema = v.number();
const booleanSchema = v.boolean();
const articleFieldsSchema = v.strictObject({
  title: v.string(),
  author: v.string(),
  summary: v.string(),
});
export function fieldsRequestSignature(
  fields: v.InferOutput<typeof articleFieldUpdateInputSchema>,
  expectedHash: string,
): string {
  return JSON.stringify([
    "fields",
    ...(["title", "author", "summary"] as const).map((name) => [
      fields[name] !== undefined,
      fields[name] ?? null,
    ]),
    expectedHash,
  ]);
}
export async function fieldsRequestDigest(
  fields: v.InferOutput<typeof articleFieldUpdateInputSchema>,
  expectedHash: string,
): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(fieldsRequestSignature(fields, expectedHash)),
  );
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export const fieldsExecutionSchema = v.strictObject({
  operationId: operationIdSchema,
  executorId: ledgerIdSchema,
});
export type FieldsExecution = v.InferOutput<typeof fieldsExecutionSchema>;
export const fieldsReceiptSchema = nativeReceiptSchema(fieldsEffectSchema);
export type FieldsReceipt = v.InferOutput<typeof fieldsReceiptSchema>;
export async function coverRequestDigest(asset: string, expectedHash: string): Promise<string> {
  return requestDigest(["cover", asset, expectedHash]);
}
export const bodyCoverExecutionSchema = v.strictObject({
  operationId: operationIdSchema,
  executorId: ledgerIdSchema,
  bodyImage: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  expectedBodyHash: articleCoverHashSchema,
  expectedCoverHash: articleCoverHashSchema,
});
export type BodyCoverExecution = v.InferOutput<typeof bodyCoverExecutionSchema>;
export async function bodyCoverRequestDigest(
  input: Pick<BodyCoverExecution, "bodyImage" | "expectedBodyHash" | "expectedCoverHash">,
): Promise<string> {
  return requestDigest([
    "cover",
    "body",
    input.bodyImage,
    input.expectedBodyHash,
    input.expectedCoverHash,
  ]);
}
export async function saveRequestDigest(input: {
  expectedBodyHash: string;
  expectedFieldsHash: string;
  expectedCoverHash: string;
}): Promise<string> {
  return requestDigest([
    "save",
    input.expectedBodyHash,
    input.expectedFieldsHash,
    input.expectedCoverHash,
  ]);
}
async function requestDigest(values: unknown[]): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(values)),
  );
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export const coverExecutionSchema = v.strictObject({
  operationId: operationIdSchema,
  executorId: ledgerIdSchema,
  asset: v.pipe(v.string(), v.minLength(1)),
});
export type CoverExecution = v.InferOutput<typeof coverExecutionSchema>;
export const saveExecutionSchema = v.strictObject({
  operationId: operationIdSchema,
  executorId: ledgerIdSchema,
  expectedBodyHash: articleCoverHashSchema,
  expectedFieldsHash: articleCoverHashSchema,
  expectedCoverHash: articleCoverHashSchema,
});
export type SaveExecution = v.InferOutput<typeof saveExecutionSchema>;
export const coverReceiptSchema = nativeReceiptSchema(coverEffectSchema);
export const saveReceiptSchema = v.pipe(
  nativeReceiptSchema(saveEffectSchema),
  v.check((r) => r.effect.persistence === "unverified"),
);
export type CoverReceipt = v.InferOutput<typeof coverReceiptSchema>;
export type SaveReceipt = v.InferOutput<typeof saveReceiptSchema>;
export const coverWriteResultCodec = resultCodec(failureSchema, coverReceiptSchema);
export const coverReceiptResultCodec = resultCodec(failureSchema, v.nullable(coverReceiptSchema));
export const saveWriteResultCodec = resultCodec(failureSchema, saveReceiptSchema);
export const saveReceiptResultCodec = resultCodec(failureSchema, v.nullable(saveReceiptSchema));
export const coverSaveReceiptResultCodec = resultCodec(
  failureSchema,
  v.nullable(v.union([coverReceiptSchema, saveReceiptSchema])),
);
const coverErrorSchema = v.strictObject({
  code: v.picklist([
    "not_logged_in",
    "target_unavailable",
    "route_changed",
    "page_failed",
    "cover_unavailable",
    "hash_failed",
    "cover_input_unavailable",
    "cover_update_unknown",
    "unsupported",
    "content_conflict",
  ]),
  baselineHash: v.optional(articleCoverHashSchema),
  cleanupFailed: v.optional(v.boolean()),
  readFailure: v.optional(readFailureSchema),
});
const urlSchema = v.string();

export const contentStatusResultCodec = resultCodec(contentStatusErrorSchema, statusSchema);
export const listDraftsResultCodec = resultCodec(draftPageErrorSchema, draftsSchema);
export const validateDraftResultCodec = resultCodec(draftPageErrorSchema, draftValidationSchema);
export const currentItemCountResultCodec = resultCodec(draftPageErrorSchema, countSchema);
export const articleFieldsResultCodec = resultCodec(draftPageErrorSchema, articleFieldsSchema);
export const articleFieldUpdateResultCodec = resultCodec(failureSchema, fieldsReceiptSchema);
export const fieldsReceiptResultCodec = resultCodec(failureSchema, v.nullable(fieldsReceiptSchema));
export const fieldsIdentityResultCodec = resultCodec(
  failureSchema,
  v.strictObject({ executorId: ledgerIdSchema }),
);
export const homeIsReadyResultCodec = resultCodec(homePageErrorSchema, booleanSchema);
export const openDraftListResultCodec = resultCodec(homePageErrorSchema, urlSchema);

export interface ContentStatusService {
  status(): Promise<ContentStatusWireResult<v.InferOutput<typeof statusSchema>>>;
}

export const contentStatusToken = new Token<ContentStatusService>(
  "mpctl.extension.content-status.v1",
);

export interface DraftPageService {
  listDrafts(): Promise<DraftPageWireResult<v.InferOutput<typeof draftsSchema>>>;
  validateDraft(
    candidate: string,
  ): Promise<DraftPageWireResult<v.InferOutput<typeof draftValidationSchema>>>;
  currentItemCount(): Promise<DraftPageWireResult<number>>;
}

export interface ArticleFieldsService {
  readArticleFields(): Promise<DraftPageWireResult<v.InferOutput<typeof articleFieldsSchema>>>;
  identity(): Promise<
    SerializedResult<
      { executorId: string },
      import("@mpctl/contracts").ServiceError<import("@mpctl/contracts").Failure>
    >
  >;
  updateArticleFields(
    fields: v.InferOutput<typeof articleFieldUpdateInputSchema>,
    expectedHash: string,
    execution: FieldsExecution,
  ): Promise<
    SerializedResult<
      FieldsReceipt,
      import("@mpctl/contracts").ServiceError<import("@mpctl/contracts").Failure>
    >
  >;
  getReceipt(
    operationId: string,
  ): Promise<
    SerializedResult<
      FieldsReceipt | null,
      import("@mpctl/contracts").ServiceError<import("@mpctl/contracts").Failure>
    >
  >;
}

export const articleFieldsToken = new Token<ArticleFieldsService>(
  "mpctl.extension.article-fields.v1",
);

const materialPageErrorSchema = v.strictObject({
  code: v.picklist([
    "not_logged_in",
    "target_unavailable",
    "route_changed",
    "page_failed",
    "dialog_unavailable",
    "library_open_unknown",
    "cleanup_failed",
    "invalid_payload",
    "asset_ambiguous",
    "asset_list_failed",
    "asset_upload_unknown",
  ]),
  cleanupFailed: v.optional(v.literal(true)),
  readFailure: v.optional(readFailureSchema),
  ended: v.optional(v.boolean()),
  failure: v.optional(failureSchema),
});
const materialSnapshotSchema = v.strictObject({
  scope: v.literal("visible-page"),
  cards: v.array(
    v.strictObject({
      filename: v.pipe(v.string(), v.minLength(1), v.maxLength(assetFileLimits.maxFilenameLength)),
      thumbnailUrl: v.optional(v.pipe(v.string(), v.url())),
    }),
  ),
});
export type MaterialPageError = v.InferOutput<typeof materialPageErrorSchema>;
export type MaterialPageWireResult<T> = SerializedResult<T, ServiceError<MaterialPageError>>;
export const materialListResultCodec = resultCodec(materialPageErrorSchema, materialSnapshotSchema);
export const uploadReceiptSchema = nativeReceiptSchema(uploadEffectSchema);
export type UploadReceipt = v.InferOutput<typeof uploadReceiptSchema>;
export const uploadExecutionSchema = fieldsExecutionSchema;
export type UploadExecution = FieldsExecution;
export const materialUploadResultCodec = resultCodec(failureSchema, uploadReceiptSchema);
export const uploadReceiptResultCodec = resultCodec(failureSchema, v.nullable(uploadReceiptSchema));
export const materialIdentityResultCodec = fieldsIdentityResultCodec;
export const articleCoverHashResultCodec = resultCodec(coverErrorSchema, articleCoverHashSchema);
export type ArticleCoverPageWireResult<T> = SerializedResult<
  T,
  ServiceError<v.InferOutput<typeof coverErrorSchema>>
>;
export interface ArticleCoverPageService {
  identity(): Promise<
    SerializedResult<{ executorId: string }, ServiceError<import("@mpctl/contracts").Failure>>
  >;
  getReceipt(
    id: string,
  ): Promise<
    SerializedResult<
      CoverReceipt | SaveReceipt | null,
      ServiceError<import("@mpctl/contracts").Failure>
    >
  >;
  read(): Promise<ArticleCoverPageWireResult<string>>;
  set(
    candidate: { filename: string; thumbnailUrl: string },
    expectedHash: string,
    execution: CoverExecution,
  ): Promise<SerializedResult<CoverReceipt, ServiceError<import("@mpctl/contracts").Failure>>>;
  save(
    execution: SaveExecution,
  ): Promise<SerializedResult<SaveReceipt, ServiceError<import("@mpctl/contracts").Failure>>>;
}
export const articleCoverPageToken = new Token<ArticleCoverPageService>(
  "mpctl.extension.article-cover-page.v1",
);
export interface MaterialPageService {
  list(): Promise<MaterialPageWireResult<v.InferOutput<typeof materialSnapshotSchema>>>;
  identity(): Promise<
    SerializedResult<{ executorId: string }, ServiceError<import("@mpctl/contracts").Failure>>
  >;
  getReceipt(
    id: string,
  ): Promise<
    SerializedResult<UploadReceipt | null, ServiceError<import("@mpctl/contracts").Failure>>
  >;
  upload(
    payload: v.InferOutput<typeof assetPayloadSchema>,
    execution: UploadExecution,
  ): Promise<SerializedResult<UploadReceipt, ServiceError<import("@mpctl/contracts").Failure>>>;
}
export const materialPageToken = new Token<MaterialPageService>("mpctl.extension.material-page.v1");

export const draftPageToken = new Token<DraftPageService>("mpctl.extension.draft-page.v1");

export interface HomePageService {
  isReady(): Promise<HomePageWireResult<boolean>>;
  openDraftList(): Promise<HomePageWireResult<string>>;
}

export const homePageToken = new Token<HomePageService>("mpctl.extension.home-page.v1");
