import { Nexus, NexusError, type RemoteValue } from "@nexus-js/core";
import { Result } from "better-result";
import type { Result as BetterResult } from "better-result";
import { usingNodeIpcClient } from "@nexus-js/node-ipc";
import {
  cleanupWorkspaceResultCodec,
  listArticlesResultCodec,
  articleResultCodec,
  workspaceResultCodec,
  operationResultCodec,
  createOperationId,
  workspaceErrorSchema,
  failureSchema,
  operationIdSchema,
  type WriteBodyInput,
  type UpdateFieldsInput,
  type AssetUploadInput,
  type ArticleCoverSetInput,
  type ArticleSaveInput,
  type ArticleNewInput,
  type ArticleOpenInput,
  type ArticleCurrentInput,
  articleNavigationTimeoutMs,
  type OperationReply,
  type InteractionIssue,
  articleFieldsResultCodec,
  articleCheckResultCodec,
  assetListResultCodec,
  articleCoverResultCodec,
  connectionStatusResultCodec,
  connectResultCodec,
  disconnectResultCodec,
  controlStatusResultCodec,
  reloadResultCodec,
  connectionToken,
  workspaceToken,
  backgroundControlToken,
  protocolVersion,
  type ConnectionStatus,
  type ArticleCandidate,
  type ArticleResult,
} from "@mpctl/contracts";
import type { NodeIpcSocketAddress } from "@nexus-js/node-ipc";
import { spawn } from "node:child_process";
import { saveBrokerCredential, loadBrokerCredential } from "./broker-settings.js";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

// One safe projection owns CLI details. Wire schemas remain the authority for
// facts, and v.object strips unknown internal members at terminal output.
const cliDetailsSchema = v.object({
  ...v.omit(workspaceErrorSchema, ["code"]).entries,
  pageCreated: v.optional(
    v.pipe(
      v.boolean(),
      v.transform((value) => (value ? (true as const) : undefined)),
    ),
  ),
  operationId: v.optional(operationIdSchema),
  connectionPageUrl: v.optional(v.pipe(v.string(), v.url())),
  failure: v.optional(failureSchema),
});
export class CliError {
  readonly code: string;
  constructor(
    code: string,
    readonly instruction?: string,
    readonly details?: v.InferInput<typeof cliDetailsSchema>,
  ) {
    this.code = code;
  }
}
export const cliError = (
  code: string,
  instruction?: string,
  details?: CliError["details"],
): CliError => new CliError(code, instruction, details);
type Outcome<T> = BetterResult<T, CliError>;
type DecodedWorkspace = {
  cleanupWorkspace(): Promise<
    Outcome<{ groupsRemoved: number; tabsMoved: number; groupsRemaining: number }>
  >;
  listArticles(): Promise<Outcome<ArticleCandidate[]>>;
  openArticle(input: ArticleOpenInput): Promise<Outcome<OperationReply>>;
  newArticle(input: ArticleNewInput): Promise<Outcome<OperationReply>>;
  currentArticle(input?: ArticleCurrentInput): Promise<Outcome<ArticleResult>>;
  readBody(article: string): Promise<Outcome<{ html: string; bodyHash: string }>>;
  writeBody(input: WriteBodyInput): Promise<Outcome<OperationReply>>;
  getOperation(id: string): Promise<Outcome<OperationReply>>;
  inspectArticle(
    article: string,
  ): Promise<Outcome<{ title: string; author: string; summary: string; fieldsHash: string }>>;
  updateArticleFields(input: UpdateFieldsInput): Promise<Outcome<OperationReply>>;
  checkArticle(article: string): Promise<Outcome<import("@mpctl/contracts").ArticleCheckResult>>;
  listAssets(article: string): Promise<Outcome<import("@mpctl/contracts").AssetList>>;
  uploadAsset(input: AssetUploadInput): Promise<Outcome<OperationReply>>;
  readArticleCover(article: string): Promise<Outcome<{ coverHash: string }>>;
  setArticleCover(input: ArticleCoverSetInput): Promise<Outcome<OperationReply>>;
  saveArticle(input: ArticleSaveInput): Promise<Outcome<OperationReply>>;
};
type DecodedControl = {
  connect(): Promise<Outcome<{ connected: boolean }>>;
  disconnect(): Promise<Outcome<{ connected: false }>>;
  getStatus(): Promise<Outcome<{ connected: boolean }>>;
  reload(): Promise<Outcome<void>>;
};
type BrokerServices = {
  connection: { getStatus(): Promise<Outcome<ConnectionStatus>> };
  brokerStarted: boolean;
  getWorkspace(callTimeout?: number): DecodedWorkspace;
  getBackgroundControl(): DecodedControl;
};

