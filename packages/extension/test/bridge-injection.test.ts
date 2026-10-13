import { expect, mock, test } from "bun:test";
import { Result } from "better-result";
import { CountingTarget, TrackingTarget, CleanupFailingTarget } from "./listener-target-fixture";

let injectScript: () => Promise<{ script: { remove(): void } }>;

mock.module("wxt/utils/inject-script", () => ({
  injectScript: () => injectScript(),
}));

const { injectMainWorldBridge } = await import("../src/transport/page-bridge");

test("failed WXT injection returns Err and closes the prepared endpoint", async () => {
  injectScript = async () => {
    throw new Error("injection failure");
  };

  const target = new CountingTarget();
  const result = await injectMainWorldBridge(target, undefined, (endpoint) =>
    endpoint.listen?.(() => {}),
  );
  expect(result.isErr()).toBe(true);
  expect(Result.isError(result) ? result.error : undefined).toEqual({ code: "inject_failed" });
  expect(target.count()).toBe(0);
});

test("preparation failure returns Err and closes endpoint listeners", async () => {
  injectScript = async () => {
    throw new Error("must not inject");
  };

  const target = new TrackingTarget();
  const result = await injectMainWorldBridge(target, undefined, (endpoint) => {
    endpoint.listen?.(() => {});
    throw new Error("prepare failure");
  });

  expect(result.isErr()).toBe(true);
  expect(Result.isError(result) ? result.error : undefined).toEqual({ code: "prepare_failed" });
  expect(target.listeners.size).toBe(0);
});

test("cleanup failure returns a typed Err with the original bootstrap stage", async () => {
  injectScript = async () => {
    throw new Error("injection failure");
  };

  const result = await injectMainWorldBridge(new CleanupFailingTarget(), undefined, (endpoint) =>
    endpoint.listen?.(() => {}),
  );

  expect(result.isErr()).toBe(true);
  expect(Result.isError(result) ? result.error : undefined).toEqual({
    code: "cleanup_failed",
    cause: "inject_failed",
  });
});

test("prepares the receive listener before injection and removes script on invalidation", async () => {
  let invalidated: (() => void) | undefined;
  let removed = false;
  let listenersAtInjection = 0;
  injectScript = async () => {
    listenersAtInjection = target.listeners.size;
    return { script: { remove: () => (removed = true) } };
  };

  const target = new TrackingTarget();
  const result = await injectMainWorldBridge(
    target,
    { onInvalidated: (callback) => (invalidated = callback) },
    (endpoint) => endpoint.listen?.(() => {}),
  );

  expect(result.isOk()).toBe(true);
  expect(listenersAtInjection).toBeGreaterThan(0);
  expect(removed).toBe(false);
  invalidated?.();
  await Promise.resolve();
  expect(removed).toBe(true);
  expect(target.listeners.size).toBe(0);
});

test("disposal returns the same cleanup Err and still removes the injected script", async () => {
  let invalidated: (() => void) | undefined;
  let removed = false;
  injectScript = async () => ({ script: { remove: () => (removed = true) } });

  const result = await injectMainWorldBridge(
    new CleanupFailingTarget(),
    { onInvalidated: (callback) => (invalidated = callback) },
    (endpoint) => endpoint.listen?.(() => {}),
  );
  expect(result.isOk()).toBe(true);
  if (result.isErr()) return;

  const firstDisposal = result.value.dispose();
  const secondDisposal = result.value.dispose();
  expect(firstDisposal).toBe(secondDisposal);
  const cleanup = await firstDisposal;
  expect(cleanup.isErr()).toBe(true);
  expect(Result.isError(cleanup) ? cleanup.error : undefined).toEqual({
    code: "cleanup_failed",
    cause: "disposal_failed",
  });
  expect(removed).toBe(true);
  invalidated?.();
});
