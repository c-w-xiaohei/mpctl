import { Token, type Remote } from "@nexus-js/core";
import {
  Result,
  ResultDeserializationError,
  type Result as BetterResult,
  type SerializedResult,
} from "better-result";
import * as v from "valibot";
export const protocolVersion = "0.18.0";
export function hasProtocolVersion(identity: unknown): boolean {
  if (typeof identity !== "object" || identity === null || !("app" in identity)) return false;
  const app = identity.app;
  return (
    typeof app === "object" &&
    app !== null &&
    "protocolVersion" in app &&
    app.protocolVersion === protocolVersion
  );
}
export const articleNavigationTimeoutMs = 130_000;
// Upload observation includes slow platform processing; each enclosing RPC
// leaves room for preflight, cleanup and serialization.
export const assetUploadTimeouts = Object.freeze({ native: 90_000, page: 105_000, cli: 120_000 });
export const assetFileLimits = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxFilenameLength: 255 });
export const supportedAssetMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export const connectionConfig = Object.freeze({
  websocketUrl: "ws://127.0.0.1:17381/bridge",
  selectedSubprotocol: "mpctl.v1",
  credentialSubprotocolPrefix: "mpctl.pair.",
});

// RFC 6455 subprotocol values use the HTTP token grammar.
const websocketTokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const pairingCredentialSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.regex(websocketTokenPattern),
);

export interface PairingCredentialError {
  code: "invalid_pairing_credential";
}

export function createPairingSubprotocols(
  credential: string,
): BetterResult<[string, string], PairingCredentialError> {
  if (!v.safeParse(pairingCredentialSchema, credential).success) {
    return Result.err({ code: "invalid_pairing_credential" });
  }

  return Result.ok([
    connectionConfig.selectedSubprotocol,
    `${connectionConfig.credentialSubprotocolPrefix}${credential}`,
  ]);
}

export const articleCandidateSchema = v.pipe(v.string(), v.regex(/\S/));
export const articleReferenceSchema = v.pipe(v.string(), v.regex(/\S/));
export const bodySchema = v.string();
export const bodyHashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
export const articleFieldsHashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
export const articleCoverHashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
export const articleFieldLimits = Object.freeze({ author: 8, summary: 120 });
export const articleTitleLimit = 64;
export const articleFieldUpdateInputSchema = v.pipe(
  v.strictObject({
    title: v.optional(v.pipe(v.string(), v.maxLength(articleTitleLimit))),
    author: v.optional(v.pipe(v.string(), v.maxLength(articleFieldLimits.author))),
    summary: v.optional(v.pipe(v.string(), v.maxLength(articleFieldLimits.summary))),
  }),
  v.check(
    (fields) =>
      [fields.title, fields.author, fields.summary].some((value) => value !== undefined) &&
      (fields.title === undefined || !/[\r\n\0]/.test(fields.title)) &&
      (fields.author === undefined || !/[\r\n\0]/.test(fields.author)) &&
      (fields.summary === undefined || !fields.summary.includes("\0")),
  ),
);
export const articleFieldNameSchema = v.picklist(["title", "author", "summary"]);
export type ArticleFieldName = v.InferOutput<typeof articleFieldNameSchema>;
export const articleFieldNamesSchema = v.pipe(
  v.array(articleFieldNameSchema),
  v.maxLength(3),
  v.check((fields) => new Set(fields).size === fields.length),
);
export const articleFieldsSchema = v.strictObject({
  title: v.string(),
  author: v.string(),
  summary: v.string(),
  fieldsHash: articleFieldsHashSchema,
});
export const articleCheckErrorSchema = v.picklist([
  "title_empty",
  "title_invalid",
  "author_invalid",
  "summary_invalid",
  "body_empty",
]);
export const articleCheckWarningSchema = v.picklist([
  "body_semantics_unchecked",
  "summary_platform_default_unchecked",
  "cover_unchecked",
  "platform_settings_unchecked",
]);
export const articleCheckResultSchema = v.strictObject({
  errors: v.pipe(
    v.array(articleCheckErrorSchema),
    v.maxLength(4),
    v.check((issues) => new Set(issues).size === issues.length),
  ),
  warnings: v.pipe(
    v.array(articleCheckWarningSchema),
    v.maxLength(4),
    v.check((issues) => new Set(issues).size === issues.length),
  ),
});
export type ArticleCheckError = v.InferOutput<typeof articleCheckErrorSchema>;
export type ArticleCheckWarning = v.InferOutput<typeof articleCheckWarningSchema>;
export type ArticleCheckIssue = ArticleCheckError | ArticleCheckWarning;
export type ArticleCheckResult = v.InferOutput<typeof articleCheckResultSchema>;

