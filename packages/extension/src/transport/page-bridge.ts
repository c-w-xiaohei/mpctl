import type { IEndpoint, IPort } from "@nexus-js/core";
import { Result, type Result as BetterResult } from "better-result";
import { injectScript } from "wxt/utils/inject-script";

type Side = "isolated" | "main";
export interface PageBridgeAdapterModel {
  contextMeta: object;
  connectionMeta: object;
  connectionTarget: object;
}
type PageTarget = EventTarget;
interface PageBridgeOptions {
  target: PageTarget;
  channelId: string;
  side: Side;
  eventNames: { fromIsolated: string; fromMain: string };
  maxMessageBytes?: number;
  maxQueuedMessages?: number;
  maxQueuedBytes?: number;
}

const defaultMessageBytes = 4 * 1024 * 1024;
const defaultQueuedMessages = 128;
const defaultQueuedBytes = 8 * 1024 * 1024;
const connectDeadlineMs = 5_000;
const connectRetryMs = 25;

type BridgeConversionError =
  | { code: "unsupported_value" }
  | { code: "cyclic_value" }
  | { code: "unsupported_object" }
  | { code: "message_too_large"; limit: number }
  | { code: "clone_failed" };
type BridgeConversion<T> = BetterResult<T, BridgeConversionError>;

function byteLength(value: unknown, seen = new Set<object>()): BridgeConversion<number> {
  if (value === null || value === undefined || typeof value === "boolean") return Result.ok(8);
  if (typeof value === "number" || typeof value === "bigint") return Result.ok(8);
  if (typeof value === "string")
    return Result.try({
      try: () => new TextEncoder().encode(value).byteLength + 8,
      catch: () => ({ code: "unsupported_value" as const }),
    });
  if (typeof value !== "object") return Result.err({ code: "unsupported_value" });
  if (seen.has(value)) return Result.err({ code: "cyclic_value" });
  if (value instanceof ArrayBuffer) return Result.ok(value.byteLength + 8);
  if (ArrayBuffer.isView(value)) return Result.ok(value.byteLength + 8);

  seen.add(value);
  let bytes = 8;
  let entries: BetterResult<
    Array<[string | undefined, unknown]>,
    { code: "unsupported_object" | "unsupported_value" }
  >;
  if (Array.isArray(value)) {
    entries = Result.try({
      try: () => [...value].map((item) => [undefined, item] as const),
      catch: () => ({ code: "unsupported_value" as const }),
    }).map((items) => items.map(([key, item]) => [key, item]));
  } else {
    entries = Result.try({
      try: () => {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
          return Result.err({ code: "unsupported_object" as const });
        return Result.ok(
          Object.entries(value).map(([key, item]) => [key, item] as [string, unknown]),
        );
      },
      catch: () => ({ code: "unsupported_value" as const }),
    }).andThen((result) => result);
  }
  if (Result.isError(entries)) {
    seen.delete(value);
    return entries;
  }
  for (const [key, item] of entries.value) {
    if (key !== undefined) {
      const keyBytes = byteLength(key, seen);
      if (Result.isError(keyBytes)) {
        seen.delete(value);
        return keyBytes;
      }
      bytes += keyBytes.value;
    }
    const itemBytes = byteLength(item, seen);
    if (Result.isError(itemBytes)) {
      seen.delete(value);
      return itemBytes;
    }
    bytes += itemBytes.value;
  }
  seen.delete(value);
  return Result.ok(bytes);
}

function cloneAndSize(
  message: unknown,
  limit: number,
): BridgeConversion<{ message: unknown; bytes: number }> {
  const sized = byteLength(message);
  if (Result.isError(sized)) return sized;
  if (sized.value > limit) return Result.err({ code: "message_too_large", limit });
  return Result.try({
    try: () => ({ message: structuredClone(message), bytes: sized.value }),
    catch: () => ({ code: "clone_failed" as const }),
  });
}

function eventName(side: Side, names: PageBridgeOptions["eventNames"]): string {
  return side === "isolated" ? names.fromMain : names.fromIsolated;
}

class PagePort implements IPort {
  private messageHandler?: (message: unknown) => void;
  private disconnectHandler?: () => void;
  private queue: Array<{ message: unknown; bytes: number }> = [];
  private queuedBytes = 0;
  private delivering = false;
  private closed = false;
  private readonly incoming: EventListener;
  private readonly incomingDisconnect: EventListener;

