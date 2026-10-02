import { Result, type Result as BetterResult } from "better-result";

const reconnectKey = "reconnectAfterReloadUntil";
const reconnectWindowMs = 30_000;
export type ReloadError = {
  code: "storage_failed" | "connect_failed" | "reload_failed";
  cleanupFailed?: boolean;
};

export function createReloadControl(options: {
  storage: Pick<typeof chrome.storage.local, "get" | "set" | "remove">;
  connect(): Promise<BetterResult<void, { code: "connect_failed" | "invalid_result_envelope" }>>;
  reload(): BetterResult<void, ReloadError>;
  report?(result: BetterResult<void, ReloadError>): void;
  reportCleanup?(result: BetterResult<void, ReloadError>): void;
}) {
  const storageResult = <T>(operation: () => Promise<T>) =>
    Result.tryPromise({
      try: operation,
      catch: () => ({ code: "storage_failed" as const }),
    });
  return {
    async reload(): Promise<BetterResult<void, ReloadError>> {
      const stored = await storageResult(() =>
        options.storage.set({
          [reconnectKey]: Date.now() + reconnectWindowMs,
        }),
      );
      if (stored.isErr()) return stored;
      // Ok means the one-shot intent was stored and reload was scheduled, not executed.
      setTimeout(async () => {
        const reloaded = Result.try({
          try: () => options.reload(),
          catch: () => ({ code: "reload_failed" as const }),
        });
        const reloadResult = reloaded.isErr() ? reloaded : reloaded.value;
        if (reloadResult.isOk()) return;
        const cleanup = await storageResult(() => options.storage.remove(reconnectKey));
        const failure = cleanup.isErr()
          ? Result.err({ ...reloadResult.error, cleanupFailed: true })
          : reloadResult;
        const reported = Result.try({
          try: () =>
            options.report
              ? options.report(failure)
              : console.error(
                  `mpctl scheduled reload failed: ${failure.isErr() ? failure.error.code : "unknown"}`,
                ),
          catch: () => ({ code: "reload_failed" as const }),
        });
        if (reported.isErr()) console.error("mpctl scheduled reload report failed");
        if (cleanup.isErr()) {
          const cleanupReported = Result.try({
            try: () =>
              options.reportCleanup
                ? options.reportCleanup(cleanup)
                : console.error("mpctl reload marker cleanup failed: storage_failed"),
            catch: () => ({ code: "storage_failed" as const }),
          });
          if (cleanupReported.isErr()) console.error("mpctl reload marker cleanup report failed");
        }
      }, 0);
      return Result.ok(undefined);
    },
    async resume(): Promise<BetterResult<void, ReloadError>> {
      const read = await storageResult(() => options.storage.get(reconnectKey));
      if (read.isErr()) return read;
      const until = read.value[reconnectKey];
      if (until === undefined) return Result.ok(undefined);
      const consumed = await storageResult(() => options.storage.remove(reconnectKey));
      if (consumed.isErr()) return consumed;
      if (
        typeof until !== "number" ||
        until <= Date.now() ||
        until > Date.now() + reconnectWindowMs
      )
        return Result.ok(undefined);
      const connected = Result.flatten(
        await Result.tryPromise({
          try: options.connect,
          catch: () => ({ code: "connect_failed" as const }),
        }),
      );
      return connected.isErr() ? Result.err({ code: "connect_failed" }) : Result.ok(undefined);
    },
  };
}
