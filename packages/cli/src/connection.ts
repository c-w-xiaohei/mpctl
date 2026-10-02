import { Nexus, NexusError } from "@nexus-js/core";
import { Result } from "better-result";
import type { Result as BetterResult } from "better-result";
import { usingNodeIpcClient } from "@nexus-js/node-ipc";
import {
  cleanupWorkspaceResultCodec,
  listArticlesResultCodec,
  articleResultCodec,
  workspaceResultCodec,
  writeBodyResultCodec,
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
  type WorkspaceError,
  type ServiceError,
  type ArticleCandidate,
  type ArticleResult,
  articleNavigationStages,
} from "@mpctl/contracts";
import type { NodeIpcSocketAddress } from "@nexus-js/node-ipc";
import { spawn } from "node:child_process";
import { saveBrokerCredential, loadBrokerCredential } from "./broker-settings.js";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import path from "node:path";

export class CliError {
  readonly code: string;
  constructor(
    code: string,
    readonly instruction?: string,
    readonly details?: Pick<WorkspaceError, "stage" | "pageCreated"> & {
      connectionPageUrl?: string;
      cleanupFailed?: true;
    },
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
  openArticle(candidate: string): Promise<Outcome<ArticleResult>>;
  newArticle(): Promise<Outcome<ArticleResult>>;
  currentArticle(): Promise<Outcome<ArticleResult>>;
  readBody(article: string): Promise<Outcome<{ html: string; bodyHash: string }>>;
  writeBody(
    article: string,
    html: string,
    expectedHash: string,
  ): Promise<Outcome<{ bodyHash: string }>>;
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
  run: (services: { workspace: DecodedWorkspace }) => Promise<Outcome<T>>,
  options: { callTimeout?: number } = {},
): Promise<Outcome<T>> {
  return withBroker(async (services) => {
    const status = await services.connection.getStatus();
    if (Result.isError(status)) return Result.err(cliError(status.error.code));
    if (!status.value.connected) return Result.err(cliError("not_connected"));
    if (status.value.extensionVersion && status.value.extensionVersion !== protocolVersion)
      return Result.err(
        cliError("version_mismatch", "更新插件后重试；status --details 可查看版本"),
      );
    return run({ workspace: services.getWorkspace(options.callTimeout) });
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
      return nexus;
    },
    catch: () => cliError("broker_unavailable"),
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
    catch: () => cliError("broker_unavailable"),
  });
  console.warn = oldWarn;
  if (Result.isError(ready)) return ready;