export function brokerAddress(): NodeIpcSocketAddress {
  const socketPath =
    process.env.MPCTL_BROKER_SOCKET ??
    path.join(
      process.env.XDG_RUNTIME_DIR ?? `/tmp/nexus-${process.getuid?.() ?? "user"}`,
      "mpctl",
      "broker.sock",
    );
  return { kind: "path", path: socketPath };
}
export function brokerSocketPath(address: NodeIpcSocketAddress): Outcome<string> {
  return address.kind === "path"
    ? Result.ok(address.path)
    : Result.err(cliError("broker_address_unsupported"));
}

export async function withConnection<T>(
  run: (services: { workspace: DecodedWorkspace; keyLedgerId?: string }) => Promise<Outcome<T>>,
  options: { callTimeout?: number } = {},
): Promise<Outcome<T>> {
  return withBroker(async (services) => {
    const status = await services.connection.getStatus();
    if (Result.isError(status)) return Result.err(status.error);
    if (!status.value.connected) return Result.err(cliError("not_connected"));
    if (
      status.value.brokerVersion !== protocolVersion ||
      status.value.extensionVersion !== protocolVersion
    )
      return Result.err(
        cliError("version_mismatch", "更新插件后重试；status --details 可查看版本", {
          connectionFailure: {
            action: "connect",
            stage: "version_check",
            kind: "protocol",
            causeCode: "version_mismatch",
          },
        }),
      );
    const workspace = services.getWorkspace(options.callTimeout);
    const invoked = await Result.tryPromise({
      try: () => run({ workspace, keyLedgerId: status.value.keyLedgerId }),
      catch: (error) => cliErrorFromUnknown(error),
    });
    const result = Result.isError(invoked) ? Result.err(invoked.error) : invoked.value;
    return result;
  });
}