  constructor(
    private readonly target: EventTarget,
    private readonly channelId: string,
    private readonly side: Side,
    private readonly names: PageBridgeOptions["eventNames"],
    private readonly limits: { messageBytes: number; queuedMessages: number; queuedBytes: number },
    private readonly onClosed: (port: PagePort) => void,
  ) {
    this.incoming = (event) => {
      const detail = (event as CustomEvent<{ channelId?: string; message?: unknown }>).detail;
      if (this.closed || detail?.channelId !== this.channelId || !("message" in (detail ?? {})))
        return;
      const copied = cloneAndSize(detail.message, this.limits.messageBytes);
      if (Result.isError(copied)) {
        this.close();
        return;
      }
      const copy = copied.value;
      if (
        this.queue.length >= this.limits.queuedMessages ||
        this.queuedBytes + copy.bytes > this.limits.queuedBytes
      ) {
        this.close();
        return;
      }
      this.queue.push(copy);
      this.queuedBytes += copy.bytes;
      this.scheduleDelivery();
    };
    this.incomingDisconnect = (event) => {
      const detail = (event as CustomEvent<{ channelId?: string }>).detail;
      if (!this.closed && detail?.channelId === this.channelId) this.close(false);
    };
    target.addEventListener(eventName(side, names), this.incoming);
    target.addEventListener(`${eventName(side, names)}:disconnect`, this.incomingDisconnect);
  }

  postMessage(message: unknown): void {
    // Nexus requires IPort.postMessage(): void; conversion errors cross this external edge as throws.
    if (this.closed) throw new Error("Page bridge port is closed");
    const copied = cloneAndSize(message, this.limits.messageBytes);
    if (Result.isError(copied)) {
      const message =
        copied.error.code === "message_too_large"
          ? `Page bridge message exceeds ${copied.error.limit} byte limit`
          : `Invalid page bridge message: ${copied.error.code}`;
      throw new TypeError(message);
    }
    this.target.dispatchEvent(
      new CustomEvent(eventName(this.side === "isolated" ? "main" : "isolated", this.names), {
        detail: { channelId: this.channelId, message: copied.value.message },
      }),
    );
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }
  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }
  get isClosed(): boolean {
    return this.closed;
  }

  close(notifyPeer = true): void {
    if (this.closed) return;
    this.closed = true;
    let failed = false;
    let failure: unknown;
    const attempt = (operation: () => void) => {
      const result = Result.try({ try: operation, catch: (error) => error });
      if (Result.isError(result) && !failed) {
        failed = true;
        failure = result.error;
      }
    };
    if (notifyPeer) {
      attempt(() =>
        this.target.dispatchEvent(
          new CustomEvent(
            `${eventName(this.side === "isolated" ? "main" : "isolated", this.names)}:disconnect`,
            {
              detail: { channelId: this.channelId },
            },
          ),
        ),
      );
    }
    attempt(() => this.target.removeEventListener(eventName(this.side, this.names), this.incoming));
    attempt(() =>
      this.target.removeEventListener(
        `${eventName(this.side, this.names)}:disconnect`,
        this.incomingDisconnect,
      ),
    );
    this.queue = [];
    this.queuedBytes = 0;
    attempt(() => this.onClosed(this));
    attempt(() => this.disconnectHandler?.());
    if (failed) throw failure;
  }

  private scheduleDelivery(): void {
    if (this.delivering || this.closed || !this.messageHandler) return;
    this.delivering = true;
    queueMicrotask(() => {
      try {
        while (!this.closed && this.queue.length) {
          const next = this.queue.shift()!;
          this.queuedBytes -= next.bytes;
          this.messageHandler?.(next.message);
        }
      } finally {
        this.delivering = false;
        if (this.queue.length && !this.closed) this.scheduleDelivery();
      }
    });
  }
}

export interface IsolatedPageBridge {
  readonly endpoint: IEndpoint<PageBridgeAdapterModel>;
  readonly channelId: string;
  dispose(): Promise<BridgeCleanupResult>;
}

export type BridgeCleanupError = { code: "cleanup_failed"; cause: "disposal_failed" };
export type BridgeCleanupResult = BetterResult<void, BridgeCleanupError>;

export type BridgeBootstrapError =
  | { code: "prepare_failed" }
  | { code: "inject_failed" }
  | {
      code: "cleanup_failed";
      cause: "prepare_failed" | "inject_failed" | "invalidation_registration_failed";
    };
export type BridgeBootstrapResult<T> = BetterResult<T, BridgeBootstrapError>;