  const target = { context: "node-ipc-daemon" as const, appId: "mpctl", instance: "default" };
  let brokerStarted = false;
  const initialConnection = await connectRemote(nexus, target, 700);
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
      const remoteConnection = brokerConnection.get(connectionToken);
      return {
        connection: {
          getStatus: () => decode(connectionStatusResultCodec, () => remoteConnection.getStatus()),
        },
        brokerStarted,
        getWorkspace: (timeout = 30_000) => {
          const workspace = brokerConnection.get(workspaceToken, { callTimeout: timeout });
          return {
            cleanupWorkspace: () =>
              decode(cleanupWorkspaceResultCodec, () => workspace.cleanupWorkspace()),
            listArticles: () => decode(listArticlesResultCodec, () => workspace.listArticles()),
            openArticle: (candidate) =>
              decode(articleResultCodec, () => workspace.openArticle(candidate)),
            newArticle: () => decode(articleResultCodec, () => workspace.newArticle()),
            currentArticle: () => decode(articleResultCodec, () => workspace.currentArticle()),
            readBody: (article) => decode(workspaceResultCodec, () => workspace.readBody(article)),
            writeBody: async (article, html, expected) =>
              decodeWrite(() => workspace.writeBody(article, html, expected)),
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
  if (Result.isError(disconnected))
    return Result.err(
      Result.isError(operation)
        ? cliError(operation.error.code, operation.error.instruction, {
            ...operation.error.details,
            cleanupFailed: true,
          })
        : cliError("broker_unavailable", undefined, { cleanupFailed: true }),
    );
  return operation;
}

async function connectRemote(
  nexus: Nexus,
  target: { context: "node-ipc-daemon"; appId: string; instance: string },
  timeout: number,
): Promise<BetterResult<Awaited<ReturnType<typeof nexus.connect>>, unknown>> {
  return Result.tryPromise({
    try: () => nexus.connect({ target, timeout }),
    catch: (error) => error,
  });
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
      const attempt = await connectRemote(nexus, target, 300);
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
      const adopted = await connectRemote(nexus, target, 300);
      if (Result.isOk(adopted)) reachable = adopted.value;
    }
  } finally {
    stream?.off("data", onData);
    stream?.destroy();
  }
  if (reachable)
    return Result.ok({ connection: reachable, owned: ownsStartupBroker(signaled, exitCode) });
  return Result.err(cliError(spawnFailure ? "broker_start_failed" : "broker_start_failed"));
}

async function decode<T, E>(
  codec: { deserialize(value: unknown): Promise<BetterResult<T, ServiceError<E>>> },
  wire: () => PromiseLike<unknown>,
): Promise<Outcome<T>> {
  const received = await Result.tryPromise({
    try: () => Promise.resolve(wire()),
    catch: cliErrorFromUnknown,
  });
  if (Result.isError(received)) return Result.err(received.error);
  const decoded = await Result.tryPromise({
    try: () => codec.deserialize(received.value),
    catch: () => cliError("invalid_result_envelope"),
  });
  if (Result.isError(decoded)) return decoded;
  return Result.mapError(decoded.value, (error) => {
    const details =
      typeof error === "object" &&
      error !== null &&
      "stage" in error &&
      typeof error.stage === "string" &&
      articleNavigationStages.some((stage) => stage === error.stage)
        ? {
            stage: error.stage as WorkspaceError["stage"],
            ...("pageCreated" in error && error.pageCreated === true ? { pageCreated: true } : {}),
          }
        : undefined;
    return cliError(
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "invalid_result_envelope",
      undefined,
      details,
    );
  });
}
async function decodeWrite(
  wire: () => PromiseLike<unknown>,
): Promise<Outcome<{ bodyHash: string }>> {
  const received = await Result.tryPromise({
    try: () => Promise.resolve(wire()),
    catch: () => cliError("write_unknown", "先 pull 到另一个文件检查当前正文，不要直接重试 push"),
  });
  if (Result.isError(received)) return Result.err(received.error);
  const decoded = await Result.tryPromise({
    try: () => writeBodyResultCodec.deserialize(received.value),
    catch: () => cliError("invalid_result_envelope"),
  });
  if (Result.isError(decoded)) return decoded;
  return Result.mapError(decoded.value, (error) => cliError(error.code));
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

export function friendlyError(error: CliError | NexusError): {
  code: string;
  instruction?: string;
  stage?: string;
  pageCreated?: boolean;
  connectionPageUrl?: string;
  cleanupFailed?: true;
} {
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
    content_conflict: "重新 pull，核对正文后再修改。",
    write_unknown: "pull 到另一个文件核对正文，不要直接重试 push。",
    pairing_not_configured: "设置 MPCTL_PAIRING_CREDENTIAL 后重试。",
    pairing_config_permissions: "将配对配置权限限制为仅当前用户可读写。",
  };
  const instruction = error.details?.pageCreated
    ? "先查看已创建编辑页，不要直接重复 new/open。"
    : (error.instruction ?? instructions[error.code]);
  return {
    code: error.code,
    ...(error.details?.stage ? { stage: error.details.stage } : {}),
    ...(error.details?.pageCreated ? { pageCreated: true } : {}),
    ...(error.details?.connectionPageUrl
      ? { connectionPageUrl: error.details.connectionPageUrl }
      : {}),
    ...(error.details?.cleanupFailed ? { cleanupFailed: true } : {}),
    ...(instruction ? { instruction } : {}),
  };
}

export function cliErrorFromUnknown(error: unknown): CliError {
  if (error instanceof NexusError)
    return cliError(
      error.code,
      error.code === "E_CALL_TIMEOUT"
        ? "超时不代表后台已停止；先核对页面/正文，不要直接重试。"
        : undefined,
    );
  return cliError("broker_unavailable", "检查 broker 安装或运行 mpctl broker start。");
}
