import { expect, test } from "bun:test";
import { requestConnectResultCodec } from "@mpctl/contracts";
import { Result } from "better-result";
import { connectFromPage } from "../src/connection-page";

test("the CLI connection page retries acquisition then hands off once without waiting for a socket", async () => {
  let acquisitions = 0;
  let connections = 0;
  const result = await connectFromPage(async () => {
    acquisitions++;
    if (acquisitions === 1) return Result.err({ code: "background_unavailable" as const });
    return Result.ok({
      requestConnect: async () => {
        connections++;
        return requestConnectResultCodec.deserialize({ status: "ok" });
      },
    });
  }, 300);
  expect(result.isOk()).toBe(true);
  expect(acquisitions).toBe(2);
  expect(connections).toBe(1);
});

test("does not retry a failed pairing once background control was acquired", async () => {
  let connections = 0;
  const result = await connectFromPage(
    async () =>
      Result.ok({
        requestConnect: async () => {
          connections++;
          return Result.err({ code: "connect_failed" as const });
        },
      }),
    300,
  );
  expect(result.isErr()).toBe(true);
  expect(connections).toBe(1);
});

test("preserves a published pairing failure as a domain Result for the entrypoint", async () => {
  const result = await connectFromPage(async () =>
    Result.ok({
      requestConnect: async () => Result.err({ code: "connect_failed" as const }),
    }),
  );
  expect(result.isErr()).toBe(true);
  expect(result).toEqual(Result.err({ code: "connect_failed" }));
});

test("bounds background acquisition and reports its failure", async () => {
  const start = Date.now();
  await expect(
    connectFromPage(async () => {
      return Result.err({ code: "background_unavailable" });
    }, 20),
  ).resolves.toMatchObject({ status: "error", error: { code: "background_unavailable" } });
  expect(Date.now() - start).toBeLessThan(250);
});

test("does not connect a control that arrives after the acquisition deadline", async () => {
  let connections = 0;
  const control = Result.ok({
    requestConnect: async () => {
      connections++;
      return Result.ok(undefined);
    },
  });
  await expect(
    connectFromPage(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return control;
    }, 10),
  ).resolves.toMatchObject({ status: "error", error: { code: "background_timeout" } });
  expect(connections).toBe(0);
});

test("converts acquisition and remote Promise rejection into page Results", async () => {
  const synchronousAcquisition = await connectFromPage(() => {
    throw new Error("background factory failed");
  }, 30);
  expect(synchronousAcquisition.isErr()).toBe(true);

  const acquisition = await connectFromPage(async () => {
    throw new Error("background port rejected");
  }, 30);
  expect(acquisition.isErr()).toBe(true);

  const remote = await connectFromPage(async () =>
    Result.ok({
      requestConnect: async () => Promise.reject(new Error("remote rejected")),
    }),
  );
  expect(remote.isErr()).toBe(true);
});
