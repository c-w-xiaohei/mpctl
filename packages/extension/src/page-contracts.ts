import { Token } from "@nexus-js/core";
import type { SerializedResult } from "better-result";
import * as v from "valibot";
import type { BodyCoverExecution, CoverReceipt } from "./background-contracts";
import {
  createServiceResultCodec,
  readFailureSchema,
  bodyEffectSchema,
  operationResultSchema,
  operationIdSchema,
  ledgerIdSchema,
  failureSchema,
  type Failure,
  type ServiceError,
} from "@mpctl/contracts";

export const pageEditorErrorCodes = [
  "not_logged_in",
  "target_unavailable",
  "editor_not_ready",
  "identity_unavailable",
  "unsupported_editor",
  "jsapi_unavailable",
  "page_failed",
  "content_conflict",
  "write_unknown",
] as const;
export const pageEditorErrorSchema = v.strictObject({
  code: v.picklist(pageEditorErrorCodes),
  readFailure: v.optional(readFailureSchema),
});
export type PageEditorError = v.InferOutput<typeof pageEditorErrorSchema>;
export type PageEditorResult<T> = import("better-result").Result<T, ServiceError<PageEditorError>>;
export type PageEditorWireResult<T> = SerializedResult<T, ServiceError<PageEditorError>>;

export function pageEditorResultCodec<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(valueSchema: TSchema) {
  return createServiceResultCodec(valueSchema, pageEditorErrorSchema);
}

const readySchema = v.strictObject({
  isReady: v.literal(true),
  isNew: v.boolean(),
  executorId: ledgerIdSchema,
});
const contentSchema = v.string();
export const bodyExecutionSchema = v.strictObject({
  operationId: operationIdSchema,
  executorId: ledgerIdSchema,
});
export type BodyExecution = v.InferOutput<typeof bodyExecutionSchema>;
export function nativeReceiptSchema<
  S extends v.BaseSchema<unknown, { outcome: string }, v.BaseIssue<unknown>>,
>(effect: S) {
  return v.pipe(
    v.strictObject({
      operationId: operationIdSchema,
      executorId: ledgerIdSchema,
      requestDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
      effect,
      ended: v.boolean(),
      result: v.optional(operationResultSchema),
    }),
    v.check(
      (receipt) =>
        (receipt.ended === false || receipt.result !== undefined) &&
        (receipt.result?.status !== "ok" ||
          (receipt.ended === true && receipt.effect?.outcome === "confirmed")),
    ),
  );
}
export const bodyReceiptSchema = nativeReceiptSchema(bodyEffectSchema);
export type BodyReceipt = v.InferOutput<typeof bodyReceiptSchema>;
export const pageEditorReceiptResultCodec = createServiceResultCodec(
  v.nullable(bodyReceiptSchema),
  failureSchema,
);
export const pageEditorReadyResultCodec = pageEditorResultCodec(readySchema);
export const pageEditorContentResultCodec = pageEditorResultCodec(contentSchema);
export const pageEditorWriteResultCodec = createServiceResultCodec(
  bodyReceiptSchema,
  failureSchema,
);

export interface PageEditorService {
  setCoverFromBody(
    input: BodyCoverExecution,
  ): Promise<SerializedResult<CoverReceipt, Failure | { code: "invalid_result_envelope" }>>;
  getCoverReceipt(
    operationId: string,
  ): Promise<SerializedResult<CoverReceipt | null, Failure | { code: "invalid_result_envelope" }>>;
  ready(): Promise<PageEditorWireResult<{ isReady: true; isNew: boolean; executorId: string }>>;
  getContent(): Promise<PageEditorWireResult<string>>;
  setContent(
    html: string,
    expectedHash: string,
    execution: BodyExecution,
  ): Promise<SerializedResult<BodyReceipt, Failure | { code: "invalid_result_envelope" }>>;
  getReceipt(
    operationId: string,
  ): Promise<SerializedResult<BodyReceipt | null, Failure | { code: "invalid_result_envelope" }>>;
}

// Local request identity does not require BG references or native reads.
export async function bodyRequestDigest(html: string, expectedHash: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(["body", html, expectedHash]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const pageEditorToken = new Token<PageEditorService>("mpctl.page.editor.v1");