export const articleCandidateResultSchema = v.strictObject({
  candidate: articleCandidateSchema,
  title: v.string(),
});

export const articleResultSchema = v.strictObject({
  article: articleReferenceSchema,
  title: v.string(),
  bodyHash: bodyHashSchema,
});

export const articleInputSchema = v.strictObject({
  article: articleReferenceSchema,
});
export const articleStateSchema = v.strictObject({
  article: articleReferenceSchema,
  ...articleFieldsSchema.entries,
  bodyHash: bodyHashSchema,
  coverHash: articleCoverHashSchema,
});
export type ArticleState = v.InferOutput<typeof articleStateSchema>;
export type ArticleInspection = v.InferOutput<typeof articleFieldsSchema> | ArticleState;
export const articleCoverResultSchema = v.strictObject({ coverHash: articleCoverHashSchema });
export const assetCardSchema = v.strictObject({
  asset: v.pipe(v.string(), v.minLength(1)),
  filename: v.pipe(v.string(), v.minLength(1), v.maxLength(assetFileLimits.maxFilenameLength)),
  thumbnailUrl: v.optional(v.pipe(v.string(), v.url())),
});
export const assetListSchema = v.strictObject({
  scope: v.literal("visible-page"),
  cards: v.array(assetCardSchema),
});

export const ledgerIdSchema = v.pipe(v.string(), v.uuid());
export const operationIdSchema = v.pipe(
  v.string(),
  v.regex(/^op:[0-9a-f-]{36}:[0-9a-f-]{36}$/),
  v.check((id) =>
    id
      .split(":")
      .slice(1)
      .every((part) => v.safeParse(ledgerIdSchema, part).success),
  ),
);
export const articleNewInputSchema = v.strictObject({ operationId: operationIdSchema });
export const articleOpenInputSchema = v.strictObject({
  operationId: operationIdSchema,
  candidate: articleCandidateSchema,
});
export type ArticleNewInput = v.InferOutput<typeof articleNewInputSchema>;
export type ArticleOpenInput = v.InferOutput<typeof articleOpenInputSchema>;
export const articleCurrentInputSchema = v.strictObject({
  candidate: v.optional(articleCandidateSchema),
  new: v.optional(v.literal(true)),
});
export type ArticleCurrentInput = v.InferOutput<typeof articleCurrentInputSchema>;
export const maintenanceInputSchema = v.strictObject({
  operationId: operationIdSchema,
  maintenance: v.picklist(["article-list", "asset-list", "workspace-cleanup"]),
  article: v.optional(articleReferenceSchema),
});
export type MaintenanceInput = v.InferOutput<typeof maintenanceInputSchema>;
const assetPayloadEntries = {
  blob: v.instance(Blob),
  filename: v.pipe(v.string(), v.minLength(1), v.maxLength(assetFileLimits.maxFilenameLength)),
  mimeType: v.picklist(supportedAssetMimeTypes),
};
export const articleCoverSetInputSchema = v.union([
  v.strictObject({
    operationId: operationIdSchema,
    article: articleReferenceSchema,
    asset: v.pipe(v.string(), v.minLength(1)),
    expectedCoverHash: articleCoverHashSchema,
  }),
  v.strictObject({
    operationId: operationIdSchema,
    article: articleReferenceSchema,
    bodyImage: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    expectedBodyHash: bodyHashSchema,
    expectedCoverHash: articleCoverHashSchema,
  }),
]);
export const articleSaveInputSchema = v.strictObject({
  operationId: operationIdSchema,
  article: articleReferenceSchema,
  expectedBodyHash: bodyHashSchema,
  expectedFieldsHash: articleFieldsHashSchema,
  expectedCoverHash: articleCoverHashSchema,
});
export const assetPayloadSchema = v.pipe(
  v.strictObject(assetPayloadEntries),
  v.check(
    (payload) =>
      payload.blob.size > 0 &&
      payload.blob.size <= assetFileLimits.maxBytes &&
      payload.blob.type === payload.mimeType &&
      !payload.filename.includes("/") &&
      !payload.filename.includes("\\") &&
      [...payload.filename].every((character) => {
        const code = character.codePointAt(0)!;
        return code >= 32 && (code < 127 || code > 159);
      }) &&
      {
        "image/png": [".png"],
        "image/jpeg": [".jpg", ".jpeg"],
        "image/gif": [".gif"],
        "image/webp": [".webp"],
      }[payload.mimeType].includes(
        payload.filename.slice(payload.filename.lastIndexOf(".")).toLowerCase(),
      ),
  ),
);
export type AssetPayload = v.InferOutput<typeof assetPayloadSchema>;
export const assetUploadInputSchema = v.strictObject({
  operationId: operationIdSchema,
  article: articleReferenceSchema,
  ...assetPayloadEntries,
});
/** Fingerprints actual received bytes. Neither a caller hash nor Blob object identity is evidence. */
export async function assetRequestDigest(payload: AssetPayload): Promise<string> {
  v.parse(assetPayloadSchema, payload);
  const bytes = new Uint8Array(await payload.blob.arrayBuffer());
  const hex = (hash: ArrayBuffer) =>
    [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const source = hex(await crypto.subtle.digest("SHA-256", bytes));
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify(["upload", source, payload.filename, payload.mimeType, payload.blob.size]),
      ),
    ),
  );
}
export async function validAssetSignature(payload: AssetPayload): Promise<boolean> {
  const bytes = new Uint8Array(await payload.blob.arrayBuffer()).subarray(0, 12);
  const starts = (signature: number[], offset = 0) =>
    signature.every((byte, i) => bytes[offset + i] === byte);
  return payload.mimeType === "image/png"
    ? starts([137, 80, 78, 71, 13, 10, 26, 10])
    : payload.mimeType === "image/jpeg"
      ? starts([255, 216, 255])
      : payload.mimeType === "image/gif"
        ? starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97])
        : starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8);
}
export function createOperationId(ledgerId: string): string {
  return `op:${v.parse(ledgerIdSchema, ledgerId)}:${crypto.randomUUID()}`;
}
export function operationLedgerId(id: string): string | undefined {
  return v.safeParse(operationIdSchema, id).success ? id.split(":")[1] : undefined;
}
export const writeBodyInputSchema = v.strictObject({
  operationId: operationIdSchema,
  article: articleReferenceSchema,
  html: bodySchema,
  expectedHash: bodyHashSchema,
});
export const updateFieldsInputSchema = v.strictObject({
  operationId: operationIdSchema,
  article: articleReferenceSchema,
  fields: articleFieldUpdateInputSchema,
  expectedHash: articleFieldsHashSchema,
});
export type UpdateFieldsInput = v.InferOutput<typeof updateFieldsInputSchema>;