export async function withBroker<T>(
  run: (services: BrokerServices) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  const setup = Result.try({
    try: () => {
      const nexus = new Nexus();
      nexus.configure(
        usingNodeIpcClient({
          appId: "mpctl-cli",
          configure: false,
          callTimeout: 2_000,
          resolveAddress: brokerAddress,
        }),
      );
      nexus.configure({
        endpoint: {
          meta: {
            context: "node-ipc-client",
            appId: "mpctl-cli",
            pid: process.pid,
            app: { protocolVersion },
          },
        },
      });
      return nexus;
    },
    catch: (error) => cliErrorFromUnknown(error),
  });
  if (Result.isError(setup)) return setup;
  const nexus = setup.value;
  const oldWarn = console.warn;
  console.warn = (...values: unknown[]) => {
    if (values[0] !== "Nexus DEV: `listen` called on an endpoint that does not support it.")
      oldWarn(...values);
  };
  const ready = await Result.tryPromise({
    try: () => nexus.ready(),
    catch: (error) => cliErrorFromUnknown(error),
  });
  console.warn = oldWarn;
  if (Result.isError(ready)) return ready;

  const target = { context: "node-ipc-daemon" as const, appId: "mpctl", instance: "default" };
  let brokerStarted = false;
  const initialConnection = await nexus.safeConnect({ target, timeout: 700 });
  let brokerConnectionResult: Outcome<Awaited<ReturnType<typeof nexus.connect>>>;
  if (Result.isOk(initialConnection)) brokerConnectionResult = Result.ok(initialConnection.value);
  else {
    const credentialResult = await loadBrokerCredential();
    if (Result.isError(credentialResult)) return Result.err(credentialResult.error);
    const address = brokerSocketPath(brokerAddress());
    if (Result.isError(address)) return address;
    const startupNonce = randomUUID();
    const root = path.resolve(import.meta.dir, "../../..");
    const entrypoint = path.join(root, "packages/broker/src/main.ts");
    if (!existsSync(entrypoint)) return Result.err(cliError("broker_unavailable"));
    const childResult = Result.try({
      try: () =>
        spawn(process.execPath, ["run", entrypoint], {
          cwd: root,
          env: {
            ...process.env,
            MPCTL_BROKER_SOCKET: address.value,
            MPCTL_PAIRING_CREDENTIAL: credentialResult.value,
            MPCTL_BROKER_STARTUP_NONCE: startupNonce,
          },
          detached: true,
          stdio: ["ignore", "ignore", "ignore", "pipe"],
        }),
      catch: () => cliError("broker_start_failed"),
    });
    if (Result.isError(childResult)) return childResult;
    const child = childResult.value;
    const readiness = await waitForStartedBroker(nexus, target, child, startupNonce);
    if (Result.isError(readiness)) return readiness;
    brokerConnectionResult = Result.ok(readiness.value.connection);
    brokerStarted = readiness.value.owned;
  }
  if (Result.isError(brokerConnectionResult)) return brokerConnectionResult;
  const brokerConnection = brokerConnectionResult.value;
  const configSaved =
    brokerStarted && process.env.MPCTL_PAIRING_CREDENTIAL
      ? await saveBrokerCredential(process.env.MPCTL_PAIRING_CREDENTIAL)
      : Result.ok(undefined);
  if (Result.isError(configSaved)) {
    return finishBrokerConnection(brokerConnection, Result.err(configSaved.error));
  }

  const servicesResult = Result.try({
    try: (): BrokerServices => {
      return {
        connection: {
          getStatus: async () => {
            const statusFailure = (stage: "status_acquire" | "status_call", cause: unknown) => {
              const cli = cliErrorFromUnknown(cause);
              return cliError(cli.code, cli.instruction, {
                ...cli.details,
                connectionFailure: {
                  action: "status",
                  stage,
                  kind: cause instanceof NexusError ? "nexus" : "runtime",
                  causeCode: cause instanceof NexusError ? cause.code : "unexpected_exception",
                },
              });
            };
            const acquired = brokerConnection.safeGet(connectionToken);
            if (Result.isError(acquired))
              return Result.err(statusFailure("status_acquire", acquired.error));
            const invoked = await Nexus.safeCall(acquired.value.getStatus());
            if (Result.isError(invoked))
              return Result.err(statusFailure("status_call", invoked.error));
            const parsed = await connectionStatusResultCodec.deserialize(invoked.value);
            const decoded = Result.mapError(parsed, (error) => {
              const { code, ...details } = error;
              return cliError(code, undefined, {
                ...details,
                connectionFailure: ("connectionFailure" in details
                  ? details.connectionFailure
                  : undefined) ?? {
                  action: "status",
                  stage: "status_decode",
                  kind: code === "invalid_result_envelope" ? "protocol" : "domain",
                  causeCode: code,
                },
              });
            });
            if (Result.isOk(decoded)) return decoded;
            return Result.err(
              cliError(decoded.error.code, decoded.error.instruction, decoded.error.details),
            );
          },
        },
        brokerStarted,
        getWorkspace: (timeout = 30_000) => {
          const acquired = brokerConnection.safeGet(workspaceToken, { callTimeout: timeout });
          if (Result.isError(acquired)) throw cliErrorFromUnknown(acquired.error);
          const workspace = acquired.value;
          return {
            cleanupWorkspace: () =>
              decode(cleanupWorkspaceResultCodec, () => workspace.cleanupWorkspace()),
            listArticles: () => decode(listArticlesResultCodec, () => workspace.listArticles()),
            openArticle: (input) =>
              decodeOperation(() => workspace.openArticle(input), input.operationId),
            newArticle: (input) =>
              decodeOperation(() => workspace.newArticle(input), input.operationId),
            currentArticle: (input) =>
              decode(articleResultCodec, () => workspace.currentArticle(input)),
            readBody: (article) =>
              decode(workspaceResultCodec, () => workspace.readBody(article), true),
            writeBody: (input) =>
              decodeOperation(() => workspace.writeBody(input), input.operationId),
            getOperation: (id) => decodeOperation(() => workspace.getOperation(id), id),
            inspectArticle: (article) =>
              decode(articleFieldsResultCodec, () => workspace.inspectArticle(article), true),
            updateArticleFields: (input) =>
              decodeOperation(() => workspace.updateArticleFields(input), input.operationId),
            checkArticle: (article) =>
              decode(articleCheckResultCodec, () => workspace.checkArticle(article), true),
            listAssets: (article) =>
              decode(assetListResultCodec, () => workspace.listAssets(article), true),
            uploadAsset: (input) =>
              decodeOperation(() => workspace.uploadAsset(input), input.operationId),
            readArticleCover: (article) =>
              decode(articleCoverResultCodec, () => workspace.readArticleCover(article), true),
            setArticleCover: (input) =>
              decodeOperation(() => workspace.setArticleCover(input), input.operationId),
            saveArticle: (input) =>
              decodeOperation(() => workspace.saveArticle(input), input.operationId),
          };
        },
        getBackgroundControl: () => {
          const control = brokerConnection.get(backgroundControlToken);
          return {
            connect: () => decode(connectResultCodec, () => control.connect()),
            disconnect: () => decode(disconnectResultCodec, () => control.disconnect()),
            getStatus: () => decode(controlStatusResultCodec, () => control.getStatus()),
            reload: () => decode(reloadResultCodec, () => control.reload()),
          };
        },
      };
    },
    catch: cliErrorFromUnknown,
  });
  if (Result.isError(servicesResult)) {
    return finishBrokerConnection(brokerConnection, Result.err(servicesResult.error));
  }
  const operation = await Result.tryPromise({
    try: () => run(servicesResult.value),
    catch: cliErrorFromUnknown,
  });
  return finishBrokerConnection(
    brokerConnection,
    Result.isError(operation) ? Result.err(operation.error) : operation.value,
  );
}