/** Install the receive side before adding WXT's persistent MAIN-world script. */
export async function injectMainWorldBridge(
  target: EventTarget = document,
  context?: { onInvalidated(callback: () => void): unknown },
  prepare?: (endpoint: IEndpoint<PageBridgeAdapterModel>) => void | Promise<void>,
): Promise<BridgeBootstrapResult<IsolatedPageBridge>> {
  const channelId = crypto.randomUUID();
  const eventNames = {
    fromIsolated: `mpctl:${channelId}:isolated`,
    fromMain: `mpctl:${channelId}:main`,
  };
  const endpoint = createPageEndpoint({ target, channelId, side: "isolated", eventNames });
  const prepared = await Result.tryPromise({
    try: async () => {
      // Let the caller bootstrap Nexus and finish endpoint.listen() before MAIN can emit.
      await prepare?.(endpoint);
    },
    catch: () => ({ code: "prepare_failed" as const }),
  });
  if (Result.isError(prepared)) return cleanupAfterBootstrapFailure(endpoint, prepared.error.code);

  const injected = await Result.tryPromise({
    try: () =>
      injectScript("/mp-main-world.js", {
        keepInDom: true,
        modifyScript(script) {
          script.dataset.mpctlChannel = channelId;
          script.dataset.mpctlInbound = eventNames.fromIsolated;
          script.dataset.mpctlOutbound = eventNames.fromMain;
        },
      }),
    catch: () => ({ code: "inject_failed" as const }),
  });
  if (Result.isError(injected)) return cleanupAfterBootstrapFailure(endpoint, injected.error.code);
  const scriptResult = injected.value;

  let disposal: Promise<BridgeCleanupResult> | undefined;
  const dispose = (): Promise<BridgeCleanupResult> => {
    if (disposal) return disposal;
    disposal = Result.tryPromise({
      try: async () => {
        try {
          await endpoint.close?.();
        } finally {
          scriptResult.script.remove();
        }
      },
      catch: () => ({ code: "cleanup_failed" as const, cause: "disposal_failed" as const }),
    });
    return disposal;
  };
  const onInvalidated = () => {
    void dispose().then((result) => {
      if (Result.isError(result)) console.error("mpctl page bridge cleanup failed", result.error);
    });
  };
  const invalidation = Result.try({
    try: () => context?.onInvalidated(onInvalidated),
    catch: () => ({ code: "invalidation_registration_failed" as const }),
  });
  if (Result.isError(invalidation)) {
    const cause = "invalidation_registration_failed" as const;
    const cleanup = await Result.tryPromise({
      try: async () => {
        try {
          await endpoint.close?.();
        } finally {
          scriptResult.script.remove();
        }
      },
      catch: () => ({ code: "cleanup_failed" as const, cause }),
    });
    return Result.isError(cleanup) ? cleanup : Result.err({ code: "cleanup_failed", cause });
  }
  return Result.ok({ endpoint, channelId, dispose });
}

async function cleanupAfterBootstrapFailure(
  endpoint: IEndpoint<PageBridgeAdapterModel>,
  cause: "prepare_failed" | "inject_failed",
): Promise<BridgeBootstrapResult<never>> {
  const cleanup = await Result.tryPromise({
    try: async () => endpoint.close?.(),
    catch: () => ({ code: "cleanup_failed" as const, cause }),
  });
  return Result.isError(cleanup) ? cleanup : Result.err({ code: cause });
}