export const connectionStatusSchema = v.pipe(
  v.strictObject({
    connected: v.boolean(),
    sessionId: v.optional(v.string()),
    brokerVersion: v.optional(v.string()),
    extensionVersion: v.optional(v.string()),
    ledgerId: v.optional(ledgerIdSchema),
    keyLedgerId: v.optional(ledgerIdSchema),
  }),
  v.check((status) => !status.connected || status.ledgerId !== undefined),
);

export const workspaceErrorCodes = [
  "operation_blocked",
  "relationship_unknown",
  "storage_failed",
  "not_connected",
  "not_logged_in",
  "target_unavailable",
  "target_ambiguous",
  "content_conflict",
  "unsupported",
  "page_failed",
  "write_unknown",
  "invalid_fields",
  "field_update_unknown",
  "invalid_asset",
  "asset_too_large",
  "asset_ambiguous",
  "asset_upload_unknown",
  "asset_list_failed",
  "cleanup_failed",
  "dialog_unavailable",
  "library_open_unknown",
  "invalid_payload",
  "cover_unavailable",
  "cover_input_unavailable",
  "cover_update_unknown",
  "save_control_unavailable",
  "history_unavailable",
  "hash_failed",
  "save_unknown",
] as const;

export const articleNavigationStages = [
  "source_unavailable",
  "source_ambiguous",
  "source_changed",
  "site_root_timeout",
  "native_control_unavailable",
  "native_target_missing",
  "native_target_ambiguous",
  "native_target_unsupported",
  "target_tab_create_failed",
  "target_not_observed",
  "target_not_ready",
  "editor_bootstrap_failed",
  "editor_not_new",
] as const;

// Upload progress belongs to the provider that observed it. A lost RPC reply
// cannot establish whether the downstream provider dispatched an upload.

const failureKindSchema = v.picklist(["domain", "nexus", "protocol", "runtime"]);
const machineCodeSchema = v.pipe(v.string(), v.regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/));

export const readFailureSchema = v.strictObject({
  stage: v.picklist([
    "workspace_call",
    "workspace_decode",
    "broker_cleanup",
    "article_validate",
    "page_connect",
    "page_acquire",
    "page_call",
    "page_decode",
    "native_read",
    "hash",
    "article_revalidate",
    "list_refresh",
    "library_open",
    "library_cleanup",
    "file_check",
    "file_write",
    "file_cleanup",
  ]),
  kind: failureKindSchema,
  causeCode: machineCodeSchema,
  component: v.optional(v.picklist(["body", "fields", "cover", "assets", "drafts", "status"])),
  cleanup: v.optional(
    v.strictObject({
      stage: v.picklist(["library_cleanup", "file_cleanup", "broker_cleanup"]),
      kind: failureKindSchema,
      causeCode: machineCodeSchema,
    }),
  ),
});
export type ReadFailure = v.InferOutput<typeof readFailureSchema>;

