import { Nexus } from "@nexus-js/core";
import { Result, type Result as BetterResult } from "better-result";
import {
  connectionConfig,
  connectResultCodec,
  controlStatusResultCodec,
  createPairingSubprotocols,
  disconnectResultCodec,
  workspaceToken,
  protocolVersion,
  reloadResultCodec,
} from "@mpctl/contracts";
import {
  backgroundControlToken,
  type BackgroundControlService,
  type WorkspaceService,
} from "@mpctl/contracts";
import { WebSocketClientEndpoint } from "@nexus-js/websocket";
import type { WebSocketAdapterModel } from "@nexus-js/websocket";

export type ConnectionSettings = { websocketUrl: string; pairingCredential: string };
export type ConnectionSocket = {
  close(): BetterResult<void, ConnectionError>;
  onDisconnect?(callback: () => void): BetterResult<() => void, ConnectionError>;
};
export type ConnectionError = {
  code:
    | "cancelled"
    | "invalid_pairing_credential"
    | "settings_failed"
    | "dial_failed"
    | "protocol_mismatch"
    | "disconnect_failed"
    | "status_failed";
  cleanupFailed?: boolean;
};
type ControlFailure = {
  code: "connect_failed" | "disconnect_failed" | "status_failed" | "reload_failed";
};
type ConnectionStatusResult = BetterResult<{ connected: boolean }, ConnectionError>;
export type ConnectionController = {
  connect(credential?: string, websocketUrl?: string): Promise<BetterResult<void, ConnectionError>>;
  disconnect(): BetterResult<{ connected: false }, ConnectionError>;
  status(): ConnectionStatusResult;
};

export async function encodeControlResult<T, E>(
  codec: {
    serialize(
      result: BetterResult<T, E | { code: "invalid_result_envelope" }>,
    ): Promise<
      BetterResult<
        import("better-result").SerializedResult<T, E | { code: "invalid_result_envelope" }>,
        { code: "invalid_result_envelope" }
      >
    >;
  },
  result: BetterResult<T, E | { code: "invalid_result_envelope" }>,
): Promise<import("better-result").SerializedResult<T, E | { code: "invalid_result_envelope" }>> {
  const encoded = await codec.serialize(result);
  if (encoded.isOk()) return encoded.value;
  return { status: "error", error: encoded.error };
}

export async function decodeControlResult<T, E>(
  codec: {
    deserialize(value: unknown): Promise<BetterResult<T, E>>;
  },
  wire: unknown,
) {
  return codec.deserialize(wire);
}
type ConnectionOptions = {
  dial?: (
    url: string,
    protocols: string[],
    workspace?: WorkspaceService,
    control?: BackgroundControlService,
  ) => Promise<BetterResult<ConnectionSocket & { protocol: string }, ConnectionError>>;
  loadSettings?: () => Promise<BetterResult<ConnectionSettings, ConnectionError>>;
  saveSettings?: (settings: ConnectionSettings) => Promise<BetterResult<void, ConnectionError>>;
};

export async function readConnectionSettings(): Promise<
  BetterResult<ConnectionSettings, ConnectionError>
> {
  const data = await Result.tryPromise({
    try: () => chrome.storage.local.get(["websocketUrl", "pairingCredential"]),
    catch: () => ({ code: "settings_failed" as const }),
  });
  if (data.isErr()) return data;
  return Result.ok({
    websocketUrl:
      typeof data.value.websocketUrl === "string"
        ? data.value.websocketUrl
        : connectionConfig.websocketUrl,
    pairingCredential:
      typeof data.value.pairingCredential === "string" ? data.value.pairingCredential : "",
  });
}

export async function saveConnectionSettings(
  settings: ConnectionSettings,
): Promise<BetterResult<void, ConnectionError>> {
  return Result.tryPromise({
    try: async () => {
      await chrome.storage.local.set(settings);
    },
    catch: () => ({ code: "settings_failed" as const }),
  });
}

