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
  requestConnect(): Promise<BetterResult<void, PageConnectError>>;
};

export async function connectFromPage(
  getControl: () => Promise<BetterResult<PageControl, ConnectionPageError>>,
  timeoutMs = 5_000,
): Promise<BetterResult<void, ConnectionPageError | PageConnectError>> {
  const deadline = Date.now() + timeoutMs;
  let lastAcquisitionError: ConnectionPageError | undefined;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const acquired = await Promise.race([
      Result.tryPromise({
        try: async () => await getControl(),
        catch: () => ({ code: "background_unavailable" as const }),
      }).then((result) => Result.flatten(result)),
      new Promise<BetterResult<never, ConnectionPageError>>((resolve) => {
        timer = setTimeout(() => resolve(Result.err({ code: "background_timeout" })), remaining);
      }),
    ]);
    clearTimeout(timer);
    if (Date.now() >= deadline) return Result.err({ code: "background_timeout" });
    if (acquired.isOk()) {
      const connected = await Result.tryPromise({
        try: async () => await acquired.value.requestConnect(),
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

export function connectionFailureMessage(result: BetterResult<void, { code: string }>) {
  return result.match({
    ok: () => "已发起连接，可以关闭此页面。",
    err: () => "暂时无法发起连接，请重试。",
  });
}
