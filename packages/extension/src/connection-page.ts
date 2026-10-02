import { Result, type Result as BetterResult } from "better-result";

export type ConnectionPageError = { code: "background_timeout" | "background_unavailable" };
export type PageConnectError = {
  code:
    | "invalid_result_envelope"
    | "connect_failed"
    | "disconnect_failed"
    | "reload_failed"
    | "status_failed";
};
type PageControl = {
  connect(): Promise<BetterResult<{ connected: boolean }, PageConnectError>>;
};

export async function connectFromPage(
  getControl: () => Promise<BetterResult<PageControl, ConnectionPageError>>,
  timeoutMs = 5_000,
): Promise<BetterResult<{ connected: boolean }, ConnectionPageError | PageConnectError>> {
  const deadline = Date.now() + timeoutMs;
  let lastAcquisitionError: ConnectionPageError | undefined;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const acquired = await Promise.race([
      Result.tryPromise({
        try: async () => await getControl(),
        catch: () => ({ code: "background_unavailable" as const }),
      }).then((result) => Result.flatten(result)),
      new Promise<BetterResult<never, ConnectionPageError>>((resolve) => {
        setTimeout(() => resolve(Result.err({ code: "background_timeout" })), remaining);
      }),
    ]);
    if (acquired.isOk()) {
      const connected = await Result.tryPromise({
        try: async () => await acquired.value.connect(),
        catch: () => ({ code: "connect_failed" as const }),
      });
      return connected.isErr() ? connected : connected.value;
    }
    if (acquired.error.code === "background_timeout") continue;
    lastAcquisitionError = acquired.error;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
  }
  return Result.err(lastAcquisitionError ?? { code: "background_timeout" });
}

export function connectionFailureMessage(
  result: BetterResult<{ connected: boolean }, { code: string }>,
) {
  return result.match({
    ok: ({ connected }) => (connected ? "已连接，可继续使用 CLI。" : "未连接，请检查配对配置。"),
    err: () => "连接失败，请检查插件配对配置与本地 broker。",
  });
}