async function finishBrokerConnection<T>(
  connection: Awaited<ReturnType<Nexus["connect"]>>,
  operation: Outcome<T>,
): Promise<Outcome<T>> {
  const disconnected = await Result.try({
    try: () => connection.disconnect(),
    catch: () => cliError("broker_unavailable"),
  });
  if (disconnected.isErr()) {
    const diagnostic: InteractionIssue = {
      failure: {
        code: "cleanup_failed",
        cause: { at: "cli.cleanup", kind: "runtime", code: "broker_disconnect_failed" },
      },
    };
    if (operation.isErr() && operation.error.details?.operationId)
      return Result.err(
        cliError(operation.error.code, operation.error.instruction, {
          ...operation.error.details,
          issue: {
            ...(operation.error.details.issue ?? diagnostic),
            failure: {
              ...(operation.error.details.issue?.failure ?? diagnostic.failure),
              cleanup: diagnostic.failure.cause,
            },
          },
        }),
      );
    if (
      operation.isOk() &&
      typeof operation.value === "object" &&
      operation.value !== null &&
      "snapshot" in operation.value
    ) {
      const previous =
        "issue" in operation.value
          ? (operation.value.issue as InteractionIssue | undefined)
          : undefined;
      return Result.ok({
        ...operation.value,
        issue: previous
          ? {
              ...previous,
              failure: {
                ...previous.failure,
                cleanup: previous.failure.cleanup ?? diagnostic.failure.cause,
              },
            }
          : diagnostic,
      });
    }
  }
  if (Result.isError(disconnected))
    return Result.err(
      Result.isError(operation)
        ? cliError(operation.error.code, operation.error.instruction, {
            ...operation.error.details,
            cleanupFailed: true,
            ...(operation.error.details?.readFailure
              ? {
                  readFailure: {
                    ...operation.error.details.readFailure,
                    cleanup: operation.error.details.readFailure.cleanup ?? {
                      stage: "broker_cleanup",
                      kind: "runtime",
                      causeCode: "broker_disconnect_failed",
                    },
                  },
                }
              : {}),
            ...(operation.error.details?.connectionFailure
              ? {
                  connectionFailure: {
                    ...operation.error.details.connectionFailure,
                    cleanup: operation.error.details.connectionFailure.cleanup ?? {
                      stage: "broker_cleanup",
                      kind: "runtime",
                      causeCode: "broker_disconnect_failed",
                    },
                  },
                }
              : {}),
          })
        : cliError("broker_unavailable", undefined, {
            cleanupFailed: true,
          }),
    );
  return operation;
}

