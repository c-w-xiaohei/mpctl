import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Nexus } from "@nexus-js/core";
import { usingNodeIpcClient, type NodeIpcAdapterModel } from "@nexus-js/node-ipc";
import { version } from "../package.json";
import { protocolVersion } from "../packages/contracts/src";

const root = path.resolve(import.meta.dir, "..");

test("npm tarball installs outside the repository and starts its packaged broker", async () => {
  const directory = await mkdtemp("/tmp/opencode/mpctl-package-");
  const installed = path.join(directory, "installed");
  const socketPath = path.join(directory, "mpctl", "broker.sock");
  const env = {
    ...process.env,
    MPCTL_BROKER_SOCKET: socketPath,
    MPCTL_BROKER_WS_PORT: "0",
    MPCTL_BROKER_CONFIG: path.join(directory, "broker.json"),
    MPCTL_PAIRING_CREDENTIAL: "isolated-package-test-credential",
    MPCTL_NEXUS_DEBUG: "0",
    MPCTL_EXTENSION_ID: "",
  };
  const config = usingNodeIpcClient({
    appId: "mpctl-package-test",
    configure: false,
    resolveAddress: () => ({ kind: "path", path: socketPath }),
  });
  const runtime = new Nexus<NodeIpcAdapterModel>();
  runtime.configure(config);
  let connection: Awaited<ReturnType<typeof runtime.connect>> | undefined;
  let brokerPid: number | undefined;

  const connectBroker = async () => {
    connection = await runtime.connect({
      target: { context: "node-ipc-daemon", appId: "mpctl", instance: "default" },
      timeout: 2_000,
    });
    if (connection.contextMeta.context !== "node-ipc-daemon")
      throw new Error("Unexpected package-test IPC peer");
    brokerPid = connection.contextMeta.pid;
  };

  const stopBroker = async () => {
    if (brokerPid === undefined && existsSync(socketPath)) {
      await runtime.ready();
      await connectBroker();
    }
    connection?.disconnect();
    if (brokerPid !== undefined) {
      process.kill(brokerPid, "SIGTERM");
      const deadline = Date.now() + 5_000;
      while (existsSync(socketPath) && Date.now() < deadline) await Bun.sleep(25);
      if (existsSync(socketPath))
        throw new Error("Package-test broker did not stop; preserving artifacts");
    }
  };

  try {
    const packed = await run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
      root,
      env,
    );
    expect(packed.code, packed.stderr).toBe(0);
    const [tarball] = JSON.parse(packed.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    if (!tarball) throw new Error("npm pack did not produce a tarball");
    const files = tarball.files.map((file) => file.path);
    expect(files).toContain("dist/cli.js");
    expect(files).toContain("dist/broker.js");
    expect(files).toContain("dist/extension/manifest.json");
    expect(
      files.every(
        (file) =>
          file === "package.json" ||
          file === "README.md" ||
          file.startsWith("dist/") ||
          /^assets\/brand\/[^/]+\.png$/.test(file),
      ),
    ).toBe(true);

    const installation = await run(
      "npm",
      [
        "install",
        "--prefix",
        installed,
        "--no-save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        path.join(directory, tarball.filename),
      ],
      directory,
      env,
    );
    expect(installation.code, installation.stderr).toBe(0);
    const bin = path.join(installed, "node_modules/.bin/mpctl");
    const packageRoot = path.join(installed, "node_modules/mpctl");
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    expect(manifest.version).toBe(version);
    expect(manifest.dependencies["@mpctl/contracts"]).toBeUndefined();

    const reportedVersion = await run(bin, ["--version"], directory, env);
    expect(reportedVersion.code, reportedVersion.stderr).toBe(0);
    expect(reportedVersion.stdout.trim()).toBe(version);
    const help = await run(bin, ["--help"], directory, env);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("Usage: mpctl");
    expect(existsSync(socketPath)).toBe(false);

    await runtime.ready();
    const status = await run(bin, ["status", "--details"], directory, env);
    if (existsSync(socketPath)) await connectBroker();
    expect(status.code, status.stderr).toBe(0);
    expect(status.stderr).toBe("");
    expect(JSON.parse(status.stdout)).toEqual({
      connected: false,
      brokerVersion: protocolVersion,
      extensionVersion: null,
      expectedVersion: protocolVersion,
    });
    expect(brokerPid).toBeGreaterThan(0);
    const reused = await run(bin, ["status"], directory, env);
    expect(reused.code, reused.stderr).toBe(0);
    expect(JSON.parse(reused.stdout)).toEqual({ connected: false });
    expect(existsSync(path.join(packageRoot, "dist/extension/icon/128.png"))).toBe(true);
  } finally {
    try {
      await stopBroker();
    } finally {
      if (!existsSync(socketPath)) await rm(directory, { recursive: true, force: true });
    }
  }
}, 180_000);

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
) {
  const child = Bun.spawn([command, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
