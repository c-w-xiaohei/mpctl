import { Token, type Remote } from "@nexus-js/core";
import {
  Result,
  ResultDeserializationError,
  type Result as BetterResult,
  type SerializedResult,
} from "better-result";
import * as v from "valibot";
export const protocolVersion = "0.3.0";
export const articleNavigationTimeoutMs = 130_000;

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

export const articleCandidateResultSchema = v.strictObject({
  candidate: articleCandidateSchema,
  title: v.string(),
});

export const articleCandidateInputSchema = v.strictObject({
  candidate: articleCandidateSchema,
});

export const articleResultSchema = v.strictObject({
  article: articleReferenceSchema,
  title: v.string(),
  bodyHash: bodyHashSchema,
});

export const articleInputSchema = v.strictObject({
  article: articleReferenceSchema,
});

export const writeBodyInputSchema = v.strictObject({
  article: articleReferenceSchema,
  html: bodySchema,
  expectedHash: bodyHashSchema,
});

export const connectionStatusSchema = v.strictObject({
  connected: v.boolean(),
  sessionId: v.optional(v.string()),
  brokerVersion: v.optional(v.string()),
  extensionVersion: v.optional(v.string()),
});

export const workspaceErrorCodes = [
  "not_connected",
  "not_logged_in",
  "target_unavailable",
  "target_ambiguous",
  "content_conflict",
  "unsupported",
  "page_failed",
  "write_unknown",
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

export const workspaceErrorSchema = v.strictObject({
  code: v.picklist(workspaceErrorCodes),
  stage: v.optional(v.picklist(articleNavigationStages)),
  pageCreated: v.optional(v.boolean()),
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

const createWorkspaceResultCodec = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  valueSchema: TSchema,
) => createServiceResultCodec(valueSchema, workspaceErrorSchema);

export type ArticleCandidate = v.InferOutput<typeof articleCandidateResultSchema>;
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
export const writeBodyResultCodec = createWorkspaceResultCodec(
  v.strictObject({ bodyHash: bodyHashSchema }),
);
export const connectionStatusResultCodec = createWorkspaceResultCodec(connectionStatusSchema);

export interface WorkspaceService {
  cleanupWorkspace(): Promise<
    WorkspaceWireResult<{ groupsRemoved: number; tabsMoved: number; groupsRemaining: number }>
  >;
  listArticles(): Promise<WorkspaceWireResult<ArticleCandidate[]>>;
  openArticle(candidate: string): Promise<WorkspaceWireResult<ArticleResult>>;
  newArticle(): Promise<WorkspaceWireResult<ArticleResult>>;
  currentArticle(): Promise<WorkspaceWireResult<ArticleResult>>;
  readBody(article: string): Promise<WorkspaceWireResult<{ html: string; bodyHash: string }>>;
  writeBody(
    article: string,
    html: string,
    expectedHash: string,
  ): Promise<WorkspaceWireResult<{ bodyHash: string }>>;
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
export const controlStatusResultCodec = backgroundControlResultCodec(connectedResultSchema);
export const reloadResultCodec = backgroundControlResultCodec(reloadResultSchema);

export interface BackgroundControlService {
  connect(): Promise<BackgroundControlWireResult<{ connected: boolean }>>;
  disconnect(): Promise<BackgroundControlWireResult<{ connected: false }>>;
  getStatus(): Promise<BackgroundControlWireResult<{ connected: boolean }>>;
  reload(): Promise<BackgroundControlWireResult<void>>;
}

export const backgroundControlToken = new Token<BackgroundControlService>(
  "mpctl.extension.control.v1",
);

/** Facts asserted by the broker only after validating this socket's credential. */
export interface VerifiedSocketFacts {
  readonly pairingVerified: true;
}
