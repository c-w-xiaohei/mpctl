import { chromeTarget, createPopupConfig } from "@nexus-js/chrome";
import { Nexus } from "@nexus-js/core";
import { Result, type Result as BetterResult } from "better-result";
import { backgroundControlToken } from "../../src/background-contracts";
import {
  connectResultCodec,
  disconnectResultCodec,
  controlStatusResultCodec,
} from "@mpctl/contracts";
import { createPopupControl } from "../../src/popup-control";
import { connectFromPage, connectionFailureMessage } from "../../src/connection-page";

const report = (scope: string, code: string) => console.error(`mpctl ${scope} failed: ${code}`);
let activeEndpoint: ReturnType<typeof createPopupConfig>["endpoint"];
let endpointCleanupAttempted = false;

export async function closeConnectPageTab(
  tabs: {
    getCurrent(): Promise<{ id?: number } | undefined>;
    remove(tabId: number): Promise<void>;
  },
  errorCode?: string,
  reportFailure = report,
): Promise<
  ReturnType<typeof Result.ok<void>> | ReturnType<typeof Result.err<void, { code: string }>>
> {
  if (errorCode) reportFailure("connect page", errorCode);
  const tab = await Result.tryPromise({
    try: () => tabs.getCurrent(),
    catch: () => ({ code: "tab_lookup_failed" as const }),
  });
  if (tab.isErr()) return tab;
  if (tab.value?.id === undefined) return Result.err({ code: "tab_unavailable" });
  return Result.tryPromise({
    try: () => tabs.remove(tab.value!.id!),
    catch: () => ({ code: "tab_close_failed" as const }),
  });
}

export async function runConnectPageAttempt<T>(
  attempt: () => Promise<BetterResult<T, { code: string }>>,
  tabs: Parameters<typeof closeConnectPageTab>[0],
  reportFailure = report,
): Promise<
  BetterResult<
    T,
    { code: string } | { code: "tab_lookup_failed" | "tab_unavailable" | "tab_close_failed" }
  >
> {
  let result: BetterResult<T, { code: string }>;
  try {
    result = await attempt();
  } catch {
    result = Result.err({ code: "unexpected_failure" });
  }
  if (result.isErr()) reportFailure("connect page", result.error.code);
  const closed = await closeConnectPageTab(tabs);
  if (closed.isErr()) reportFailure("connect page tab close", closed.error.code);
  return result;
}

async function connect() {
  const status = document.getElementById("status")!;
  endpointCleanupAttempted = false;
  await runConnectPageAttempt(async () => {
    const control = createPopupControl(() => {
      const runtimeResult = Result.try({
        try: () => new Nexus(),
        catch: () => ({ code: "runtime_unavailable" as const }),
      });
      if (runtimeResult.isErr()) return runtimeResult;
      const runtime = runtimeResult.value;
      const configResult = Result.try({
        try: () => createPopupConfig(),
        catch: () => ({ code: "runtime_unavailable" as const }),
      });
      if (configResult.isErr()) return configResult;
      const config = configResult.value;
      const endpoint = config.endpoint?.implementation;
      if (!endpoint) return Result.err({ code: "runtime_unavailable" as const });
      activeEndpoint = config.endpoint;
      const configured = Result.try({
        try: () => runtime.configure(config),
        catch: () => ({ code: "runtime_unavailable" as const }),
      });
      if (configured.isErr()) {
        const cleanup = Result.try({
          try: () => endpoint.close(),
          catch: () => ({ code: "runtime_unavailable" as const }),
        });
        endpointCleanupAttempted = true;
        return cleanup.isErr()
          ? Result.err({ ...configured.error, cleanupFailed: true, cleanupAttempted: true })
          : Result.err({ ...configured.error, cleanupAttempted: true });
      }
      return Result.ok({
        runtime: {
          ready: () => runtime.ready(),
          connect: async () => {
            const connection = await Result.tryPromise({
              try: () =>
                runtime.connect({
                  target: chromeTarget.background(),
                  timeout: 1_000,
                }),
              catch: () => ({ code: "background_unavailable" as const }),
            });
            if (connection.isErr()) return connection;
            return Result.try({
              try: () => connection.value.get(backgroundControlToken),
              catch: () => ({ code: "background_unavailable" as const }),
            });
          },
        },
        endpoint,
      });
    });
    const acquired = await control.get();
    if (acquired.isErr()) {
      const cleanupAttempted =
        "cleanupAttempted" in acquired.error && acquired.error.cleanupAttempted;
      const cleanupFailed = "cleanupFailed" in acquired.error && acquired.error.cleanupFailed;
      status.textContent = `后台暂不可用，请重试。${cleanupFailed ? "清理连接失败。" : ""}`;
      if (!cleanupAttempted) {
        endpointCleanupAttempted = true;
        const cleanup = Result.try({
          try: () => activeEndpoint?.implementation.close(),
          catch: () => ({ code: "cleanup_failed" as const }),
        });
        if (cleanup.isErr()) report("connect page cleanup", cleanup.error.code);
      }
      return Result.err(acquired.error);
    }
    const wire = acquired.value;
    const controlProxy = {
      connect: async () => {
        const result = await Result.tryPromise({
          try: async () => await wire.connect(),
          catch: () => ({ code: "connect_failed" as const }),
        });
        return result.isErr() ? result : connectResultCodec.deserialize(result.value);
      },
      disconnect: async () => {
        const result = await Result.tryPromise({
          try: async () => await wire.disconnect(),
          catch: () => ({ code: "disconnect_failed" as const }),
        });
        return result.isErr() ? result : disconnectResultCodec.deserialize(result.value);
      },
      getStatus: async () => {
        const result = await Result.tryPromise({
          try: async () => await wire.getStatus(),
          catch: () => ({ code: "status_failed" as const }),
        });
        return result.isErr() ? result : controlStatusResultCodec.deserialize(result.value);
      },
    };
    const result = await connectFromPage(async () => Result.ok(controlProxy));
    if (result.isErr()) {
      status.textContent = connectionFailureMessage(result);
    } else status.textContent = connectionFailureMessage(result);
    const cleanup = Result.try({
      try: () => activeEndpoint?.implementation.close(),
      catch: () => ({ code: "cleanup_failed" as const }),
    });
    endpointCleanupAttempted = true;
    if (cleanup.isErr()) report("connect page cleanup", cleanup.error.code);
    return result;
  }, chrome.tabs);
}

if (typeof document !== "undefined")
  void connect().catch(() => {
    report("connect page", "unexpected_failure");
    if (!endpointCleanupAttempted) {
      endpointCleanupAttempted = true;
      const cleanup = Result.try({
        try: () => activeEndpoint?.implementation.close(),
        catch: () => ({ code: "cleanup_failed" as const }),
      });
      if (cleanup.isErr()) report("connect page cleanup", cleanup.error.code);
    }
  });