export const connectionFailureSchema = v.strictObject({
  action: v.picklist(["connect", "status", "reload", "disconnect"]),
  stage: v.picklist([
    "settings_read",
    "settings_write",
    "settings_cleanup",
    "broker_connect",
    "broker_start",
    "broker_cleanup",
    "status_acquire",
    "status_call",
    "status_decode",
    "version_check",
    "workspace_acquire",
    "control_acquire",
    "control_call",
    "control_decode",
    "ws_connect",
    "ws_protocol",
    "disconnect",
    "reload_wait",
  ]),
  kind: failureKindSchema,
  causeCode: machineCodeSchema,
  cleanup: v.optional(
    v.strictObject({
      stage: v.picklist(["settings_cleanup", "broker_cleanup", "disconnect"]),
      kind: failureKindSchema,
      causeCode: machineCodeSchema,
    }),
  ),
});
export type ConnectionFailure = v.InferOutput<typeof connectionFailureSchema>;

export const workspaceErrorSchema = v.strictObject({
  code: v.picklist(workspaceErrorCodes),
  stage: v.optional(v.picklist(articleNavigationStages)),
  pageCreated: v.optional(v.boolean()),
  cleanupFailed: v.optional(v.literal(true)),
  baselineHash: v.optional(articleCoverHashSchema),
  readFailure: v.optional(readFailureSchema),
  connectionFailure: v.optional(connectionFailureSchema),
  blockingOperationId: v.optional(operationIdSchema),
  snapshot: v.optional(v.lazy(() => operationSnapshotSchema)),
  issue: v.optional(v.lazy(() => interactionIssueSchema)),
});

export const resultProtocolErrorSchema = v.strictObject({
  code: v.literal("invalid_result_envelope"),
});
export type ResultProtocolError = v.InferOutput<typeof resultProtocolErrorSchema>;
export type ServiceError<E> = E | ResultProtocolError;
const resultProtocolError = { code: "invalid_result_envelope" } as const;

export function createServiceResultCodec<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  ESchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(valueSchema: TSchema, errorSchema: ESchema) {
  const wireErrorSchema = v.union([errorSchema, resultProtocolErrorSchema]);
  const codec = Result.codec({
    serialize: { ok: valueSchema, err: wireErrorSchema },
    deserialize: { ok: valueSchema, err: wireErrorSchema },
  });
  return {
    ...codec,
    async serialize(
      result: BetterResult<v.InferInput<TSchema>, v.InferInput<ESchema> | ResultProtocolError>,
    ): Promise<
      BetterResult<
        SerializedResult<v.InferOutput<TSchema>, ServiceError<v.InferOutput<ESchema>>>,
        ResultProtocolError
      >
    > {
      const encoded = await codec.serialize(result);
      if (Result.isError(encoded)) return Result.err(resultProtocolError);
      return Result.ok(encoded.value);
    },
    async deserialize(
      value: unknown,
    ): Promise<BetterResult<v.InferOutput<TSchema>, ServiceError<v.InferOutput<ESchema>>>> {
      const envelope = v.safeParse(
        v.union([
          v.strictObject({ status: v.literal("ok"), value: v.optional(v.unknown()) }),
          v.strictObject({ status: v.literal("error"), error: v.optional(v.unknown()) }),
        ]),
        value,
      );
      if (!envelope.success) return Result.err(resultProtocolError);
      const decoded = await codec.deserialize(envelope.output);
      if (Result.isError(decoded) && ResultDeserializationError.is(decoded.error))
        return Result.err(resultProtocolError);
      return Result.isOk(decoded) ? Result.ok(decoded.value) : Result.err(decoded.error);
    },
  };
}

