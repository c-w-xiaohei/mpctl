import { Token } from "@nexus-js/core";
import type { SerializedResult } from "better-result";
import * as v from "valibot";
import { createServiceResultCodec, type ServiceError } from "@mpctl/contracts";

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
export const pageEditorErrorSchema = v.strictObject({ code: v.picklist(pageEditorErrorCodes) });
export type PageEditorError = v.InferOutput<typeof pageEditorErrorSchema>;
export type PageEditorResult<T> = import("better-result").Result<T, ServiceError<PageEditorError>>;
export type PageEditorWireResult<T> = SerializedResult<T, ServiceError<PageEditorError>>;

export function pageEditorResultCodec<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(valueSchema: TSchema) {
  return createServiceResultCodec(valueSchema, pageEditorErrorSchema);
}

const readySchema = v.strictObject({ isReady: v.literal(true), isNew: v.boolean() });
const contentSchema = v.string();
const writeSchema = v.strictObject({ bodyHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)) });
export const pageEditorReadyResultCodec = pageEditorResultCodec(readySchema);
export const pageEditorContentResultCodec = pageEditorResultCodec(contentSchema);
export const pageEditorWriteResultCodec = pageEditorResultCodec(writeSchema);

export interface PageEditorService {
  ready(): Promise<PageEditorWireResult<{ isReady: true; isNew: boolean }>>;
  getContent(): Promise<PageEditorWireResult<string>>;
  setContent(
    html: string,
    expectedHash: string,
  ): Promise<PageEditorWireResult<{ bodyHash: string }>>;
}

export const pageEditorToken = new Token<PageEditorService>("mpctl.page.editor.v1");