async function waitForStartedBroker(
  nexus: Nexus,
  target: { context: "node-ipc-daemon"; appId: string; instance: string },
  child: ReturnType<typeof spawn>,
  nonce: string,
): Promise<Outcome<{ connection: Awaited<ReturnType<typeof nexus.connect>>; owned: boolean }>> {
  let spawnFailure: Error | undefined;
  let exitCode: number | null | undefined;
  let signaled = false;
  let stdout = "";
  const stream = child.stdio[3] as Readable | null;
  const onData = (chunk: string) => {
    stdout += chunk;
    if (stdout.includes(`${nonce}\n`)) signaled = true;
  };
  stream?.setEncoding("utf8");
  stream?.on("data", onData);
  child.once("error", (error) => {
    spawnFailure = error;
  });
  child.once("exit", (code) => {
    exitCode = code;
  });
  child.unref();
  let reachable: Awaited<ReturnType<typeof nexus.connect>> | undefined;
  let reachableWithoutOwnership = false;
  const deadline = Date.now() + 5_000;
  try {
    while (Date.now() < deadline && !reachable && !spawnFailure) {
      const attempt = await nexus.safeConnect({ target, timeout: 300 });
      if (Result.isOk(attempt)) {
        if (ownsStartupBroker(signaled, exitCode)) {
          reachable = attempt.value;
          break;
        }
        if (exitCode !== undefined) {
          reachable = attempt.value;
          reachableWithoutOwnership = true;
          break;
        }
        const disconnected = Result.try({
          try: () => attempt.value.disconnect(),
          catch: () => cliError("broker_unavailable"),
        });
        if (Result.isError(disconnected)) return Result.err(disconnected.error);
        reachableWithoutOwnership = true;
      } else reachableWithoutOwnership = false;
      if (!signaled && exitCode !== undefined && reachableWithoutOwnership) break;
      if (!signaled) await pause(100);
    }
    if (!reachable && reachableWithoutOwnership) {
      const adopted = await nexus.safeConnect({ target, timeout: 300 });
      if (Result.isOk(adopted)) reachable = adopted.value;
    }
  } finally {
    stream?.off("data", onData);
    stream?.destroy();
  }
  if (reachable)
    return Result.ok({ connection: reachable, owned: ownsStartupBroker(signaled, exitCode) });
  return Result.err(cliError("broker_start_failed"));
}

type CliWireError = { code: string } & NonNullable<CliError["details"]>;

