import { describe, expect, test } from "bun:test";
import {
  connectResultCodec,
  controlStatusResultCodec,
  disconnectResultCodec,
} from "@mpctl/contracts";
import { Result } from "better-result";
import type { BackgroundControlService } from "../src/background-contracts";
import { encodeControlResult } from "../src/connection";
import { createPopupControl } from "../src/popup-control";

describe("popup background control acquisition", () => {
  test("closes a runtime whose bootstrap fails and retries with a new runtime", async () => {
    const endpoints: FakeEndpoint[] = [];
    let creates = 0;
    const control = service();
    const popup = createPopupControl(() => {
      creates++;
      const endpoint = new FakeEndpoint();
      endpoints.push(endpoint);
      return Result.ok({
        endpoint,
        runtime: {
          ready: async () => {
            if (creates === 1) throw new Error("bootstrap");
          },
          connect: async () => Result.ok(control),
        },
      });
    });

    expect((await popup.get()).isErr()).toBe(true);
    expect(endpoints[0]?.closeCount).toBe(1);
    expect((await popup.get()).isOk()).toBe(true);
    expect(creates).toBe(2);
  });

  test("reports endpoint cleanup failure after bootstrap failure", async () => {
    const endpoint = new FakeEndpoint();
    endpoint.failClose = true;
    const popup = createPopupControl(() =>
      Result.ok({
        endpoint,
        runtime: {
          ready: async () => {
            throw new Error("ready");
          },
          connect: async () => Result.ok(service()),
        },
      }),
    );
    const result = await popup.get();
    expect(result).toEqual(
      Result.err({ code: "runtime_unavailable", cleanupFailed: true, cleanupAttempted: true }),
    );
    expect(endpoint.closeCount).toBe(1);
  });

  test("converts a synchronous runtime factory rejection into a Result", async () => {
    const popup = createPopupControl(() => {
      throw new Error("factory failed");
    });
    expect(await popup.get()).toEqual(Result.err({ code: "runtime_unavailable" }));
  });

  test("reuses a ready runtime after one transient target failure", async () => {
    let creates = 0;
    let connects = 0;
    const targetControl = service();
    const popup = createPopupControl(() => {
      creates++;
      return Result.ok({
        endpoint: new FakeEndpoint(),
        runtime: {
          ready: async () => {},
          connect: async () => {
            if (++connects === 1) return Result.err({ code: "background_unavailable" as const });
            return Result.ok(targetControl);
          },
        },
      });
    });

    expect((await popup.get()).isErr()).toBe(true);
    expect((await popup.get()).isOk()).toBe(true);
    expect(creates).toBe(1);
    expect(connects).toBe(2);
  });

  test("shares runtime bootstrap while acquiring a current proxy for each request", async () => {
    let connects = 0;
    const targetControl = service();
    const popup = createPopupControl(() =>
      Result.ok({
        endpoint: new FakeEndpoint(),
        runtime: {
          ready: async () => {},
          connect: () => {
            connects++;
            return Promise.resolve(Result.ok(targetControl));
          },
        },
      }),
    );

    const first = popup.get();
    const second = popup.get();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connects).toBe(2);
    const results = await Promise.all([first, second]);
    expect(results.every((r) => r.isOk())).toBe(true);
    expect((await popup.get()).isOk()).toBe(true);
    expect(connects).toBe(3);
  });

  test("keeps the background proxy after the remote connect operation rejects", async () => {
    let acquisitions = 0;
    const remote = service({
      connect: async () =>
        encodeControlResult(connectResultCodec, Result.err({ code: "connect_failed" })),
    });
    const popup = createPopupControl(() => {
      acquisitions++;
      return Result.ok({
        endpoint: new FakeEndpoint(),
        runtime: { ready: async () => {}, connect: async () => Result.ok(remote) },
      });
    });
    const acquired = await popup.get();
    expect(acquired.isOk()).toBe(true);
    if (acquired.isOk()) {
      const remoteFailure = await connectResultCodec.deserialize(await acquired.value.connect());
      expect(remoteFailure.isErr()).toBe(true);
    }
    expect((await popup.get()).isOk()).toBe(true);
    expect(acquisitions).toBe(1);
  });

  test("gets a fresh proxy after background session replacement", async () => {
    let current = service();
    let creates = 0;
    const popup = createPopupControl(() => {
      creates++;
      return Result.ok({
        endpoint: new FakeEndpoint(),
        runtime: { ready: async () => {}, connect: async () => Result.ok(current) },
      });
    });
    await popup.get();
    current = service();
    expect((await popup.get()).isOk()).toBe(true);
    expect(creates).toBe(1);
  });
});

class FakeEndpoint {
  closeCount = 0;
  failClose = false;
  close() {
    this.closeCount++;
    if (this.failClose) throw new Error("close failed");
  }
}

function service(overrides: Partial<BackgroundControlService> = {}): BackgroundControlService {
  return {
    getStatus: async () =>
      encodeControlResult(controlStatusResultCodec, Result.ok({ connected: false })),
    requestConnect: async () => ({ status: "ok" as const, value: undefined }),
    connect: async () => encodeControlResult(connectResultCodec, Result.ok({ connected: true })),
    disconnect: async () =>
      encodeControlResult(disconnectResultCodec, Result.ok({ connected: false })),
    reload: async () =>
      encodeControlResult(
        (await import("@mpctl/contracts")).reloadResultCodec,
        Result.ok(undefined),
      ),
    ...overrides,
  };
}