export function createConnectionController(
  options: ConnectionOptions & {
    workspace?: WorkspaceService;
    control?: BackgroundControlService;
  } = {},
) {
  type Attempt = { cancelled: boolean; promise: Promise<BetterResult<void, ConnectionError>> };
  let active: (ConnectionSocket & { protocol: string }) | undefined;
  let activeUnsubscribe: (() => void) | undefined;
  let connected = false;
  let currentAttempt: Attempt | undefined;
  const dial = options.dial ?? dialWithNexus;
  const err = (code: ConnectionError["code"]) => Result.err({ code });
  return {
    async connect(
      credential?: string,
      websocketUrl = connectionConfig.websocketUrl,
    ): Promise<BetterResult<void, ConnectionError>> {
      if (connected) return Result.ok(undefined);
      if (currentAttempt) return currentAttempt.promise;
      const attempt: Attempt = { cancelled: false, promise: Promise.resolve(Result.ok(undefined)) };
      currentAttempt = attempt;
      const isCurrent = () => !attempt.cancelled && currentAttempt === attempt;
      attempt.promise = connectAttempt();
      const result = await attempt.promise;
      if (currentAttempt === attempt) currentAttempt = undefined;
      return result;

      async function connectAttempt(): Promise<BetterResult<void, ConnectionError>> {
        const settingsResult =
          credential === undefined && options.loadSettings
            ? Result.flatten(
                await Result.tryPromise({
                  try: options.loadSettings,
                  catch: () => ({ code: "settings_failed" as const }),
                }),
              )
            : Result.ok({ websocketUrl, pairingCredential: credential ?? "" });
        if (settingsResult.isErr()) return settingsResult;
        if (!isCurrent()) return err("cancelled");
        const settings = settingsResult.value;
        const pairingCredential = credential ?? settings?.pairingCredential ?? "";
        const url =
          credential === undefined ? (settings?.websocketUrl ?? websocketUrl) : websocketUrl;
        const pairing = createPairingSubprotocols(pairingCredential);
        if (pairing.isErr()) return Result.err(pairing.error);
        const save = options.saveSettings
          ? Result.flatten(
              await Result.tryPromise({
                try: () => options.saveSettings!({ websocketUrl: url, pairingCredential }),
                catch: () => ({ code: "settings_failed" as const }),
              }),
            )
          : Result.ok(undefined);
        if (save.isErr()) return save;
        if (!isCurrent()) return err("cancelled");
        const dialed = await Result.tryPromise({
          try: () => dial(url, pairing.value, options.workspace, options.control),
          catch: () => ({ code: "dial_failed" as const }),
        });
        if (dialed.isErr()) return isCurrent() ? dialed : err("cancelled");
        if (dialed.value.isErr()) return isCurrent() ? dialed.value : err("cancelled");
        const candidate = dialed.value.value;
        if (!isCurrent()) {
          const closed = Result.try({
            try: () => candidate.close(),
            catch: () => ({ code: "disconnect_failed" as const }),
          });
          return closed.isErr() || closed.value.isErr()
            ? Result.err({ code: "cancelled", cleanupFailed: true })
            : err("cancelled");
        }
        if (candidate.protocol !== connectionConfig.selectedSubprotocol) {
          const closed = Result.try({
            try: () => candidate.close(),
            catch: () => ({ code: "disconnect_failed" as const }),
          });
          return closed.isErr() || closed.value.isErr()
            ? Result.err({ code: "protocol_mismatch", cleanupFailed: true })
            : err("protocol_mismatch");
        }
        active = candidate;
        connected = true;
        const listener = Result.flatten(
          Result.try({
            try: () =>
              candidate.onDisconnect?.(() => {
                if (active !== candidate) return;
                connected = false;
                active = undefined;
              }) ?? Result.ok(undefined),
            catch: () => ({ code: "disconnect_failed" as const }),
          }),
        );
        if (listener.isErr()) {
          const closed = Result.try({
            try: () => candidate.close(),
            catch: () => ({ code: "disconnect_failed" as const }),
          });
          active = undefined;
          activeUnsubscribe = undefined;
          connected = false;
          const cleanupFailed = closed.isErr() || closed.value.isErr();
          return Result.err({
            code: "dial_failed",
            ...(cleanupFailed ? { cleanupFailed: true } : {}),
          });
        }
        activeUnsubscribe = listener.value;
        return Result.ok(undefined);
      }
    },
    disconnect(): BetterResult<{ connected: false }, ConnectionError> {
      const attempt = currentAttempt;
      currentAttempt = undefined;
      if (attempt && !connected) attempt.cancelled = true;
      connected = false;
      const unsubscribe = activeUnsubscribe
        ? Result.try({
            try: () => activeUnsubscribe!(),
            catch: () => ({ code: "disconnect_failed" as const }),
          })
        : undefined;
      const closed = active
        ? Result.try({
            try: () => active!.close(),
            catch: () => ({ code: "disconnect_failed" as const }),
          })
        : undefined;
      active = undefined;
      activeUnsubscribe = undefined;
      if (unsubscribe?.isErr() || closed?.isErr() || (closed?.isOk() && closed.value.isErr()))
        return Result.err({ code: "disconnect_failed", cleanupFailed: true });
      return Result.ok({ connected: false });
    },
    status() {
      return Result.ok({ connected });
    },
  };
}

