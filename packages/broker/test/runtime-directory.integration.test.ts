import { access, chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Nexus } from "@nexus-js/core";
import { usingNodeIpcClient } from "@nexus-js/node-ipc";
import type { NodeIpcAdapterModel } from "@nexus-js/node-ipc";
import { connectionToken } from "@mpctl/contracts";
import { connectionStatusResultCodec } from "@mpctl/contracts";
import { Result } from "better-result";
import { ensureSocketDirectory } from "../src/main";

describe("broker runtime directory", () => {
  test("repairs an existing non-private socket directory before starting IPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "mpctl-existing-mode-"));
    try {
      const directory = join(root, "mpctl");
      await mkdir(directory, { mode: 0o755 });
      expect(await ensureSocketDirectory(join(directory, "broker.sock"))).toEqual(
        Result.ok(undefined),
      );
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not chmod a non-private custom parent or follow a socket-directory symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "mpctl-unrelated-mode-"));
    try {
      const custom = join(root, "unrelated");
      await mkdir(custom, { mode: 0o755 });
      await chmod(custom, 0o755);
      expect(await ensureSocketDirectory(join(custom, "broker.sock"))).toEqual(
        Result.err({ code: "socket_directory_permissions" }),
      );
      expect((await stat(custom)).mode & 0o777).toBe(0o755);
      const linked = join(root, "mpctl");
      await symlink(custom, linked);
      expect(await ensureSocketDirectory(join(linked, "broker.sock"))).toEqual(
        Result.err({ code: "socket_directory_invalid" }),
      );
      expect((await stat(custom)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("creates a private socket directory despite a typical umask", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "mpctl-runtime-mode-"));
    const previousUmask = process.umask(0o022);

    try {
      expect(await ensureSocketDirectory(join(runtimeDirectory, "mpctl", "broker.sock"))).toEqual(
        Result.ok(undefined),
      );
      expect((await stat(join(runtimeDirectory, "mpctl"))).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  });

  test("starts from a typical umask with a private socket directory and local status", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "mpctl-runtime-"));
    const socketPath = join(runtimeDirectory, "mpctl", "broker.sock");
    const credential = "runtime-directory-pairing-secret";
    const broker = Bun.spawn(
      ["sh", "-c", 'umask 0022; exec "$0" "$@"', process.execPath, "src/main.ts"],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          XDG_RUNTIME_DIR: runtimeDirectory,
          MPCTL_BROKER_SOCKET: undefined,
          MPCTL_PAIRING_CREDENTIAL: credential,
          MPCTL_BROKER_WS_PORT: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      await waitForSocket(socketPath);
      expect((await stat(join(runtimeDirectory, "mpctl"))).mode & 0o777).toBe(0o700);

      const client = new Nexus<NodeIpcAdapterModel>();
      client.configure(
        usingNodeIpcClient({
          appId: "mpctl-runtime-directory-test",
          resolveAddress: () => ({ kind: "path", path: socketPath }),
          configure: false,
        }),
      );
      await client.ready();
      const connection = await client.connect({
        target: { context: "node-ipc-daemon", appId: "mpctl", instance: "default" },
      });
      expect(
        await connectionStatusResultCodec.deserialize(
          await connection.get(connectionToken).getStatus(),
        ),
      ).toEqual(Result.ok({ connected: false, brokerVersion: "0.3.0" }));
      connection.disconnect();
    } finally {
      if (broker.pid) {
        try {
          process.kill(broker.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(error);
        }
      }
      await stop(broker);
      const [stdout, stderr] = await Promise.all([
        new Response(broker.stdout).text(),
        new Response(broker.stderr).text(),
      ]);
      expect(stdout).not.toContain(credential);
      expect(stderr).not.toContain(credential);
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  });
});

async function waitForSocket(socketPath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(socketPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Broker did not create its IPC socket");
}

async function stop(broker: ReturnType<typeof Bun.spawn>): Promise<void> {
  const stopped = await Promise.race([
    broker.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!stopped && broker.pid) {
    process.kill(broker.pid, "SIGKILL");
    await broker.exited;
  }
}