// Committed results and this call's diagnostics share one finite failure vocabulary.
const failureLocationSchema = v.picklist([
  "bg.persistence",
  "bg.page_call",
  "bg.page_connect",
  "bg.page_acquire",
  "bg.page_decode",
  "bg.preflight",
  "main.preflight",
  "main.guard",
  "main.jsapi_callback",
  "main.readback",
  "main.execution",
  "content.preflight",
  "content.guard",
  "content.field_edit",
  "content.title_mirror",
  "content.readback",
  "content.library_open",
  "content.upload_preflight",
  "content.file_assign",
  "content.upload_dispatch",
  "content.upload_confirm",
  "content.library_cleanup",
  "content.cover_select",
  "content.cover_confirm",
  "content.cover_cleanup",
  "content.save_dispatch",
  "content.save_confirm",
  "content.history_cleanup",
  "bg.pointer",
  "bg.pointer_cleanup",
  "bg.canonical_read",
  "bg.draft_list",
  "bg.drift_check",
  "bg.reload",
  "bg.fresh_read",
  "bg.fresh_compare",
  "bg.navigation",
  "cli.file_read",
  "cli.call",
  "cli.cleanup",
]);
export const failureSchema = v.strictObject({
  code: v.picklist([
    "invalid_operation",
    "ledger_mismatch",
    "operation_conflict",
    "operation_not_found",
    "operation_blocked",
    "relationship_unknown",
    "storage_failed",
    "ledger_incompatible",
    "ledger_full",
    "operation_interrupted",
    "operation_unresolved",
    "execution_consumed",
    "execution_closed",
    "evidence_conflict",
    "executor_mismatch",
    "receipt_missing",
    "receipt_unreachable",
    "target_ambiguous",
    "target_unavailable",
    "not_logged_in",
    "content_conflict",
    "page_failed",
    "write_unknown",
    "hash_failed",
    "invalid_result_envelope",
    "not_connected",
    "version_mismatch",
    "cleanup_failed",
    "invalid_fields",
    "field_update_unknown",
    "fields_unavailable",
    "route_changed",
    "unsupported",
    "invalid_asset",
    "invalid_payload",
    "dialog_unavailable",
    "library_open_unknown",
    "asset_ambiguous",
    "asset_upload_unknown",
    "asset_list_failed",
    "cover_unavailable",
    "cover_input_unavailable",
    "cover_update_unknown",
    "save_control_unavailable",
    "history_unavailable",
    "save_unknown",
    "persistence_mismatch",
  ]),
  cause: v.optional(
    v.strictObject({ at: failureLocationSchema, kind: failureKindSchema, code: machineCodeSchema }),
  ),
  cleanup: v.optional(
    v.strictObject({ at: failureLocationSchema, kind: failureKindSchema, code: machineCodeSchema }),
  ),
  blockingOperationId: v.optional(operationIdSchema),
  confirmationTimedOut: v.optional(v.literal(true)),
});
export type Failure = v.InferOutput<typeof failureSchema>;
export const bodyEffectSchema = v.variant("outcome", [
  v.strictObject({ outcome: v.literal("not_dispatched") }),
  v.strictObject({ outcome: v.literal("unknown") }),
  v.strictObject({ outcome: v.literal("confirmed"), bodyHash: bodyHashSchema }),
]);
export type BodyEffect = v.InferOutput<typeof bodyEffectSchema>;
export const fieldsEffectSchema = v.pipe(
  v.strictObject({
    outcome: v.picklist(["not_dispatched", "partial", "unknown", "confirmed"]),
    requested: articleFieldNamesSchema,
    attempted: articleFieldNamesSchema,
    confirmed: articleFieldNamesSchema,
    unknown: articleFieldNamesSchema,
    fieldsHash: v.optional(articleFieldsHashSchema),
  }),
  v.check(
    (effect) =>
      effect.requested.length > 0 &&
      effect.attempted.every((name) => effect.requested.includes(name)) &&
      effect.confirmed.every(
        (name) => effect.attempted.includes(name) && !effect.unknown.includes(name),
      ) &&
      effect.unknown.every(
        (name) => effect.attempted.includes(name) && !effect.confirmed.includes(name),
      ) &&
      effect.attempted.every(
        (name) => effect.confirmed.includes(name) || effect.unknown.includes(name),
      ) &&
      (effect.outcome !== "not_dispatched" || effect.attempted.length === 0) &&
      (effect.outcome !== "partial" || effect.confirmed.length > 0) &&
      (effect.outcome !== "unknown" || effect.confirmed.length === 0) &&
      (effect.outcome !== "confirmed" ||
        (effect.fieldsHash !== undefined && effect.unknown.length === 0)) &&
      (effect.fieldsHash === undefined || effect.outcome === "confirmed"),
  ),
);
export type FieldsEffect = v.InferOutput<typeof fieldsEffectSchema>;
export const uploadEffectSchema = v.variant("outcome", [
  v.strictObject({ outcome: v.literal("not_dispatched"), filename: v.string() }),
  v.strictObject({ outcome: v.literal("unknown"), filename: v.string() }),
  v.strictObject({
    outcome: v.literal("confirmed"),
    filename: v.string(),
    thumbnailUrl: v.pipe(v.string(), v.url()),
  }),
]);
export type UploadEffect = v.InferOutput<typeof uploadEffectSchema>;
export const coverEffectSchema = v.variant("outcome", [
  v.strictObject({ cover: v.literal(true), outcome: v.literal("not_dispatched") }),
  v.strictObject({
    cover: v.literal(true),
    outcome: v.literal("unknown"),
    baselineHash: v.optional(articleCoverHashSchema),
  }),
  v.strictObject({
    cover: v.literal(true),
    outcome: v.literal("confirmed"),
    coverHash: articleCoverHashSchema,
  }),
]);
export type CoverEffect = v.InferOutput<typeof coverEffectSchema>;
export const saveEffectSchema = v.variant("outcome", [
  v.strictObject({ outcome: v.literal("not_dispatched"), persistence: v.literal("unverified") }),
  v.strictObject({ outcome: v.literal("unknown"), persistence: v.literal("unverified") }),
  v.strictObject({
    outcome: v.literal("confirmed"),
    persistence: v.literal("unverified"),
    candidate: v.optional(articleCandidateSchema),
  }),
  v.strictObject({
    outcome: v.literal("confirmed"),
    persistence: v.literal("verified"),
    candidate: v.optional(articleCandidateSchema),
    bodyHash: bodyHashSchema,
    fieldsHash: articleFieldsHashSchema,
    coverHash: articleCoverHashSchema,
  }),
]);
export type SaveEffect = v.InferOutput<typeof saveEffectSchema>;
export const navigationEffectSchema = v.pipe(
  v.strictObject({
    navigation: v.literal(true),
    outcome: v.picklist(["not_dispatched", "unknown", "confirmed"]),
    pageCreated: v.boolean(),
    auxiliaryCreated: v.array(v.picklist(["home", "draft-list"])),
    targetBound: v.boolean(),
    bodyHash: v.optional(bodyHashSchema),
  }),
  v.check(
    (effect) =>
      (effect.outcome !== "not_dispatched" ||
        (!effect.pageCreated && !effect.targetBound && effect.auxiliaryCreated.length === 0)) &&
      (effect.outcome !== "confirmed" || effect.targetBound) &&
      (effect.bodyHash === undefined || effect.targetBound) &&
      new Set(effect.auxiliaryCreated).size === effect.auxiliaryCreated.length,
  ),
);
export type NavigationEffect = v.InferOutput<typeof navigationEffectSchema>;
export const maintenanceEffectSchema = v.strictObject({
  maintenance: v.literal(true),
  outcome: v.picklist(["not_dispatched", "unknown", "confirmed"]),
  auxiliaryCreated: v.optional(v.array(v.picklist(["home", "draft-list"]))),
  placements: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});
