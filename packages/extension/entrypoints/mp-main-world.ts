import { Nexus } from "@nexus-js/core";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { createEditorService, type EditorJsapi } from "../src/mp/jsapi";
import { createEditorTargetValidator } from "../src/mp/editor";
import { pageEditorToken } from "../src/page-contracts";
import { createPageEndpoint } from "../src/transport/page-bridge";
import { Result } from "better-result";

type MainBootstrapError = { code: "main_startup_failed" | "main_cleanup_failed" };

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
  return Result.isError(cleanup) ? Result.err({ code: "main_cleanup_failed" }) : started;
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
  const endpointSetup = Result.try({
    try: () => {
      createdEndpoint = createPageEndpoint({
        target,
        channelId,
        side: "main",
        eventNames: { fromIsolated: inbound, fromMain: outbound },
      });
      const instance = new Nexus()
        .provide(
          pageEditorToken,
          createEditorService({
            validateTarget: createEditorTargetValidator(document),
            invoke(request) {
              const page = window as Window & { __MP_Editor_JSAPI__?: EditorJsapi };
              const current = page.__MP_Editor_JSAPI__;
              if (typeof current?.invoke !== "function") {
                request.errCb({ code: "jsapi_unavailable" });
                return;
              }
              return current.invoke.call(current, request);
            },
          }),
        )
        .configure({ endpoint: { implementation: createdEndpoint, meta: {} } });
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
      if (Result.isError(cleanup)) return Result.err(cleanup.error);
    }
    return endpointSetup;
  }
  const { endpoint, instance } = endpointSetup.value;
  const ready = await awaitMainWorldReady(instance.ready(), () => endpoint.close?.());
  if (Result.isError(ready)) return ready;
  return Result.ok({
    async dispose() {
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
