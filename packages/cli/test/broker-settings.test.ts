import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadBrokerCredential,
  readCredentialHandle,
  saveBrokerCredential,
} from "../src/broker-settings.js";
import { Result } from "better-result";

const directories: string[] = [];
const originalConfigPath = process.env.MPCTL_BROKER_CONFIG;
const originalCredential = process.env.MPCTL_PAIRING_CREDENTIAL;

afterEach(async () => {
  if (originalConfigPath === undefined) delete process.env.MPCTL_BROKER_CONFIG;
  else process.env.MPCTL_BROKER_CONFIG = originalConfigPath;
  if (originalCredential === undefined) delete process.env.MPCTL_PAIRING_CREDENTIAL;
  else process.env.MPCTL_PAIRING_CREDENTIAL = originalCredential;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("broker credential settings", () => {
  test("reports handle-close failure while preserving an invalid-file result", async () => {
    const closed = { value: false };
    const result = await readCredentialHandle({
      stat: async () =>
        ({ isFile: () => false, uid: process.getuid?.() ?? 0, mode: 0o100600 }) as never,
      readFile: async () => "",
      close: async () => {
        closed.value = true;
        throw new Error("close failed");
      },
    });

    expect(closed.value).toBe(true);
    expect(result).toMatchObject({
      error: { code: "pairing_config_invalid", details: { cleanupFailed: true } },
    });
  });

  test("loads an environment override before a saved credential", async () => {
    const config = await configPath();
    await saveBrokerCredential("saved-credential");
    process.env.MPCTL_PAIRING_CREDENTIAL = "environment-credential";

    expect(await loadBrokerCredential()).toEqual(Result.ok("environment-credential"));
    expect(await readFile(config, "utf8")).toContain("saved-credential");
  });

  test("persists a validated credential with private directory and file permissions", async () => {
    const config = await configPath();

    await saveBrokerCredential("persistent-credential");

    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      pairingCredential: "persistent-credential",
    });
    expect((await lstat(path.dirname(config))).mode & 0o777).toBe(0o700);
    expect((await lstat(config)).mode & 0o777).toBe(0o600);
  });

  test("rejects malformed saved credentials without exposing their value", async () => {
    const config = await configPath();
    const { writeFile } = await import("node:fs/promises");
    await saveBrokerCredential("valid-credential");
    await writeFile(config, JSON.stringify({ pairingCredential: "not valid" }), { mode: 0o600 });

    expect(await loadBrokerCredential()).toMatchObject({
      error: { code: "pairing_config_invalid" },
    });
  });

  test("preserves an existing custom config directory mode while loading", async () => {
    const config = await configPath();
    const parent = path.dirname(path.dirname(config));
    await saveBrokerCredential("safe-credential");
    await chmod(path.dirname(config), 0o755);

    expect(await loadBrokerCredential()).toEqual(Result.ok("safe-credential"));
    expect((await lstat(path.dirname(config)).then((stat) => stat.mode)) & 0o777).toBe(0o755);
    expect((await lstat(config)).mode & 0o777).toBe(0o600);
    expect((await lstat(parent)).mode & 0o777).toBe(0o700);
  });

  test("refuses a saved credential file that is readable by other users", async () => {
    const config = await configPath();
    await saveBrokerCredential("safe-credential");
    await chmod(config, 0o644);

    expect(await loadBrokerCredential()).toMatchObject({
      error: { code: "pairing_config_permissions" },
    });
  });

  test("does not change an existing custom config parent directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mpctl-custom-config-"));
    directories.push(directory);
    process.env.MPCTL_BROKER_CONFIG = path.join(directory, "broker.json");
    await chmod(directory, 0o755);

    await saveBrokerCredential("custom-credential");

    expect((await lstat(directory)).mode & 0o777).toBe(0o755);
    expect((await lstat(process.env.MPCTL_BROKER_CONFIG)).mode & 0o777).toBe(0o600);
  });

  test("does not create a missing custom config parent while loading", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mpctl-missing-config-"));
    directories.push(directory);
    const missingParent = path.join(directory, "user-owned-parent");
    process.env.MPCTL_BROKER_CONFIG = path.join(missingParent, "broker.json");

    expect(await loadBrokerCredential()).toMatchObject({
      error: { code: "pairing_not_configured" },
    });
    await expect(lstat(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a symlink config file without reading its target", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mpctl-symlink-config-"));
    directories.push(directory);
    const target = path.join(directory, "target.json");
    const config = path.join(directory, "broker.json");
    await writeFile(target, JSON.stringify({ pairingCredential: "target-credential" }), {
      mode: 0o600,
    });
    await symlink(target, config);
    process.env.MPCTL_BROKER_CONFIG = config;

    expect(await loadBrokerCredential()).toMatchObject({
      error: { code: "pairing_config_invalid" },
    });
  });

  test("refuses a credential file writable by other users", async () => {
    const config = await configPath();
    await saveBrokerCredential("safe-credential");
    await chmod(config, 0o620);

    expect(await loadBrokerCredential()).toMatchObject({
      error: { code: "pairing_config_permissions" },
    });
  });
});

async function configPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mpctl-settings-test-"));
  directories.push(directory);
  const config = path.join(directory, "mpctl", "broker.json");
  await mkdir(path.dirname(config), { mode: 0o700 });
  process.env.MPCTL_BROKER_CONFIG = config;
  delete process.env.MPCTL_PAIRING_CREDENTIAL;
  return config;
}
