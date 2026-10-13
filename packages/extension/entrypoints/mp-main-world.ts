import { Nexus } from "@nexus-js/core";
import { protocolVersion } from "@mpctl/contracts";
import { hasPreparationVersion } from "../src/background-runtime";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { createEditorService, type EditorJsapi } from "../src/mp/jsapi";
import { createEditorTargetValidator } from "../src/mp/editor";
import { pageEditorToken } from "../src/page-contracts";
import { createPageEndpoint } from "../src/transport/page-bridge";
import { Result } from "better-result";

type MainBootstrapError = {
  code: "main_startup_failed" | "main_cleanup_failed";
  cleanupFailed?: true;
};

export async function awaitMainWorldReady(
  ready: Promise<unknown>,
  closeEndpoint: () => Promise<unknown> | unknown,
): Promise<Result<void, MainBootstrapError>> {
  const started = await Result.tryPromise({
    try: async () => ready,
    catch: () => ({ code: "main_startup_failed" as const }),
  });
  if (Result.isOk(started)) return Result.ok();
  const cleanup = await Result.tryPromise({
    try: async () => closeEndpoint(),
    catch: () => ({ code: "main_cleanup_failed" as const }),
  });
  return Result.isError(cleanup) ? Result.err({ ...started.error, cleanupFailed: true }) : started;
}

export async function disposeMainWorldEndpoint(
  closeEndpoint: () => Promise<unknown> | unknown,
): Promise<Result<void, MainBootstrapError>> {
  const disposed = await Result.tryPromise({
    try: async () => closeEndpoint(),
    catch: () => ({ code: "main_cleanup_failed" as const }),
  });
  return Result.isError(disposed) ? Result.err(disposed.error) : Result.ok();
}

export async function mountMainWorldBridge(
  script: HTMLScriptElement,
  target: EventTarget = document,
): Promise<Result<{ dispose(): Promise<Result<void, MainBootstrapError>> }, MainBootstrapError>> {
  const channelId = script.dataset.mpctlChannel;
  const inbound = script.dataset.mpctlInbound;
  const outbound = script.dataset.mpctlOutbound;
  if (!channelId || !inbound || !outbound) {
    // `script` is created only by injectMainWorldBridge, which writes all three dataset fields.
    // Missing values therefore indicate a malformed trusted generated bootstrap, not an expected
    // editor-not-ready or page-operation failure.
    throw new Error("MAIN world editor bridge bootstrap parameters are unavailable");
  }
  let createdEndpoint: ReturnType<typeof createPageEndpoint> | undefined;
  let active = true;
  const endpointSetup = Result.try({
    try: () => {
      createdEndpoint = createPageEndpoint({
        target,
        channelId,
        side: "main",
        eventNames: { fromIsolated: inbound, fromMain: outbound },
        onClose() {
          active = false;
        },
      });
      const instance = new Nexus()
        .provide(
          pageEditorToken,
          createEditorService({
            document,
            validateTarget: (() => {
              const isTarget = createEditorTargetValidator(document);
              return () => active && isTarget();
            })(),
            get invoke() {
              const page = window as Window & { __MP_Editor_JSAPI__?: EditorJsapi };
              const current = page.__MP_Editor_JSAPI__;
              return typeof current?.invoke === "function"
                ? current.invoke.bind(current)
                : undefined;
            },
          }),
        )
        .configure({
          endpoint: { implementation: createdEndpoint, meta: { app: { protocolVersion } } },
          policy: {
            canConnect: ({ remoteIdentity }) => hasPreparationVersion(remoteIdentity),
            canCall: ({ remoteIdentity }) => hasPreparationVersion(remoteIdentity),
          },
        });
      return { endpoint: createdEndpoint, instance };
    },
    catch: () => ({ code: "main_startup_failed" as const }),
  });
  if (Result.isError(endpointSetup)) {
    if (createdEndpoint) {
      const cleanup = await Result.tryPromise({
        try: async () => createdEndpoint?.close?.(),
        catch: () => ({ code: "main_cleanup_failed" as const }),
      });
      if (Result.isError(cleanup))
        return Result.err({ ...endpointSetup.error, cleanupFailed: true });
    }
    return endpointSetup;
  }
  const { endpoint, instance } = endpointSetup.value;
  const ready = await awaitMainWorldReady(instance.ready(), () => endpoint.close?.());
  if (Result.isError(ready)) return ready;
  return Result.ok({
    async dispose() {
      active = false;
      return disposeMainWorldEndpoint(() => endpoint.close?.());
    },
  });
}

export default defineUnlistedScript(() => {
  const script = document.currentScript;
  if (script instanceof HTMLScriptElement) {
    void mountMainWorldBridge(script).then(
      (result) => {
        if (Result.isError(result)) console.error("mpctl MAIN startup failed", result.error);
      },
      (error) => console.error("mpctl MAIN startup failed", error),
    );
  }
});
