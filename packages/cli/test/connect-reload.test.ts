import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Nexus } from "@nexus-js/core";
import { usingNodeIpcDaemon, type UnixSocketServerEndpoint } from "@nexus-js/node-ipc";
import { connectionToken, backgroundControlToken } from "@mpctl/contracts";
import {
  connectionStatusResultCodec,
  reloadResultCodec,
  connectResultCodec,
  disconnectResultCodec,
  controlStatusResultCodec,
} from "@mpctl/contracts";
import { Result } from "better-result";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.each([true, false])(
  "connect --reload only dispatches control when connected, initially connected=%s",
  async (initiallyConnected) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mpctl-connect-reload-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const socket = path.join(directory, "broker.sock");
    const id = "a".repeat(32);
    let reloaded = false;
    let reloadCalls = 0;
    const nexus = new Nexus();
    const config = usingNodeIpcDaemon({
      appId: "mpctl",
      address: { kind: "path", path: socket },
      configure: false,
      providers: [
        {
          token: connectionToken,
          service: {
            async getStatus() {
              const connected = initiallyConnected;
              return encode(
                connectionStatusResultCodec,
                Result.ok({
                  connected,
                  ...(connected
                    ? {
                        sessionId: reloaded ? "new-session" : "old-session",
                        ledgerId: "58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975",
                      }
                    : {}),
                }),
              );
            },
          },
        },
        {
          token: backgroundControlToken,
          service: {
            connect: async () => encode(connectResultCodec, Result.ok({ connected: true })),
            disconnect: async () =>
              encode(disconnectResultCodec, Result.ok({ connected: false as const })),
            getStatus: async () => encode(controlStatusResultCodec, Result.ok({ connected: true })),
            async reload() {
              reloadCalls++;
              reloaded = true;
              return encode(reloadResultCodec, Result.ok(undefined));
            },
          },
        },
      ],
    });
    const endpoint = config.endpoint!.implementation as UnixSocketServerEndpoint;
    cleanups.push(() => endpoint.close());
    nexus.configure(config);
    await nexus.ready();
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "packages/cli/src/main.ts",
        "connect",
        "--reload",
        "--extension",
        id,
      ],
      {
        cwd: path.resolve(import.meta.dir, "../../.."),
        env: {
          ...process.env,
          WSL_DISTRO_NAME: "",
          MPCTL_BROWSER_PROFILE: "",
          MPCTL_BROWSER_EXECUTABLE: path.join(directory, "missing-browser"),
          MPCTL_BROKER_SOCKET: socket,
          MPCTL_BROKER_CONFIG: path.join(directory, "broker.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (initiallyConnected) {
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({ connected: true });
      expect(reloadCalls).toBe(1);
    } else {
      expect(exitCode).not.toBe(0);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr).error).toMatchObject({
        code: "not_connected",
        connectionPageUrl: `chrome-extension://${id}/connect.html`,
        instruction: expect.any(String),
      });
      expect(reloadCalls).toBe(0);
    }
  },
);

test("control rejection does not trigger a reload page or replay the command", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mpctl-reload-rejected-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const socket = path.join(directory, "broker.sock");
  let calls = 0;
  const nexus = new Nexus();
  const config = usingNodeIpcDaemon({
    appId: "mpctl",
    address: { kind: "path", path: socket },
    configure: false,
    providers: [
      {
        token: connectionToken,
        service: {
          getStatus: async () =>
            encode(
              connectionStatusResultCodec,
              Result.ok({
                connected: true,
                sessionId: "old-session",
                ledgerId: "58c8ce06-f7bd-4a5e-8c2e-1b3e9d103975",
              }),
            ),
        },
      },
      {
        token: backgroundControlToken,
        service: {
          connect: async () => encode(connectResultCodec, Result.ok({ connected: true })),
          disconnect: async () =>
            encode(disconnectResultCodec, Result.ok({ connected: false as const })),
          getStatus: async () => encode(controlStatusResultCodec, Result.ok({ connected: true })),
          async reload() {
            calls++;
            throw new Error("rejected");
          },
        },
      },
    ],
  });
  const endpoint = config.endpoint!.implementation as UnixSocketServerEndpoint;
  cleanups.push(() => endpoint.close());
  nexus.configure(config);
  await nexus.ready();
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "packages/cli/src/main.ts",
      "connect",
      "--reload",
      "--extension",
      "a".repeat(32),
    ],
    {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: {
        ...process.env,
        WSL_DISTRO_NAME: "",
        MPCTL_BROWSER_PROFILE: "",
        MPCTL_BROWSER_EXECUTABLE: path.join(directory, "missing-browser"),
        MPCTL_BROKER_SOCKET: socket,
        MPCTL_BROKER_CONFIG: path.join(directory, "broker.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exitCode).not.toBe(0);
  expect(JSON.parse(stderr).error.code).toBe("E_REMOTE_EXCEPTION");
  expect(calls).toBe(1);
});

async function encode<T, E extends object>(
  codec: {
    serialize(
      value: import("better-result").Result<T, E | import("@mpctl/contracts").ResultProtocolError>,
    ): Promise<
      import("better-result").Result<
        import("better-result").SerializedResult<T, import("@mpctl/contracts").ServiceError<E>>,
        import("@mpctl/contracts").ResultProtocolError
      >
    >;
  },
  result: import("better-result").Result<T, E>,
) {
  const encoded = await codec.serialize(result);
  return Result.isError(encoded)
    ? { status: "error" as const, error: encoded.error }
    : encoded.value;
}