export type MaintenanceEffect = v.InferOutput<typeof maintenanceEffectSchema>;
export const operationEffectSchema = v.union([
  bodyEffectSchema,
  fieldsEffectSchema,
  uploadEffectSchema,
  coverEffectSchema,
  saveEffectSchema,
  navigationEffectSchema,
  maintenanceEffectSchema,
]);
export type OperationEffect = v.InferOutput<typeof operationEffectSchema>;
export const operationResultSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("ok"),
    value: v.strictObject({ cleanup: v.optional(failureSchema) }),
  }),
  v.strictObject({ status: v.literal("error"), error: failureSchema }),
]);
export type OperationResult = v.InferOutput<typeof operationResultSchema>;
function snapshotSchema<
  O extends "body" | "fields" | "upload" | "cover" | "save" | "new" | "open" | "maintenance",
  S extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(operation: O, effect: S) {
  const base = { operationId: operationIdSchema, operation: v.literal(operation), effect };
  return v.variant("state", [
    v.strictObject({ ...base, state: v.literal("accepted") }),
    v.strictObject({ ...base, state: v.literal("issued") }),
    v.strictObject({
      ...base,
      state: v.literal("unresolved"),
      result: v.strictObject({ status: v.literal("error"), error: failureSchema }),
    }),
    v.strictObject({ ...base, state: v.literal("settled"), result: operationResultSchema }),
  ]);
}
export const operationSnapshotSchema = v.pipe(
  v.variant("operation", [
    snapshotSchema("body", bodyEffectSchema),
    snapshotSchema("fields", fieldsEffectSchema),
    snapshotSchema("upload", uploadEffectSchema),
    snapshotSchema("cover", coverEffectSchema),
    snapshotSchema("save", saveEffectSchema),
    snapshotSchema("new", navigationEffectSchema),
    snapshotSchema("open", navigationEffectSchema),
    snapshotSchema("maintenance", maintenanceEffectSchema),
  ]),
  v.check(
    (snapshot) =>
      (snapshot.state !== "accepted" || snapshot.effect.outcome === "not_dispatched") &&
      (!("result" in snapshot) ||
        snapshot.result.status !== "ok" ||
        snapshot.effect.outcome === "confirmed"),
  ),
);
export type OperationSnapshot = v.InferOutput<typeof operationSnapshotSchema>;
export const interactionIssueSchema = v.strictObject({
  operationId: v.optional(operationIdSchema),
  failure: failureSchema,
  uncommitted: v.optional(
    v.strictObject({ effect: operationEffectSchema, result: v.optional(operationResultSchema) }),
  ),
});
export type InteractionIssue = v.InferOutput<typeof interactionIssueSchema>;
export const operationReplySchema = v.pipe(
  v.strictObject({
    snapshot: operationSnapshotSchema,
    issue: v.optional(interactionIssueSchema),
    // Call-local handles are never stored in the operation snapshot/ledger.
    article: v.optional(articleReferenceSchema),
    bodyHash: v.optional(bodyHashSchema),
    asset: v.optional(assetCardSchema),
  }),
  v.check((reply) => {
    if ((reply.article === undefined) !== (reply.bodyHash === undefined)) return false;
    if (reply.article === undefined && reply.asset === undefined) return true;
    if (reply.issue || reply.snapshot.state !== "settled" || reply.snapshot.result.status !== "ok")
      return false;
    if (reply.article !== undefined)
      return (
        reply.asset === undefined &&
        (reply.snapshot.operation === "new" || reply.snapshot.operation === "open") &&
        reply.snapshot.effect.bodyHash === reply.bodyHash
      );
    return (
      reply.snapshot.operation === "upload" &&
      reply.snapshot.effect.outcome === "confirmed" &&
      reply.asset?.filename === reply.snapshot.effect.filename &&
      reply.asset?.thumbnailUrl === reply.snapshot.effect.thumbnailUrl
    );
  }),
);
export type OperationReply = v.InferOutput<typeof operationReplySchema>;
export type OperationWireResult = SerializedResult<OperationReply, ServiceError<InteractionIssue>>;
export const operationResultCodec = createServiceResultCodec(
  operationReplySchema,
  interactionIssueSchema,
);
export type WriteBodyInput = v.InferOutput<typeof writeBodyInputSchema>;

