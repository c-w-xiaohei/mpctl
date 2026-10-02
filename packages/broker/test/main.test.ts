import { expect, test } from "bun:test";
import { join } from "node:path";

test("startup configuration failure exits nonzero without creating runtime state", async () => {
  const runtimeDirectory = join(import.meta.dir, "missing-pairing-runtime");
  const child = Bun.spawn([process.execPath, "run", "src/main.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDirectory,
      MPCTL_BROKER_SOCKET: undefined,
      MPCTL_PAIRING_CREDENTIAL: undefined,
      MPCTL_BROKER_STARTUP_NONCE: undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("startup_configuration");
});
