import { Token } from "@nexus-js/core";
import type { SerializedResult } from "better-result";
import * as v from "valibot";
import { createServiceResultCodec, type ServiceError } from "@mpctl/contracts";

export { backgroundControlToken, type BackgroundControlService } from "@mpctl/contracts";

export const contentStatusErrorCodes = ["route_changed", "page_failed"] as const;
export const contentStatusErrorSchema = v.strictObject({
  code: v.picklist(contentStatusErrorCodes),
});
export type ContentStatusError = v.InferOutput<typeof contentStatusErrorSchema>;
export type ContentStatusResult<T> = import("better-result").Result<
  T,
  ServiceError<ContentStatusError>
>;
export type ContentStatusWireResult<T> = SerializedResult<T, ServiceError<ContentStatusError>>;

export const draftPageErrorCodes = ["route_changed", "draft_unavailable", "page_failed"] as const;
export const draftPageErrorSchema = v.strictObject({ code: v.picklist(draftPageErrorCodes) });
export type DraftPageError = v.InferOutput<typeof draftPageErrorSchema>;
export type DraftPageResult<T> = import("better-result").Result<T, ServiceError<DraftPageError>>;
export type DraftPageWireResult<T> = SerializedResult<T, ServiceError<DraftPageError>>;

export const homePageErrorCodes = ["control_unavailable", "page_failed"] as const;
export const homePageErrorSchema = v.strictObject({ code: v.picklist(homePageErrorCodes) });
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
const urlSchema = v.string();

export const contentStatusResultCodec = resultCodec(contentStatusErrorSchema, statusSchema);
export const listDraftsResultCodec = resultCodec(draftPageErrorSchema, draftsSchema);
export const openDraftResultCodec = resultCodec(draftPageErrorSchema, urlSchema);
export const validateDraftResultCodec = resultCodec(draftPageErrorSchema, draftValidationSchema);
export const currentItemCountResultCodec = resultCodec(draftPageErrorSchema, countSchema);
export const hasUniqueCurrentItemResultCodec = resultCodec(draftPageErrorSchema, booleanSchema);
export const homeIsReadyResultCodec = resultCodec(homePageErrorSchema, booleanSchema);
export const openDraftListResultCodec = resultCodec(homePageErrorSchema, urlSchema);
export const openNewEditorResultCodec = resultCodec(homePageErrorSchema, booleanSchema);

export interface ContentStatusService {
  status(): Promise<ContentStatusWireResult<v.InferOutput<typeof statusSchema>>>;
}

export const contentStatusToken = new Token<ContentStatusService>(
  "mpctl.extension.content-status.v1",
);

export interface DraftPageService {
  listDrafts(): Promise<DraftPageWireResult<v.InferOutput<typeof draftsSchema>>>;
  openDraft(candidate: string): Promise<DraftPageWireResult<string>>;
  validateDraft(
    candidate: string,
  ): Promise<DraftPageWireResult<v.InferOutput<typeof draftValidationSchema>>>;
  currentItemCount(): Promise<DraftPageWireResult<number>>;
  hasUniqueCurrentItem(): Promise<DraftPageWireResult<boolean>>;
}

export const draftPageToken = new Token<DraftPageService>("mpctl.extension.draft-page.v1");

export interface HomePageService {
  isReady(): Promise<HomePageWireResult<boolean>>;
  openDraftList(): Promise<HomePageWireResult<string>>;
  openNewEditor(): Promise<HomePageWireResult<boolean>>;
}

export const homePageToken = new Token<HomePageService>("mpctl.extension.home-page.v1");