const createWorkspaceResultCodec = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  valueSchema: TSchema,
) => createServiceResultCodec(valueSchema, workspaceErrorSchema);
export const articleFieldsResultCodec = createWorkspaceResultCodec(articleFieldsSchema);
export const articleStateResultCodec = createWorkspaceResultCodec(articleStateSchema);
export const articleCheckResultCodec = createWorkspaceResultCodec(articleCheckResultSchema);
export const articleCoverResultCodec = createWorkspaceResultCodec(articleCoverResultSchema);
export type ArticleCoverSetInput = v.InferOutput<typeof articleCoverSetInputSchema>;
export type ArticleSaveInput = v.InferOutput<typeof articleSaveInputSchema>;
export const assetListResultCodec = createWorkspaceResultCodec(assetListSchema);
export const assetImageSchema = v.strictObject({
  filename: v.string(),
  src: v.pipe(v.string(), v.url()),
  html: v.string(),
});
export type AssetImage = v.InferOutput<typeof assetImageSchema>;
export const assetImageResultCodec = createWorkspaceResultCodec(assetImageSchema);

export type ArticleCandidate = v.InferOutput<typeof articleCandidateResultSchema>;
export type AssetCard = v.InferOutput<typeof assetCardSchema>;
export type AssetList = v.InferOutput<typeof assetListSchema>;
export type AssetUploadInput = v.InferOutput<typeof assetUploadInputSchema>;
export type ArticleResult = v.InferOutput<typeof articleResultSchema>;
export type ConnectionStatus = v.InferOutput<typeof connectionStatusSchema>;
export type ArticleNavigationStage = (typeof articleNavigationStages)[number];
export type WorkspaceError = v.InferOutput<typeof workspaceErrorSchema>;
export type WorkspaceResult<T> = import("better-result").Result<T, ServiceError<WorkspaceError>>;
export type WorkspaceWireResult<T> = SerializedResult<T, ServiceError<WorkspaceError>>;

export const cleanupWorkspaceResultCodec = createWorkspaceResultCodec(
  v.strictObject({ groupsRemoved: v.number(), tabsMoved: v.number(), groupsRemaining: v.number() }),
);
export const listArticlesResultCodec = createWorkspaceResultCodec(
  v.array(articleCandidateResultSchema),
);
export const articleResultCodec = createWorkspaceResultCodec(articleResultSchema);
export const workspaceResultCodec = createWorkspaceResultCodec(
  v.strictObject({ html: bodySchema, bodyHash: bodyHashSchema }),
);
export const connectionStatusResultCodec = createWorkspaceResultCodec(connectionStatusSchema);