async function decode<T>(
  codec: { deserialize(value: unknown): Promise<BetterResult<T, CliWireError>> },
  wire: () => RemoteValue<unknown>,
  readOnly = false,
): Promise<Outcome<T>> {
  const received = await Result.tryPromise({
    try: async () => {
      const called = await Nexus.safeCall(wire());
      if (Result.isError(called)) throw called.error;
      return called.value;
    },
    catch: (error) => {
      const cli = cliErrorFromUnknown(error);
      return readOnly
        ? cliError(cli.code, cli.instruction, {
            readFailure: {
              stage: "workspace_call",
              kind: error instanceof NexusError ? "nexus" : "runtime",
              causeCode: error instanceof NexusError ? error.code : "unexpected_exception",
            },
          })
        : cli;
    },
  });
  if (Result.isError(received)) return Result.err(received.error);
  const decoded = await Result.tryPromise({
    try: () => codec.deserialize(received.value),
    catch: () => cliError("invalid_result_envelope"),
  });
  if (Result.isError(decoded)) return decoded;
  return Result.mapError(decoded.value, (error) => {
    const { code, ...details } = error;
    return cliError(code, undefined, details);
  });
}
async function decodeOperation(
  wire: () => RemoteValue<unknown>,
  operationId: string,
): Promise<Outcome<OperationReply>> {
  try {
    const called = await Nexus.safeCall(wire());
    if (called.isErr()) throw called.error;
    const decoded = await operationResultCodec.deserialize(called.value);
    if (decoded.isOk()) return Result.ok(decoded.value);
    const diagnostic: InteractionIssue =
      "failure" in decoded.error ? decoded.error : { operationId, failure: decoded.error };
    return Result.err(
      cliError(diagnostic.failure.code, `查询 operation status '${operationId}'；不要换键重做。`, {
        operationId,
        issue: diagnostic,
      }),
    );
  } catch (error) {
    return Result.err(
      cliError("operation_unresolved", `查询 operation status '${operationId}'；不要换键重做。`, {
        operationId,
        issue: {
          operationId,
          failure: {
            code: "operation_unresolved",
            cause: {
              at: "cli.call",
              kind: error instanceof NexusError ? "nexus" : "runtime",
              code: error instanceof NexusError ? error.code : "unexpected_exception",
            },
          },
        },
      }),
    );
  }
}

export function operationOutcome(reply: OperationReply, query: boolean): Outcome<OperationReply> {
  if (query) return Result.ok(reply);
  const snapshot = reply.snapshot;
  if (snapshot.state === "settled" && snapshot.result.status === "ok" && !reply.issue)
    return Result.ok(reply);
  const code =
    "result" in snapshot && snapshot.result.status === "error"
      ? snapshot.result.error.code
      : (reply.issue?.failure.code ?? "operation_unresolved");
  return Result.err(
    cliError(code, `查询 operation status '${snapshot.operationId}'；不要换键重做。`, {
      operationId: snapshot.operationId,
      snapshot,
      ...(reply.issue ? { issue: reply.issue } : {}),
    }),
  );
}

async function submitOperation(
  providedId: string | undefined,
  run: (workspace: DecodedWorkspace, operationId: string) => Promise<Outcome<OperationReply>>,
  callTimeout?: number,
): Promise<Outcome<OperationReply>> {
  if (providedId !== undefined && !v.safeParse(operationIdSchema, providedId).success)
    return Result.err(cliError("invalid_operation"));
  const result = await withConnection(
    async ({ workspace, keyLedgerId }) => {
      // Explicit old keys only query/claim history; never rotate or replace them.
      if (providedId === undefined && !keyLedgerId) return Result.err(cliError("storage_failed"));
      const operationId = providedId ?? createOperationId(keyLedgerId!);
      process.stderr.write(`operation ${operationId}\n`);
      return run(workspace, operationId);
    },
    { callTimeout },
  );
  return result.isErr() ? result : operationOutcome(result.value, false);
}

export async function submitBody(
  input: Omit<WriteBodyInput, "operationId">,
  providedId?: string,
): Promise<Outcome<OperationReply>> {
  return submitOperation(providedId, (workspace, operationId) =>
    workspace.writeBody({ ...input, operationId }),
  );
}
export async function submitNavigation(
  candidate: string | undefined,
  providedId?: string,
): Promise<Outcome<OperationReply>> {
  return submitOperation(
    providedId,
    (workspace, operationId) =>
      candidate === undefined
        ? workspace.newArticle({ operationId })
        : workspace.openArticle({ operationId, candidate }),
    articleNavigationTimeoutMs,
  );
}
export async function submitFields(
  input: Omit<UpdateFieldsInput, "operationId">,
  providedId?: string,
): Promise<Outcome<OperationReply>> {
  return submitOperation(providedId, (workspace, operationId) =>
    workspace.updateArticleFields({ ...input, operationId }),
  );
}
export async function operationStatus(id: string): Promise<Outcome<OperationReply>> {
  if (!v.safeParse(operationIdSchema, id).success) return Result.err(cliError("invalid_operation"));
  return withConnection(async ({ workspace }) => workspace.getOperation(id));
}