/** A page-local Nexus endpoint over directional CustomEvents. */
export function createPageEndpoint(options: PageBridgeOptions): IEndpoint<PageBridgeAdapterModel> {
  const limits = {
    messageBytes: options.maxMessageBytes ?? defaultMessageBytes,
    queuedMessages: options.maxQueuedMessages ?? defaultQueuedMessages,
    queuedBytes: options.maxQueuedBytes ?? defaultQueuedBytes,
  };
  let closed = false;
  let accept: ((port: IPort, connectionMeta: object) => void) | undefined;
  let connectListener: EventListener | undefined;
  let peerDisconnectListener: EventListener | undefined;
  const ports = new Set<PagePort>();
  const pendingConnects = new Set<() => void>();
  const acceptedRequests = new Map<string, PagePort>();
  const counterpart = options.side === "isolated" ? "main" : "isolated";
  const requestEvent = `${options.eventNames.fromIsolated}:connect`;
  const acceptEvent = `${options.eventNames.fromMain}:connect`;
  const readyEvent = `${options.eventNames.fromIsolated}:ready`;
  const endpointCloseEvent = `${options.eventNames.fromIsolated}:endpoint-close`;
  return {
    capabilities: { binaryPackets: true, transferables: false, supportsTransferables: false },
    listen(listener: (port: IPort, connectionMeta: object) => void) {
      // Nexus requires listen() to throw synchronously when registration is impossible.
      if (closed) throw new Error("Page bridge endpoint is closed");
      accept = (port, meta) => listener(port, meta);
      connectListener = (event) => {
        const detail = (event as CustomEvent<{ channelId?: string; requestId?: string }>).detail;
        if (closed || detail?.channelId !== options.channelId || !detail.requestId) return;
        if (acceptedRequests.has(detail.requestId)) {
          options.target.dispatchEvent(
            new CustomEvent(readyEvent, {
              detail: { channelId: options.channelId, requestId: detail.requestId },
            }),
          );
          return;
        }
        const port = new PagePort(
          options.target,
          options.channelId,
          options.side,
          options.eventNames,
          limits,
          (closedPort) => {
            ports.delete(closedPort);
            if (acceptedRequests.get(detail.requestId!) === closedPort)
              acceptedRequests.delete(detail.requestId!);
          },
        );
        acceptedRequests.set(detail.requestId, port);
        ports.add(port);
        accept?.(port, {});
        options.target.dispatchEvent(
          new CustomEvent(readyEvent, {
            detail: { channelId: options.channelId, requestId: detail.requestId },
          }),
        );
      };
      options.target.addEventListener(
        options.side === "main" ? requestEvent : acceptEvent,
        connectListener,
      );
      if (options.side === "main") {
        peerDisconnectListener = (event) => {
          const detail = (event as CustomEvent<{ channelId?: string }>).detail;
          if (detail?.channelId === options.channelId) {
            const closedResult = Result.try({
              try: () => this.close?.(),
              catch: (error) => error,
            });
            if (Result.isError(closedResult))
              console.error("mpctl page bridge endpoint cleanup failed", closedResult.error);
          }
        };
        options.target.addEventListener(endpointCloseEvent, peerDisconnectListener);
      }
    },
    async connect() {
      // Nexus requires connect() to reject; preserve the endpoint contract at this adapter edge.
      if (closed) throw new Error("Page bridge endpoint is closed");
      if (!accept && options.side === "isolated") {
        // The MAIN listen side is expected to have installed its listener before injection.
      }
      const port = new PagePort(
        options.target,
        options.channelId,
        options.side,
        options.eventNames,
        limits,
        (closedPort) => ports.delete(closedPort),
      );
      ports.add(port);
      const requestId = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const settle = (action: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (retryTimer !== undefined) clearTimeout(retryTimer);
          options.target.removeEventListener(readyEvent, onReady);
          pendingConnects.delete(cancel);
          action();
        };
        const cancel = () =>
          settle(() => reject(new Error("Page bridge endpoint closed during connect")));
        const onReady: EventListener = (event) => {
          const detail = (event as CustomEvent<{ channelId?: string; requestId?: string }>).detail;
          if (detail?.channelId !== options.channelId || detail.requestId !== requestId) return;
          settle(() => {
            if (closed) {
              port.close();
              reject(new Error("Page bridge endpoint closed during connect"));
            } else resolve();
          });
        };
        const timer = setTimeout(
          () =>
            settle(() => {
              port.close();
              reject(new Error("Page bridge peer did not become ready"));
            }),
          connectDeadlineMs,
        );
        const sendRequest = () => {
          if (settled || closed) return;
          options.target.dispatchEvent(
            new CustomEvent(options.side === "isolated" ? requestEvent : acceptEvent, {
              detail: { channelId: options.channelId, requestId, side: counterpart },
            }),
          );
          retryTimer = setTimeout(sendRequest, connectRetryMs);
        };
        pendingConnects.add(cancel);
        options.target.addEventListener(readyEvent, onReady);
        sendRequest();
      });
      if (closed || port.isClosed) {
        port.close();
        throw new Error("Page bridge endpoint closed during connect");
      }
      return { port, connectionMeta: {} };
    },
    targetKey: () => options.channelId,
    close() {
      if (closed) return;
      closed = true;
      let failed = false;
      let failure: unknown;
      const attempt = (operation: () => void) => {
        const result = Result.try({ try: operation, catch: (error) => error });
        if (Result.isError(result) && !failed) {
          failed = true;
          failure = result.error;
        }
      };
      acceptedRequests.clear();
      for (const cancel of [...pendingConnects]) attempt(cancel);
      if (connectListener) {
        attempt(() =>
          options.target.removeEventListener(
            options.side === "main" ? requestEvent : acceptEvent,
            connectListener!,
          ),
        );
        connectListener = undefined;
      }
      if (peerDisconnectListener) {
        attempt(() =>
          options.target.removeEventListener(endpointCloseEvent, peerDisconnectListener!),
        );
        peerDisconnectListener = undefined;
      }
      if (options.side === "isolated") {
        attempt(() =>
          options.target.dispatchEvent(
            new CustomEvent(endpointCloseEvent, { detail: { channelId: options.channelId } }),
          ),
        );
      }
      for (const port of ports) attempt(() => port.close());
      ports.clear();
      if (failed) throw failure;
    },
  };
}