export interface WorkspaceService {
  cleanupWorkspace(): Promise<
    WorkspaceWireResult<{ groupsRemoved: number; tabsMoved: number; groupsRemaining: number }>
  >;
  listArticles(): Promise<WorkspaceWireResult<ArticleCandidate[]>>;
  openArticle(input: ArticleOpenInput): Promise<OperationWireResult>;
  newArticle(input: ArticleNewInput): Promise<OperationWireResult>;
  currentArticle(input?: ArticleCurrentInput): Promise<WorkspaceWireResult<ArticleResult>>;
  readBody(article: string): Promise<WorkspaceWireResult<{ html: string; bodyHash: string }>>;
  writeBody(input: WriteBodyInput): Promise<OperationWireResult>;
  getOperation(operationId: string): Promise<OperationWireResult>;
  inspectArticle(
    article: string,
    options?: { all?: true },
  ): Promise<WorkspaceWireResult<ArticleInspection>>;
  updateArticleFields(input: UpdateFieldsInput): Promise<OperationWireResult>;
  checkArticle(
    article: string,
  ): Promise<WorkspaceWireResult<v.InferOutput<typeof articleCheckResultSchema>>>;
  listAssets(
    article: string,
    options?: { operation: string },
  ): Promise<WorkspaceWireResult<v.InferOutput<typeof assetListSchema>>>;
  uploadAsset(input: AssetUploadInput): Promise<OperationWireResult>;
  resolveAsset(article: string, asset: string): Promise<WorkspaceWireResult<AssetImage>>;
  readArticleCover(
    article: string,
  ): Promise<WorkspaceWireResult<v.InferOutput<typeof articleCoverResultSchema>>>;
  setArticleCover(input: ArticleCoverSetInput): Promise<OperationWireResult>;
  saveArticle(input: ArticleSaveInput): Promise<OperationWireResult>;
}

export const workspaceToken = new Token<WorkspaceService>("mpctl.workspace.v1");
export type WorkspaceRemote = Remote<WorkspaceService>;

export interface ConnectionService {
  getStatus(): Promise<WorkspaceWireResult<ConnectionStatus>>;
}

export const connectionToken = new Token<ConnectionService>("mpctl.connection.v1");

export const backgroundControlErrorCodes = [
  "connect_failed",
  "disconnect_failed",
  "status_failed",
  "reload_failed",
] as const;
export const backgroundControlErrorSchema = v.strictObject({
  code: v.picklist(backgroundControlErrorCodes),
  connectionFailure: v.optional(connectionFailureSchema),
});
export type BackgroundControlError = v.InferOutput<typeof backgroundControlErrorSchema>;
export type BackgroundControlResult<T> = import("better-result").Result<
  T,
  ServiceError<BackgroundControlError>
>;
export type BackgroundControlWireResult<T> = SerializedResult<
  T,
  ServiceError<BackgroundControlError>
>;
export function backgroundControlResultCodec<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(valueSchema: TSchema) {
  return createServiceResultCodec(valueSchema, backgroundControlErrorSchema);
}
const connectedResultSchema = v.strictObject({ connected: v.boolean() });
const disconnectedResultSchema = v.strictObject({ connected: v.literal(false) });
const reloadResultSchema = v.undefined();
export const connectResultCodec = backgroundControlResultCodec(connectedResultSchema);
export const disconnectResultCodec = backgroundControlResultCodec(disconnectedResultSchema);
export const controlStatusResultCodec = backgroundControlResultCodec(
  v.strictObject({ connected: v.boolean(), keyLedgerId: v.optional(ledgerIdSchema) }),
);
export const reloadResultCodec = backgroundControlResultCodec(reloadResultSchema);

export interface BackgroundControlService {
  connect(): Promise<BackgroundControlWireResult<{ connected: boolean }>>;
  disconnect(): Promise<BackgroundControlWireResult<{ connected: false }>>;
  getStatus(): Promise<BackgroundControlWireResult<{ connected: boolean; keyLedgerId?: string }>>;
  reload(): Promise<BackgroundControlWireResult<void>>;
}

export const backgroundControlToken = new Token<BackgroundControlService>(
  "mpctl.extension.control.v1",
);

/** Facts asserted by the broker only after validating this socket's credential. */
export interface VerifiedSocketFacts {
  readonly pairingVerified: true;
}