export async function submitCover(
  input:
    | Omit<Extract<ArticleCoverSetInput, { asset: string }>, "operationId">
    | Omit<Extract<ArticleCoverSetInput, { bodyImage: number }>, "operationId">,
  providedId?: string,
): Promise<Outcome<OperationReply>> {
  return submitOperation(
    providedId,
    (workspace, operationId) => workspace.setArticleCover({ ...input, operationId }),
    30_000,
  );
}
export async function submitSave(
  input: Omit<ArticleSaveInput, "operationId">,
  providedId?: string,
): Promise<Outcome<OperationReply>> {
  return submitOperation(
    providedId,
    (workspace, operationId) => workspace.saveArticle({ ...input, operationId }),
    60_000,
  );
}

export async function submitAsset(
  input: Omit<AssetUploadInput, "operationId">,
  providedId?: string,
): Promise<Outcome<OperationReply>> {
  return submitOperation(
    providedId,
    (workspace, operationId) => workspace.uploadAsset({ ...input, operationId }),
    20_000,
  );
}

export function ownsStartupBroker(
  startupSignaled: boolean,
  childExit: number | null | undefined,
): boolean {
  return startupSignaled && childExit === undefined;
}
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function withStartupReadinessPipe<T>(
  stream: Readable | null,
  wait: () => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  try {
    return await wait();
  } finally {
    stream?.destroy();
  }
}

export function friendlyError(
  error: CliError | NexusError,
): v.InferOutput<typeof cliDetailsSchema> & { code: string; instruction?: string } {
  if (error instanceof NexusError)
    return {
      code: error.code,
      ...(error.code === "E_CALL_TIMEOUT"
        ? { instruction: "超时不代表后台已停止；先核对页面/正文，不要直接重试。" }
        : {}),
    };
  const instructions: Record<string, string> = {
    not_connected: "运行 mpctl connect --extension <id> 获取连接指令。",
    not_logged_in: "在浏览器中登录公众号.",
    target_ambiguous:
      "检查 mpctl 分组中的重复页面；保留未保存内容，不要重复新建。已有新稿可用 current 读取。",
    content_conflict: "重新 pull，核对正文后再修改。",
    write_unknown: "pull 到另一个文件核对正文，不要直接重试 push。",
    cover_update_unknown: "封面设置结果未知；先读取当前封面，不要重试。",
    save_unknown: "保存结果未知；不要重试，重新打开并核对稿件状态。",
    asset_upload_unknown: "上传结果未知；先运行 asset list 核对，不要重试。",
    pairing_not_configured: "设置 MPCTL_PAIRING_CREDENTIAL 后重试。",
    pairing_config_permissions: "将配对配置权限限制为仅当前用户可读写。",
  };
  const instruction = error.details?.operationId
    ? error.instruction
    : error.details?.pageCreated
      ? "先查看已创建编辑页，不要直接重复 new/open。"
      : (error.instruction ?? instructions[error.code]);
  const details = v.safeParse(cliDetailsSchema, error.details ?? {});
  return {
    code: error.code,
    ...(details.success ? details.output : {}),
    ...(instruction ? { instruction } : {}),
  };
}

export function cliErrorFromUnknown(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof NexusError)
    return cliError(
      error.code,
      error.code === "E_CALL_TIMEOUT"
        ? "超时不代表后台已停止；先核对页面/正文，不要直接重试。"
        : undefined,
    );
  return cliError("broker_unavailable", "检查 broker 安装或运行 mpctl broker start。");
}
