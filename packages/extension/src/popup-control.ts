import { Nexus, type IEndpoint } from "@nexus-js/core";
import { chromeTarget, createPopupConfig } from "@nexus-js/chrome";
import {
  backgroundControlToken,
  disconnectResultCodec,
  controlStatusResultCodec,
  requestConnectResultCodec,
} from "@mpctl/contracts";
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
  requestConnect(): PromiseLike<BackgroundControlWireResult<void>>;
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

/** One Chrome control client per UI page; page disposal never disconnects the broker. */
export function createBackgroundControlClient(timeout = 2_000) {
  let closeEndpoint: (() => void) | undefined;
  const client = createPopupControl(() => {
    const setup = Result.try({
      try: () => {
        const runtime = new Nexus();
        const config = createPopupConfig();
        const endpoint = config.endpoint?.implementation;
        if (!endpoint) throw new Error("Missing Chrome endpoint");
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          if (closeEndpoint === close) closeEndpoint = undefined;
          endpoint.close();
        };
        closeEndpoint = close;
        runtime.configure(config);
        return {
          endpoint: { close },
          runtime: {
            ready: () => runtime.ready(),
            connect: () =>
              Result.tryPromise({
                try: async () => {
                  const connection = await runtime.connect({
                    target: chromeTarget.background(),
                    timeout,
                  });
                  return connection.get(backgroundControlToken);
                },
                catch: () => ({ code: "background_unavailable" as const }),
              }),
          },
        };
      },
      catch: () => ({ code: "runtime_unavailable" as const }),
    });
    if (setup.isErr()) {
      const cleanup = dispose();
      return cleanup.isErr()
        ? Result.err({ ...setup.error, cleanupFailed: true, cleanupAttempted: true })
        : setup;
    }
    return setup;
  });
  function dispose(): BetterResult<void, PopupControlError> {
    return Result.try({
      try: () => closeEndpoint?.(),
      catch: () => ({
        code: "runtime_unavailable" as const,
        cleanupFailed: true,
        cleanupAttempted: true,
      }),
    });
  }
  return {
    dispose,
    async get() {
      const acquired = await client.get();
      if (acquired.isErr()) return acquired;
      const remote = acquired.value;
      return Result.ok({
        async requestConnect() {
          const result = await Result.tryPromise({
            try: async () => await remote.requestConnect(),
            catch: () => ({ code: "connect_failed" as const }),
          });
          return result.isErr() ? result : requestConnectResultCodec.deserialize(result.value);
        },
        async disconnect() {
          const result = await Result.tryPromise({
            try: async () => await remote.disconnect(),
            catch: () => ({ code: "disconnect_failed" as const }),
          });
          return result.isErr() ? result : disconnectResultCodec.deserialize(result.value);
        },
        async getStatus() {
          const result = await Result.tryPromise({
            try: async () => await remote.getStatus(),
            catch: () => ({ code: "status_failed" as const }),
          });
          return result.isErr() ? result : controlStatusResultCodec.deserialize(result.value);
        },
      });
    },
  };
}
