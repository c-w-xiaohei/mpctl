import type { IEndpoint } from "@nexus-js/core";
import { Result, type Result as BetterResult } from "better-result";
import type { BackgroundControlService, BackgroundControlWireResult } from "@mpctl/contracts";

export type PopupControlError =
  | {
      code: "runtime_unavailable" | "background_unavailable";
      cleanupFailed?: boolean;
      cleanupAttempted?: true;
    }
  | { code: "invalid_result_envelope"; cleanupFailed?: boolean; cleanupAttempted?: true }
  | { code: "connect_failed" | "disconnect_failed" | "reload_failed" | "status_failed" };
type PopupEndpoint = Pick<IEndpoint, "close">;
type PopupService = {
  connect(): PromiseLike<BackgroundControlWireResult<{ connected: boolean }>>;
  disconnect(): PromiseLike<BackgroundControlWireResult<{ connected: false }>>;
  getStatus(): PromiseLike<BackgroundControlWireResult<{ connected: boolean }>>;
};
type PopupRuntime = {
  ready(): Promise<void>;
  connect(): Promise<BetterResult<BackgroundControlService | PopupService, PopupControlError>>;
};
type RuntimeFactory = () => BetterResult<
  {
    runtime: PopupRuntime;
    endpoint: PopupEndpoint;
  },
  PopupControlError
>;

export function createPopupControl(createRuntime: RuntimeFactory) {
  let runtimePromise: Promise<BetterResult<PopupRuntime, PopupControlError>> | undefined;
  return {
    get(): Promise<BetterResult<PopupService, PopupControlError>> {
      if (!runtimePromise) {
        const created = Result.flatten(
          Result.try({
            try: createRuntime,
            catch: () => ({ code: "runtime_unavailable" as const }),
          }),
        );
        if (created.isErr()) return Promise.resolve(created);
        const current = created.value;
        runtimePromise = Result.tryPromise({
          try: async () => {
            await current.runtime.ready();
            return current.runtime;
          },
          catch: () => ({ code: "runtime_unavailable" as const }),
        }).then((ready) => {
          if (ready.isErr()) {
            const closed = Result.try({
              try: () => current.endpoint.close(),
              catch: () => ({ code: "runtime_unavailable" as const }),
            });
            if (closed.isErr())
              return Result.err({
                ...ready.error,
                cleanupFailed: true,
                cleanupAttempted: true,
              });
            return Result.err({ ...ready.error, cleanupAttempted: true });
          }
          return ready;
        });
      }
      return runtimePromise.then(async (runtimeResult) => {
        if (runtimeResult.isErr()) {
          runtimePromise = undefined;
          return runtimeResult;
        }
        const connected = await Result.tryPromise({
          try: () => runtimeResult.value.connect(),
          catch: () => ({ code: "background_unavailable" as const }),
        });
        return connected.isErr() ? connected : connected.value;
      });
    },
  };
}