/** Published service boundary: lifecycle throws are converted to compact domain Results here. */
export function createBackgroundControl(options: {
  controller: () => ConnectionController;
  reload(): Promise<BetterResult<void, { code: string }>>;
}): BackgroundControlService {
  return {
    async connect() {
      const result = await options.controller().connect();
      const status: BetterResult<{ connected: boolean }, ControlFailure> = result.isOk()
        ? mapStatusFailure(options.controller().status(), "connect_failed")
        : Result.err({ code: "connect_failed" });
      if (status.isErr())
        return encodeControlResult(connectResultCodec, Result.err({ code: "connect_failed" }));
      return encodeControlResult(connectResultCodec, Result.ok(status.value));
    },
    async disconnect() {
      const disconnected: BetterResult<{ connected: false }, ControlFailure> = options
        .controller()
        .disconnect()
        .mapError(() => ({ code: "disconnect_failed" }));
      if (disconnected.isErr())
        return encodeControlResult(
          disconnectResultCodec,
          Result.err({ code: "disconnect_failed" }),
        );
      return encodeControlResult(disconnectResultCodec, Result.ok(disconnected.value));
    },
    async getStatus() {
      const status: BetterResult<{ connected: boolean }, ControlFailure> = mapStatusFailure(
        options.controller().status(),
        "status_failed",
      );
      if (status.isErr())
        return encodeControlResult(controlStatusResultCodec, Result.err({ code: "status_failed" }));
      return encodeControlResult(controlStatusResultCodec, Result.ok(status.value));
    },
    async reload() {
      const reloadResult = Result.flatten(
        await Result.tryPromise({
          try: options.reload,
          catch: () => ({ code: "reload_failed" as const }),
        }),
      );
      const result: BetterResult<void, ControlFailure> = reloadResult.isErr()
        ? Result.err({ code: "reload_failed" })
        : Result.ok(undefined);
      if (result.isErr())
        return encodeControlResult(reloadResultCodec, Result.err({ code: "reload_failed" }));
      return encodeControlResult(reloadResultCodec, Result.ok(result.value));
    },
  };
}

function mapStatusFailure(
  status: ConnectionStatusResult,
  code: ControlFailure["code"],
): BetterResult<{ connected: boolean }, ControlFailure> {
  if (status.isErr()) return Result.err({ code });
  return Result.ok(status.value);
}

async function dialWithNexus(
  url: string,
  protocols: string[],
  workspace?: WorkspaceService,
  control?: BackgroundControlService,
): Promise<BetterResult<ConnectionSocket & { protocol: string }, ConnectionError>> {
  const endpointResult = Result.try({
    try: () => new WebSocketClientEndpoint({ protocols }),
    catch: () => ({ code: "dial_failed" as const }),
  });
  if (endpointResult.isErr()) return endpointResult;
  const endpoint = endpointResult.value;
  const setup = Result.try({
    try: () => {
      const brokerNexus = new Nexus<WebSocketAdapterModel>();
      brokerNexus.configure({
        endpoint: {
          implementation: endpoint,
          meta: { context: "websocket-client", app: { protocolVersion } },
        },
        providers: [
          ...(workspace ? [{ token: workspaceToken, service: workspace }] : []),
          ...(control ? [{ token: backgroundControlToken, service: control }] : []),
        ],
      });
      return brokerNexus;
    },
    catch: () => ({ code: "dial_failed" as const }),
  });
  if (setup.isErr()) {
    const cleanup = Result.try({
      try: () => endpoint.close(),
      catch: () => ({ code: "dial_failed" as const }),
    });
    return cleanup.isErr() ? Result.err({ ...setup.error, cleanupFailed: true }) : setup;
  }
  const brokerNexus = setup.value;
  const connectionResult = await Result.tryPromise({
    try: async () => {
      await brokerNexus.ready();
      return brokerNexus.connect({ target: { context: "websocket-server", url } });
    },
    catch: () => ({ code: "dial_failed" as const }),
  });
  if (connectionResult.isErr()) {
    const cleanup = Result.try({
      try: () => endpoint.close(),
      catch: () => ({ code: "dial_failed" as const }),
    });
    return cleanup.isErr()
      ? Result.err({ ...connectionResult.error, cleanupFailed: true })
      : connectionResult;
  }
  const connection = connectionResult.value;
  const registered = Result.try({
    try: () =>
      connection.onDisconnected(() => {
        const cleanup = Result.try({
          try: () => endpoint.close(),
          catch: () => ({ code: "disconnect_failed" as const }),
        });
        if (cleanup.isErr()) console.error("mpctl connection endpoint cleanup failed");
      }),
    catch: () => ({ code: "dial_failed" as const }),
  });
  if (registered.isErr()) {
    const disconnected = Result.try({
      try: () => connection.disconnect(),
      catch: () => ({ code: "disconnect_failed" as const }),
    });
    const endpointClosed = Result.try({
      try: () => endpoint.close(),
      catch: () => ({ code: "disconnect_failed" as const }),
    });
    return Result.err({
      ...registered.error,
      cleanupFailed: disconnected.isErr() || endpointClosed.isErr(),
    });
  }
  return Result.ok({
    protocol: connection.connectionMeta.role === "client" ? connection.connectionMeta.protocol : "",
    onDisconnect(callback: () => void) {
      return Result.try({
        try: () => connection.onDisconnected(callback),
        catch: () => ({ code: "disconnect_failed" as const }),
      });
    },
    close() {
      const disconnected = Result.try({
        try: () => {
          connection.disconnect();
        },
        catch: () => ({ code: "disconnect_failed" as const }),
      });
      const endpointClosed = Result.try({
        try: () => {
          endpoint.close();
        },
        catch: () => ({ code: "disconnect_failed" as const }),
      });
      if (disconnected.isErr() || endpointClosed.isErr())
        return Result.err({
          code: "disconnect_failed" as const,
          cleanupFailed: disconnected.isErr() || endpointClosed.isErr(),
        });
      return Result.ok(undefined);
    },
  });
}
