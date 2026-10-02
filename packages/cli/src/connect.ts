import { Result } from "better-result";
import type { Result as BetterResult } from "better-result";
import { pause, withBroker, cliError, type CliError } from "./connection.js";

type Outcome<T> = BetterResult<T, CliError>;
type Status = { connected: boolean; sessionId?: string };

export async function connectCommand(options: {
  reload?: boolean;
  extension?: string;
}): Promise<Outcome<{ connected: true }>> {
  const extensionId = options.extension;
  if (extensionId && !/^[a-p]{32}$/.test(extensionId))
    return Result.err(cliError("invalid_command", "--extension 必须是 32 位扩展 ID"));
  const handoff = connectionHandoff(extensionId);
  if (!options.reload) {
    const status = await withBroker(({ connection }) =>
      connection
        .getStatus()
        .then((result) =>
          Result.isError(result)
            ? Result.err(cliError(result.error.code))
            : result.value.connected
              ? Result.ok({ connected: true as const })
              : Result.err(handoff),
        ),
    );
    return status;
  }
  const initial = await readStatus();
  if (Result.isError(initial)) return initial;
  if (!initial.value.connected) return Result.err(handoff);
  if (!initial.value.sessionId)
    return Result.err(cliError("reload_failed", "请更新 broker 后重试重载"));

  const reloadResult = await withBroker(async ({ getBackgroundControl }) => {
    const result = await getBackgroundControl().reload();
    return Result.isError(result) ? Result.err(cliError(result.error.code)) : Result.ok(undefined);
  });
  if (Result.isError(reloadResult) && !isExpectedReloadDisconnect(reloadResult.error))
    return reloadResult;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await readStatus();
    if (Result.isError(current)) return current;
    if (
      current.value.connected &&
      current.value.sessionId &&
      current.value.sessionId !== initial.value.sessionId
    )
      return Result.ok({ connected: true });
    await pause(100);
  }
  return Result.err(connectionHandoff(extensionId, "reload_failed"));
}

async function readStatus(): Promise<Outcome<Status>> {
  return withBroker(async ({ connection }) => {
    const result = await connection.getStatus();
    return Result.isError(result)
      ? Result.err(cliError(result.error.code))
      : Result.ok(result.value);
  });
}
function isExpectedReloadDisconnect(error: CliError): boolean {
  return ["E_CONN_CLOSED", "E_CALL_TIMEOUT"].includes(error.code);
}
function connectionHandoff(extensionId?: string, code = "not_connected"): CliError {
  return cliError(
    code,
    extensionId
      ? "在实际运行且安装该扩展的浏览器/profile 中打开 connectionPageUrl，再用 mpctl status 确认连接。"
      : "用 connect --extension <id> 获取连接页 URL，或在扩展界面连接；用 mpctl status 确认。",
    extensionId
      ? { connectionPageUrl: `chrome-extension://${extensionId}/connect.html` }
      : undefined,
  );
}
