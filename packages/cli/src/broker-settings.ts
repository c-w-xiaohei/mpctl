import { pairingCredentialSchema } from "@mpctl/contracts";
import * as v from "valibot";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Result } from "better-result";
import type { Result as BetterResult } from "better-result";
import { cliError, type CliError } from "./connection.js";

type BrokerConfig = { pairingCredential: string };
type Outcome<T> = BetterResult<T, CliError>;

export async function loadBrokerCredential(): Promise<Outcome<string>> {
  const env = process.env.MPCTL_PAIRING_CREDENTIAL;
  if (env) return validateCredential(env);
  const filePath = brokerConfigPath();
  const ensured = await ensureConfigDirectory(filePath, false);
  if (Result.isError(ensured))
    return Result.err(
      ensured.error.code === "config_missing" ? cliError("pairing_not_configured") : ensured.error,
    );
  const opened = await Result.tryPromise({
    try: () => open(filePath, constants.O_RDONLY | noFollowFlag()),
    catch: (error) => error,
  });
  if (Result.isError(opened)) {
    if (isCode(opened.error, "ENOENT")) return Result.err(cliError("pairing_not_configured"));
    return Result.err(
      cliError(isCode(opened.error, "ELOOP") ? "pairing_config_invalid" : "pairing_config_invalid"),
    );
  }
  const handle = opened.value;
  const read = await readCredentialHandle(handle);
  if (Result.isError(read)) return read;
  const parsed = Result.try({
    try: () => JSON.parse(read.value) as unknown,
    catch: () => cliError("pairing_config_invalid"),
  });
  if (Result.isError(parsed)) return parsed;
  if (
    !parsed.value ||
    typeof parsed.value !== "object" ||
    !("pairingCredential" in parsed.value) ||
    typeof parsed.value.pairingCredential !== "string"
  )
    return Result.err(cliError("pairing_config_invalid"));
  return validateCredential(parsed.value.pairingCredential);
}

export async function readCredentialHandle(handle: {
  stat(): Promise<{ isFile(): boolean; uid: number; mode: number }>;
  readFile(encoding: "utf8"): Promise<string>;
  close(): Promise<void>;
}): Promise<Outcome<string>> {
  let content: string | undefined;
  let primary: CliError | undefined;
  const stat = await Result.tryPromise({
    try: () => handle.stat(),
    catch: () => cliError("pairing_config_invalid"),
  });
  if (Result.isError(stat)) primary = stat.error;
  else if (!stat.value.isFile()) primary = cliError("pairing_config_invalid");
  else {
    const owner = validateOwner(stat.value.uid);
    const mode = validateFileMode(stat.value.mode);
    if (Result.isError(owner)) primary = owner.error;
    else if (Result.isError(mode)) primary = mode.error;
    else {
      const read = await Result.tryPromise({
        try: async () => handle.readFile("utf8"),
        catch: () => cliError("pairing_config_invalid"),
      });
      if (Result.isError(read)) primary = read.error;
      else content = read.value;
    }
  }
  const closed = await Result.tryPromise({
    try: () => handle.close(),
    catch: () => cliError("pairing_config_invalid"),
  });
  if (primary)
    return Result.err(
      Result.isError(closed)
        ? cliError(primary.code, primary.instruction, { ...primary.details, cleanupFailed: true })
        : primary,
    );
  if (Result.isError(closed)) return closed;
  return content === undefined
    ? Result.err(cliError("pairing_config_invalid"))
    : Result.ok(content);
}

export async function saveBrokerCredential(credential: string): Promise<Outcome<void>> {
  const valid = validateCredential(credential);
  if (Result.isError(valid)) return valid;
  const filePath = brokerConfigPath();
  const directory = await ensureConfigDirectory(filePath, true);
  if (Result.isError(directory)) return directory;
  const existing = await validateExistingConfig(filePath);
  if (Result.isError(existing)) return existing;
  const temp = `${filePath}.${randomUUID()}.tmp`;
  const file = await Result.tryPromise({
    try: () =>
      open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600),
    catch: () => cliError("pairing_config_invalid"),
  });
  if (Result.isError(file)) return file;
  const handle = file.value;
  const stat = await Result.tryPromise({
    try: () => handle.stat(),
    catch: () => cliError("pairing_config_invalid"),
  });
  const owner = Result.isError(stat) ? stat : validateOwner(stat.value.uid);
  const wrote =
    Result.isError(stat) || Result.isError(owner) || !stat.value.isFile()
      ? Result.err(cliError("pairing_config_invalid"))
      : await Result.tryPromise({
          try: async () =>
            handle.writeFile(
              `${JSON.stringify({ pairingCredential: credential } satisfies BrokerConfig)}\n`,
              "utf8",
            ),
          catch: () => cliError("pairing_config_invalid"),
        });
  const closed = await Result.tryPromise({
    try: () => handle.close(),
    catch: () => cliError("pairing_config_invalid"),
  });
  if (Result.isError(wrote) || Result.isError(closed)) {
    const removed = await removeTemporary(temp);
    if (Result.isError(removed)) return removed;
    return Result.err(
      Result.isError(wrote)
        ? wrote.error
        : Result.isError(closed)
          ? closed.error
          : cliError("pairing_config_invalid"),
    );
  }
  const moved = await Result.tryPromise({
    try: () => rename(temp, filePath),
    catch: () => cliError("pairing_config_invalid"),
  });
  if (Result.isError(moved)) {
    const removed = await removeTemporary(temp);
    if (Result.isError(removed)) return removed;
  }
  return moved;
}

