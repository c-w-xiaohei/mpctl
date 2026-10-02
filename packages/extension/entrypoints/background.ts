import { defineBackground } from "wxt/utils/define-background";
import { Result } from "better-result";
import { backgroundControlToken } from "../src/background-contracts";
import { createBackgroundScriptConfig } from "@nexus-js/chrome";
import { backgroundNexus } from "../src/background-runtime";
import {
  createBackgroundControl,
  createConnectionController,
  readConnectionSettings,
} from "../src/connection";
import { createWorkspace } from "../src/workspace";
import { createPageManager, restorePagesOnStartup } from "../src/pages";
import { createReloadControl } from "../src/reload";

export default defineBackground(() => {
  const reportResult = (scope: string, result: { isErr(): boolean; error?: { code?: string } }) => {
    if (result.isErr()) console.error(`mpctl ${scope} failed: ${result.error?.code ?? "unknown"}`);
  };
  const pages = createPageManager();
  restorePagesOnStartup(
    async () => {
      const restored = await pages
        .restore()
        .catch(() => Result.err({ code: "page_restore_failed" as const }));
      reportResult("startup page restoration", restored);
      return Result.ok(undefined);
    },
    (listener) => chrome.runtime.onStartup.addListener(listener),
  );
  const workspace = createWorkspace({ pages });
  const reloadControl = createReloadControl({
    storage: chrome.storage.local,
    connect: async () => {
      const connected = await controller.connect();
      return connected.isErr()
        ? Result.err({ code: "connect_failed" as const })
        : Result.ok(undefined);
    },
    reload: () =>
      Result.try({
        try: () => chrome.runtime.reload(),
        catch: () => ({ code: "reload_failed" as const }),
      }),
    report: (result) => reportResult("scheduled reload", result),
    reportCleanup: (result) => reportResult("reload marker cleanup", result),
  });
  let controller!: ReturnType<typeof createConnectionController>;
  const control = createBackgroundControl({
    controller: () => controller,
    reload: () => reloadControl.reload(),
  });
  controller = createConnectionController({
    loadSettings: readConnectionSettings,
    workspace,
    control,
  });
  const configured = Result.try({
    try: () =>
      backgroundNexus.configure({
        ...createBackgroundScriptConfig(),
        providers: [
          {
            token: backgroundControlToken,
            service: control,
          },
        ],
      }),
    catch: () => ({ code: "background_start_failed" as const }),
  });
  if (configured.isErr()) {
    console.error(`mpctl background setup failed: ${configured.error.code}`);
    return;
  }
  backgroundNexus.onConnect((connection) => {
    const observed = connection.connectionMeta.observed;
    connection.subscribeIdentity(() => {
      pages.observeConnection(observed?.tabId, observed?.documentId, observed?.sender?.url);
    });
  });
  void Result.tryPromise({
    try: () => backgroundNexus.ready(),
    catch: () => ({ code: "background_start_failed" as const }),
  })
    .then(async (ready) => {
      if (ready.isErr()) {
        console.error(`mpctl background startup failed: ${ready.error.code}`);
        return;
      }
      reportResult("reload resume", await reloadControl.resume());
    })
    .catch(() => console.error("mpctl background supervision failed: unexpected_failure"));
});
