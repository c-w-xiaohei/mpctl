import { chmod, lstat, mkdir } from "node:fs/promises";
import { closeSync, writeSync } from "node:fs";
import path from "node:path";
import { Result } from "better-result";
import type { Result as BetterResult } from "better-result";
import { createBroker, type Broker } from "./server";
import { configureNexusDebug } from "@mpctl/contracts/nexus-debug";

export type BrokerStartupError = {
  code:
    | "startup_configuration"
    | "socket_directory_invalid"
    | "socket_directory_permissions"
    | "ipc_endpoint_missing"
    | "pairing_not_configured"
    | "broker_start_failed"
    | "startup_nonce_failed"
    | "broker_close_failed";
  cleanupFailed?: true;
};
type Outcome<T> = BetterResult<T, BrokerStartupError>;

const pairingCredential = process.env.MPCTL_PAIRING_CREDENTIAL;
const ipcAddress = process.env.MPCTL_BROKER_SOCKET
  ? { kind: "path" as const, path: process.env.MPCTL_BROKER_SOCKET }
  : {
      kind: "path" as const,
      path: path.join(
        process.env.XDG_RUNTIME_DIR ?? `/tmp/nexus-${process.getuid?.() ?? "user"}`,
        "mpctl",
        "broker.sock",
      ),
    };

export async function ensureSocketDirectory(socketPath: string): Promise<Outcome<void>> {
  const directory = path.dirname(socketPath);
  const made = await Result.tryPromise({
    try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
    catch: () => ({ code: "socket_directory_invalid" as const }),
  });
  if (Result.isError(made)) return made;
  const stat = await Result.tryPromise({
    try: () => lstat(directory),
    catch: () => ({ code: "socket_directory_invalid" as const }),
  });
  if (Result.isError(stat)) return stat;
  if (!stat.value.isDirectory() || (process.getuid && stat.value.uid !== process.getuid()))
    return Result.err({ code: "socket_directory_invalid" });
  if ((stat.value.mode & 0o777) !== 0o700) {
    if (path.basename(directory) !== "mpctl")
      return Result.err({ code: "socket_directory_permissions" });
    const secured = await Result.tryPromise({
      try: () => chmod(directory, 0o700),
      catch: () => ({ code: "socket_directory_permissions" as const }),
    });
    if (Result.isError(secured)) return secured;
  }
  return Result.ok(undefined);
}

export async function main(): Promise<Outcome<Broker>> {
  if (!pairingCredential) return Result.err({ code: "startup_configuration" });
  if (ipcAddress.kind === "path") {
    const directory = await ensureSocketDirectory(ipcAddress.path);
    if (Result.isError(directory)) return directory;
  }
  const created = await createBroker({
    ipcAddress,
    websocketPort: Number(process.env.MPCTL_BROKER_WS_PORT ?? 17381),
    pairingCredential,
  });
  if (Result.isError(created))
    return Result.err({
      code: created.error.code,
      ...(created.error.cleanupFailed ? { cleanupFailed: true as const } : {}),
    });
  const broker = created.value;
  const nonce = process.env.MPCTL_BROKER_STARTUP_NONCE;
  if (nonce) {
    const signaled = await signalStartupNonce(nonce);
    if (Result.isError(signaled)) {
      const closed = await broker.close();
      if (Result.isError(closed))
        return Result.err({ code: "startup_nonce_failed", cleanupFailed: true });
      return signaled;
    }
  }
  return Result.ok(broker);
}

async function signalStartupNonce(nonce: string): Promise<Outcome<void>> {
  const write = Result.try({
    try: () => writeSync(3, `${nonce}\n`),
    catch: (cause) =>
      isCode(cause, "EPIPE")
        ? { code: "ignored" as const }
        : { code: "startup_nonce_failed" as const },
  });
  const close = Result.try({
    try: () => closeSync(3),
    catch: () => ({ code: "startup_nonce_failed" as const }),
  });
  if (Result.isError(close))
    return Result.err({
      code: "startup_nonce_failed",
      ...(Result.isError(write) && write.error.code !== "ignored"
        ? { cleanupFailed: true as const }
        : {}),
    });
  if (Result.isError(write) && write.error.code !== "ignored") return Result.err(write.error);
  return Result.ok(undefined);
}

if (import.meta.main) {
  configureNexusDebug("broker", process.env.MPCTL_NEXUS_DEBUG === "1", (line) => {
    process.stderr.write(`${line}\n`);
  });
  const started = await main();
  if (Result.isError(started)) {
    process.stderr.write(
      started.error.cleanupFailed
        ? `${JSON.stringify({ error: started.error })}\n`
        : `${started.error.code}\n`,
    );
    process.exitCode = 1;
  } else {
    const broker = started.value;
    const shutdown = async () => {
      const closed = await broker.close();
      if (Result.isError(closed)) {
        process.stderr.write(`${JSON.stringify(closed.error)}\n`);
        process.exitCode = 1;
        return;
      }
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