function removeTemporary(filePath: string): Promise<Outcome<void>> {
  return Result.tryPromise({
    try: () => rm(filePath, { force: true }),
    catch: () => cliError("pairing_config_invalid"),
  });
}

function brokerConfigPath(): string {
  return (
    process.env.MPCTL_BROKER_CONFIG ??
    path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
      "mpctl",
      "broker.json",
    )
  );
}
function isDefaultConfig(): boolean {
  return process.env.MPCTL_BROKER_CONFIG === undefined;
}

async function ensureConfigDirectory(filePath: string, create: boolean): Promise<Outcome<void>> {
  const directory = path.dirname(filePath);
  if (create) {
    const made = await Result.tryPromise({
      try: () => mkdir(directory, { recursive: isDefaultConfig(), mode: 0o700 }),
      catch: (error) => error,
    });
    if (Result.isError(made) && !isCode(made.error, "EEXIST"))
      return Result.err(cliError("pairing_config_invalid"));
  }
  const stat = await Result.tryPromise({
    try: () => lstat(directory),
    catch: (error) =>
      isCode(error, "ENOENT") ? cliError("config_missing") : cliError("pairing_config_invalid"),
  });
  if (Result.isError(stat)) return Result.err(stat.error);
  if (stat.value.isSymbolicLink() || !stat.value.isDirectory())
    return Result.err(cliError("pairing_config_invalid"));
  const owner = validateOwner(stat.value.uid);
  if (Result.isError(owner)) return owner;
  if (isDefaultConfig()) {
    const secured = await Result.tryPromise({
      try: () => chmod(directory, 0o700),
      catch: () => cliError("pairing_config_permissions"),
    });
    if (Result.isError(secured)) return secured;
  }
  const fresh = await Result.tryPromise({
    try: () => lstat(directory),
    catch: () => cliError("pairing_config_invalid"),
  });
  if (Result.isError(fresh)) return fresh;
  const checkedOwner = validateOwner(fresh.value.uid);
  if (Result.isError(checkedOwner)) return checkedOwner;
  if ((fresh.value.mode & (isDefaultConfig() ? 0o077 : 0o022)) !== 0)
    return Result.err(cliError("pairing_config_permissions"));
  return Result.ok(undefined);
}

async function validateExistingConfig(filePath: string): Promise<Outcome<void>> {
  const stat = await Result.tryPromise({ try: () => lstat(filePath), catch: (error) => error });
  if (Result.isError(stat) && isCode(stat.error, "ENOENT")) return Result.ok(undefined);
  if (Result.isError(stat)) return Result.err(cliError("pairing_config_invalid"));
  if (stat.value.isSymbolicLink() || !stat.value.isFile())
    return Result.err(cliError("pairing_config_invalid"));
  const owner = validateOwner(stat.value.uid);
  if (Result.isError(owner)) return owner;
  return validateFileMode(stat.value.mode);
}
function validateOwner(uid: number): Outcome<void> {
  const processUid = process.getuid?.();
  return processUid !== undefined && uid !== processUid
    ? Result.err(cliError("pairing_config_permissions"))
    : Result.ok(undefined);
}
function validateFileMode(mode: number): Outcome<void> {
  return (mode & 0o077) !== 0
    ? Result.err(cliError("pairing_config_permissions"))
    : Result.ok(undefined);
}
function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}
function validateCredential(credential: string): Outcome<string> {
  return v.safeParse(pairingCredentialSchema, credential).success
    ? Result.ok(credential)
    : Result.err(cliError("pairing_config_invalid"));
}
function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
