import { Result, type Result as BetterResult } from "better-result";
import { configureNexusDebug } from "@mpctl/contracts/nexus-debug";
import { createBackgroundControlClient } from "../../src/popup-control";
import { connectFromPage, connectionFailureMessage } from "../../src/connection-page";
import "../../src/connection-ui.css";

configureNexusDebug(
  "connect",
  Boolean(import.meta.env.DEV) && import.meta.env.VITE_MPCTL_NEXUS_DEBUG !== "0",
);
const report = (scope: string, code: string) => console.error(`mpctl ${scope} failed: ${code}`);

export async function closeConnectPageTab(
  tabs: {
    getCurrent(): Promise<{ id?: number } | undefined>;
    remove(tabId: number): Promise<void>;
  },
  errorCode?: string,
  reportFailure = report,
): Promise<BetterResult<void, { code: string }>> {
  if (errorCode) reportFailure("connect page", errorCode);
  const tab = await Result.tryPromise({
    try: () => tabs.getCurrent(),
    catch: () => ({ code: "tab_lookup_failed" as const }),
  });
  if (tab.isErr()) return tab;
  if (tab.value?.id === undefined) return Result.err({ code: "tab_unavailable" });
  const id = tab.value.id;
  return Result.tryPromise({
    try: () => tabs.remove(id),
    catch: () => ({ code: "tab_close_failed" as const }),
  });
}

/**
 * Connect 页只是主动触发连接的中转入口，不负责等待或展示 WebSocket 的最终结果。
 * attempt 成功表示 BG 已确认接手连接任务，此时立即关闭页面；不是等到握手成功再关闭。
 * 必须等到 BG 确认，不能在仅建立到 BG 的通信连接或发出请求后就关页，以免请求丢失。
 * 后续连接由 BG 独立完成，页面关闭不应取消它；交接失败则保留页面供用户重试。
 */
export async function runConnectPageAttempt<T>(
  attempt: () => Promise<BetterResult<T, { code: string }>>,
  tabs: Parameters<typeof closeConnectPageTab>[0],
  reportFailure = report,
): Promise<BetterResult<T, { code: string }>> {
  let result: BetterResult<T, { code: string }>;
  try {
    result = await attempt();
  } catch {
    result = Result.err({ code: "unexpected_failure" });
  }
  if (result.isErr()) {
    reportFailure("connect page", result.error.code);
    return result;
  }
  const closed = await closeConnectPageTab(tabs);
  if (closed.isErr()) reportFailure("connect page tab close", closed.error.code);
  return result;
}

async function connect() {
  const status = document.getElementById("status")!;
  const diagnostic = document.getElementById("diagnostic")!;
  const retry = document.getElementById("retry") as HTMLButtonElement;
  retry.hidden = true;
  status.textContent = "正在发起连接，此页面将自动关闭。";
  const control = createBackgroundControlClient(1_000);
  try {
    const result = await runConnectPageAttempt(
      () =>
        connectFromPage(async () => {
          const acquired = await control.get();
          return acquired.isErr()
            ? Result.err({ code: "background_unavailable" as const })
            : acquired;
        }),
      chrome.tabs,
    );
    status.textContent = connectionFailureMessage(result);
    if (result.isErr()) {
      retry.hidden = false;
      if (import.meta.env.DEV) {
        diagnostic.hidden = false;
        diagnostic.textContent = `诊断：${result.error.code}`;
      }
    }
  } finally {
    const cleaned = control.dispose();
    if (cleaned.isErr()) report("connect page cleanup", cleaned.error.code);
  }
}

if (typeof document !== "undefined") {
  const retry = document.getElementById("retry");
  const run = () => {
    void connect().catch(() => {
      document.getElementById("status")!.textContent = "暂时无法发起连接，请重试。";
      if (retry) retry.hidden = false;
      report("connect page", "unexpected_failure");
    });
  };
  retry?.addEventListener("click", run);
  run();
}
