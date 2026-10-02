import { afterEach, describe, expect, test } from "bun:test";
import { Nexus } from "@nexus-js/core";
import { usingNodeIpcDaemon, UnixSocketServerEndpoint } from "@nexus-js/node-ipc";
import {
  connectionToken,
  workspaceToken,
  cleanupWorkspaceResultCodec,
  listArticlesResultCodec,
  articleResultCodec,
  workspaceResultCodec,
  writeBodyResultCodec,
  connectionStatusResultCodec,
  type ServiceError,
  type WorkspaceService,
} from "@mpctl/contracts";
import { Result } from "better-result";
import type { SerializedResult } from "better-result";
import type { NodeIpcSocketAddress } from "@nexus-js/node-ipc";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import {
  brokerSocketPath,
  CliError,
  ownsStartupBroker,
  withStartupReadinessPipe,
} from "../src/connection.js";

const activeServers: Array<{ dispose(): void }> = [];
const tempDirs: string[] = [];
const activeBrokerProcesses: Array<{ pid?: number; socketPath: string }> = [];

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  for (const broker of activeBrokerProcesses.splice(0)) {
    try {
      await cleanupBroker(broker);
    } catch (error) {
      activeBrokerProcesses.push(broker);
      cleanupErrors.push(error);
    }
  }
  for (const server of activeServers.splice(0)) server.dispose();
  for (const directory of tempDirs.splice(0)) {
    if (
      activeBrokerProcesses.some((broker) =>
        broker.socketPath.startsWith(`${directory}${path.sep}`),
      )
    ) {
      continue;
    }
    await rm(directory, { recursive: true, force: true });
  }
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Broker test cleanup failed; artifacts preserved");
});

describe("CLI over Nexus Node IPC", () => {
  test("classifies ownership when the nonce arrives at the readiness boundary", () => {
    expect(ownsStartupBroker(true, undefined)).toBe(true);
    expect(ownsStartupBroker(false, undefined)).toBe(false);
    expect(ownsStartupBroker(true, 1)).toBe(false);
  });

  test("destroys an open readiness pipe when the startup wait fails", async () => {
    const pipe = new PassThrough();
    const result = await withStartupReadinessPipe(pipe, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Result.err(new CliError("broker_start_failed"));
    });
    expect(result).toMatchObject({ error: { code: "broker_start_failed" } });

    expect(pipe.destroyed).toBe(true);
  });

  test("accepts filesystem broker addresses and rejects unsupported abstract addresses", () => {
    expect(brokerSocketPath({ kind: "path", path: "/tmp/mpctl.sock" })).toEqual(
      Result.ok("/tmp/mpctl.sock"),
    );
    expect(brokerSocketPath({ kind: "abstract", name: "mpctl" })).toMatchObject({
      error: { code: "broker_address_unsupported" },
    });
  });

  test("lists, opens, creates, pulls and pushes Unicode and empty HTML using file paths with spaces", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "provider.sock");
    const articleFile = path.join(directory, "文章 文件.html");
    const original = "<p>雨停以后，走慢一点 ☂</p>";
    let pushed: { article: string; html: string; expectedHash: string } | undefined;
    const bodyHash = "0".repeat(64);
    const server = await startProvider(socket, {
      async listArticles() {
        return Result.ok([{ candidate: "候选 A", title: "雨后" }]);
      },
      async openArticle(candidate) {
        expect(candidate).toBe("候选 A");
        return Result.ok({ article: "opened-1", title: "雨后", bodyHash });
      },
      async newArticle() {
        return Result.ok({ article: "new-1", title: "新文章", bodyHash });
      },
      async readBody() {
        return Result.ok({ html: original, bodyHash });
      },
      async writeBody(article, html, expectedHash) {
        pushed = { article, html, expectedHash };
        return Result.ok({ bodyHash });
      },
    });
    activeServers.push(server);

    const listed = await runCli(["article", "list"], socket);
    expect(listed).toEqual({ exitCode: 0, stdout: expect.any(String), stderr: "" });
    expect(JSON.parse(listed.stdout)).toEqual({
      articles: [{ candidate: "候选 A", title: "雨后" }],
    });
    expect(await runCli(["article", "open", "候选 A"], socket)).toMatchObject({
      exitCode: 0,
      stdout: `${JSON.stringify({ article: "opened-1", bodyHash })}\n`,
    });
    expect(await runCli(["article", "new"], socket)).toMatchObject({
      exitCode: 0,
      stdout: `${JSON.stringify({ article: "new-1", bodyHash })}\n`,
    });

    const pulled = await runCli(["article", "pull", "a-1", "--body", articleFile], socket);
    expect(pulled.exitCode).toBe(0);
    expect(JSON.parse(pulled.stdout)).toEqual({ bodyHash });
    expect(await readFile(articleFile, "utf8")).toBe(original);

    await writeFile(articleFile, "", "utf8");
    const pushedEmpty = await runCli(
      ["article", "push", "a-1", "--body", articleFile, "--expected-hash", bodyHash],
      socket,
    );
    expect(pushedEmpty.exitCode).toBe(0);
    expect(JSON.parse(pushedEmpty.stdout)).toEqual({ bodyHash });
    expect(pushed).toEqual({ article: "a-1", html: "", expectedHash: bodyHash });
    expect(await readFile(articleFile, "utf8")).toBe("");

    await writeFile(articleFile, original, "utf8");
    const pushedUnicode = await runCli(
      ["article", "push", "--expected-hash", bodyHash, "a-1", "--body", articleFile],
      socket,
    );
    expect(pushedUnicode.exitCode).toBe(0);
    expect(pushed).toEqual({ article: "a-1", html: original, expectedHash: bodyHash });
    expect(await readFile(articleFile, "utf8")).toBe(original);
    const existing = await runCli(["article", "pull", "a-1", "--body", articleFile], socket);
    expect(JSON.parse(existing.stderr).error.code).toBe("file_exists");
    await writeFile(articleFile, "local edits");
    const overwrite = await runCli(
      ["article", "pull", "a-1", `--body=${articleFile}`, "--overwrite"],
      socket,
    );
    expect(overwrite.exitCode).toBe(0);
    expect(await readFile(articleFile, "utf8")).toBe(original);
  });

  test("open and new call the existing workspace operations directly", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "handoff.sock");
    const calls: unknown[] = [];
    const server = await startProvider(socket, {
      async newArticle() {
        calls.push("newArticle");
        return Result.ok({ article: "opaque-new-article", title: "", bodyHash: "0".repeat(64) });
      },
      async openArticle(candidate) {
        calls.push({ openArticle: candidate });
        return Result.ok({
          article: "opaque-saved-article",
          title: "草稿 A",
          bodyHash: "0".repeat(64),
        });
      },
    });
    activeServers.push(server);

    const created = await runCli(["article", "new"], socket);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({
      article: "opaque-new-article",
      bodyHash: "0".repeat(64),
    });
    expect(created.stderr).toBe("");
    const opened = await runCli(["article", "open", "candidate-1"], socket);
    expect(opened.exitCode).toBe(0);
    expect(JSON.parse(opened.stdout)).toEqual({
      article: "opaque-saved-article",
      bodyHash: "0".repeat(64),
    });
    expect(opened.stderr).toBe("");
    expect(calls).toEqual(["newArticle", { openArticle: "candidate-1" }]);
  });

  test("returns structured automatic navigation errors without exposing provider details", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "handoff-error.sock");
    const server = await startProvider(socket, {
      async newArticle() {
        return Result.err({ code: "target_unavailable" });
      },
    });
    activeServers.push(server);

    const result = await runCli(["article", "new"], socket);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error.code).toBe("target_unavailable");
    expect(result.stderr).not.toContain("url");
  });

  test("parser reports invalid commands/options/missing arguments without touching broker, help works at every level", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "never-start.sock");
    for (const args of [
      ["bogus"],
      ["status", "--bogus"],
      ["article", "push", "ref", "--body", "body.html"],
      ["article", "open"],
      ["article", "new", "extra"],
      ["article", "open", " "],
      ["article", "pull", "ref", "--body", ""],
    ]) {
      const result = await runCli(args, socket);
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_command");
      expect(result.stdout).toBe("");
    }
    for (const args of [
      [],
      ["--help"],
      ["article"],
      ["article", "--help"],
      ["article", "list", "--help"],
      ["article", "open", "--help"],
      ["article", "new", "--help"],
      ["article", "current", "--help"],
      ["article", "pull", "--help"],
      ["article", "push", "--help"],
      ["status", "--help"],
      ["connect", "--help"],
      ["broker"],
      ["broker", "--help"],
      ["broker", "start", "--help"],
      ["workspace"],
      ["workspace", "--help"],
      ["workspace", "cleanup", "--help"],
      ["help", "article"],
      ["article", "help", "push"],
      ["--quiet", "workspace"],
    ]) {
      const result = await runCli(args, socket);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:");
    }
    expect(existsSync(socket)).toBe(false);
  }, 15_000);

  test("current obtains a fresh existing-editor reference and navigation errors expose only page-created facts", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "current.sock");
    const server = await startProvider(socket, {
      async currentArticle() {
        return Result.ok({ article: "fresh-current", title: "", bodyHash: "0".repeat(64) });
      },
      async newArticle() {
        return Result.err({ code: "page_failed", stage: "target_not_ready", pageCreated: true });
      },
    });
    activeServers.push(server);
    const current = await runCli(["article", "current"], socket);
    expect(current.exitCode).toBe(0);
    expect(JSON.parse(current.stdout).article).toBe("fresh-current");
    const failed = await runCli(["article", "new"], socket);
    expect(JSON.parse(failed.stderr).error).toMatchObject({
      code: "page_failed",
      stage: "target_not_ready",
      pageCreated: true,
      instruction: expect.stringContaining("不要直接重复"),
    });
  });
  test("status details diagnose protocol mismatch without claiming login readiness or invoking workspace", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "version.sock");
    let opens = 0;
    const server = await startProvider(
      socket,
      {
        async newArticle() {
          opens++;
          throw new Error("must not run");
        },
      },
      {
        async getStatus() {
          return Result.ok({
            connected: true,
            brokerVersion: "0.2.0",
            extensionVersion: "older",
            sessionId: "internal-session",
          });
        },
      },
    );
    activeServers.push(server);
    const status = await runCli(["status", "--details"], socket);
    expect(JSON.parse(status.stdout)).toEqual({
      connected: true,
      brokerVersion: "0.2.0",
      extensionVersion: "older",
      expectedVersion: "0.3.0",
    });
    const failed = await runCli(["article", "new"], socket);
    expect(JSON.parse(failed.stderr).error.code).toBe("version_mismatch");
    expect(opens).toBe(0);
    const plain = await runCli(["status"], socket);
    expect(JSON.parse(plain.stdout)).toEqual({ connected: true });
    expect(status.stdout).not.toContain("internal-session");
  });

  test("prints only the safe automatic-navigation stage for page_failed", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "handoff-stage.sock");
    const server = await startProvider(socket, {
      async newArticle() {
        return Result.err({ code: "page_failed", stage: "native_target_missing" });
      },
    });
    activeServers.push(server);

    const result = await runCli(["article", "new"], socket);
    expect(result.exitCode).not.toBe(0);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("page_failed");
    expect(error).toEqual({ code: "page_failed", stage: "native_target_missing" });
    expect(result.stderr).not.toContain("token");
    expect(result.stderr).not.toContain("mp.weixin.qq.com");
  });

  test("reports ambiguous home sources distinctly without exposing account data", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "handoff-ambiguous-home.sock");
    const server = await startProvider(socket, {
      async newArticle() {
        return Result.err({ code: "page_failed", stage: "source_ambiguous" });
      },
    });
    activeServers.push(server);

    const result = await runCli(["article", "new"], socket);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("page_failed");
    expect(error).toEqual({ code: "page_failed", stage: "source_ambiguous" });
    expect(result.stderr).not.toContain("mp.weixin.qq.com");
    expect(result.stderr).not.toContain("token");
  });

  test("preserves a safe navigation stage on target_unavailable", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "handoff-target-unavailable.sock");
    const server = await startProvider(socket, {
      async openArticle() {
        return Result.err({ code: "target_unavailable", stage: "target_not_ready" });
      },
    });
    activeServers.push(server);

    const result = await runCli(["article", "open", "candidate-1"], socket);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("target_unavailable");
    expect(error).toEqual({ code: "target_unavailable", stage: "target_not_ready" });
    expect(result.stderr).not.toContain("candidate-1");
    expect(result.stderr).not.toContain("mp.weixin.qq.com");
    expect(result.stderr).not.toContain("token");
  });

  test("automatic navigation returns the direct workspace result without prompt output", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "waiting.sock");
    const server = await startProvider(socket, {
      async newArticle() {
        return Result.ok({ article: "ready-article", title: "", bodyHash: "0".repeat(64) });
      },
    });
    activeServers.push(server);
    const result = await runCli(["article", "new"], socket);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      article: "ready-article",
      bodyHash: "0".repeat(64),
    });
  });

  test("hides internal prepare/complete operations and reports one automatic navigation failure", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "failed-wait.sock");
    let navigationCalls = 0;
    const server = await startProvider(socket, {
      async newArticle() {
        navigationCalls++;
        return Result.err({ code: "target_unavailable" });
      },
    });
    activeServers.push(server);
    for (const args of [
      ["article", "prepare", "new"],
      ["article", "complete", "unused"],
    ]) {
      const unsupported = await runCli(args, socket);
      expect(JSON.parse(unsupported.stderr).error.code).toBe("invalid_command");
    }
    const help = await runCli(["--help"], socket);
    expect(help.stdout).toContain("Usage: mpctl");
    expect(help.stderr).toBe("");
    const failed = await runCli(["article", "new"], socket);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stdout).toBe("");
    expect(JSON.parse(failed.stderr.trim().split("\n").at(-1)!).error.code).toBe(
      "target_unavailable",
    );
    expect(failed.stderr).not.toContain("attempt");
    expect(navigationCalls).toBe(1);
  });

  test("reports local file read errors without invoking remote write", async () => {
    const directory = await tempDir();
    let writes = 0;
    const server = await startProvider(path.join(directory, "provider.sock"), {
      async writeBody() {
        writes++;
        return Result.ok({ bodyHash: "0".repeat(64) });
      },
    });
    activeServers.push(server);

    const result = await runCli(
      [
        "article",
        "push",
        "a-1",
        "--body",
        path.join(directory, "missing file.html"),
        "--expected-hash",
        "0".repeat(64),
      ],
      path.join(directory, "provider.sock"),
    );

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error.code).toBe("file_error");
    expect(writes).toBe(0);
  });

  test("renders structured workspace failures with a nonzero exit status", async () => {
    const directory = await tempDir();
    const server = await startProvider(path.join(directory, "provider.sock"), {
      async readBody() {
        return Result.err({ code: "target_unavailable" });
      },
    });
    activeServers.push(server);

    const result = await runCli(
      ["article", "pull", "gone", "--body", path.join(directory, "body.html")],
      path.join(directory, "provider.sock"),
    );

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "target_unavailable" });
  });

  test("reports a pull destination write failure instead of claiming success", async () => {
    const directory = await tempDir();
    const server = await startProvider(path.join(directory, "provider.sock"), {
      async readBody() {
        return Result.ok({ html: "<p>body</p>", bodyHash: "0".repeat(64) });
      },
    });
    activeServers.push(server);

    const result = await runCli(
      ["article", "pull", "a-1", "--body", path.join(directory, "missing", "body.html")],
      path.join(directory, "provider.sock"),
    );

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error.code).toBe("file_error");
  });

  test("waits for a slow automatic workspace navigation within the configured call budget", async () => {
    const directory = await tempDir();
    const server = await startProvider(path.join(directory, "provider.sock"), {
      async newArticle() {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return Result.ok({ article: "slow-1", title: "慢响应", bodyHash: "0".repeat(64) });
      },
    });
    activeServers.push(server);

    const result = await runCli(["article", "new"], path.join(directory, "provider.sock"));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      article: "slow-1",
      bodyHash: "0".repeat(64),
    });
    expect(result.stderr).toBe("");
  });

  test("reports a rejected dispatched body write as unknown without retrying", async () => {
    const directory = await tempDir();
    const bodyFile = path.join(directory, "body.html");
    await writeFile(bodyFile, "<p>once</p>", "utf8");
    let writes = 0;
    const server = await startProvider(path.join(directory, "provider.sock"), {
      async writeBody() {
        writes++;
        throw new Error("connection lost after dispatch");
      },
    });
    activeServers.push(server);

    const result = await runCli(
      ["article", "push", "a-1", "--body", bodyFile, "--expected-hash", "0".repeat(64)],
      path.join(directory, "provider.sock"),
    );

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error.code).toBe("write_unknown");
    expect(writes).toBe(1);
    expect(await readFile(bodyFile, "utf8")).toBe("<p>once</p>");
  });

  test("preserves an explicit workspace write outcome error", async () => {
    const directory = await tempDir();
    const bodyFile = path.join(directory, "body.html");
    await writeFile(bodyFile, "<p>body</p>", "utf8");
    const server = await startProvider(path.join(directory, "provider.sock"), {
      async writeBody() {
        return Result.err({ code: "target_unavailable" });
      },
    });
    activeServers.push(server);

    const result = await runCli(
      ["article", "push", "a-1", "--body", bodyFile, "--expected-hash", "0".repeat(64)],
      path.join(directory, "provider.sock"),
    );

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error.code).toBe("target_unavailable");
  });

  test("reports disconnected status and asks the user to connect in the extension", async () => {
    const directory = await tempDir();
    const server = await startProvider(
      path.join(directory, "provider.sock"),
      {},
      {
        async getStatus() {
          return Result.ok({ connected: false });
        },
      },
    );
    activeServers.push(server);

    const status = await runCli(["status"], path.join(directory, "provider.sock"));
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual({ connected: false });

    const list = await runCli(["article", "list"], path.join(directory, "provider.sock"));
    expect(list.exitCode).not.toBe(0);
    expect(JSON.parse(list.stderr).error).toMatchObject({
      code: "not_connected",
      instruction: "运行 mpctl connect --extension <id> 获取连接指令。",
    });
  });

  test("reports malformed status wire results as protocol errors", async () => {
    const directory = await tempDir();
    const server = await startWireStatusProvider(path.join(directory, "malformed-status.sock"));
    activeServers.push(server);

    const result = await runCli(["status"], path.join(directory, "malformed-status.sock"));

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toEqual({ code: "invalid_result_envelope" });
  });

  test("status and article commands handle a connection-only broker without acquiring workspace", async () => {
    const directory = await tempDir();
    const server = await startConnectionOnlyProvider(path.join(directory, "provider.sock"));
    activeServers.push(server);

    const statusStartedAt = Date.now();
    const status = await runCli(["status"], path.join(directory, "provider.sock"));
    const statusElapsed = Date.now() - statusStartedAt;
    const listStartedAt = Date.now();
    const list = await runCli(["article", "list"], path.join(directory, "provider.sock"));
    const listElapsed = Date.now() - listStartedAt;
    const brokerStart = await runCli(["broker", "start"], path.join(directory, "provider.sock"));

    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual({ connected: false });
    expect(list.exitCode).not.toBe(0);
    expect(JSON.parse(list.stderr).error.code).toBe("not_connected");
    expect(brokerStart.exitCode).toBe(0);
    expect(JSON.parse(brokerStart.stdout)).toEqual({ started: false });
    expect(statusElapsed).toBeLessThan(1000);
    expect(listElapsed).toBeLessThan(1000);
  });

  test("reports Nexus workspace acquisition errors instead of hiding them as broker unavailable", async () => {
    const directory = await tempDir();
    const server = await startConnectionOnlyProvider(path.join(directory, "provider.sock"), true);
    activeServers.push(server);

    const result = await runCli(["article", "new"], path.join(directory, "provider.sock"));

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error.code).not.toBe("broker_unavailable");
    expect(JSON.parse(result.stderr).error).toEqual({ code: "E_SERVICE_UNAVAILABLE" });
  });

  test("broker start reports an already-running broker without spawning another", async () => {
    const directory = await tempDir();
    const server = await startProvider(path.join(directory, "provider.sock"), {});
    activeServers.push(server);

    const result = await runCli(["broker", "start"], path.join(directory, "provider.sock"));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ started: false });
  });

  test("disconnected connect returns a browser handoff without running a configured launcher", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "connect.sock");
    const marker = path.join(directory, "launcher-called");
    const launcher = path.join(directory, "test-browser");
    const extension = "a".repeat(32);
    await writeFile(
      launcher,
      `#!/bin/sh\n[ "$1" = "chrome-extension://${extension}/connect.html" ] || exit 3\n: > '${marker}'\n`,
      { mode: 0o700 },
    );
    const server = await startProvider(
      socket,
      {},
      {
        getStatus: async () => Result.ok({ connected: existsSync(marker) }),
      },
    );
    activeServers.push(server);
    const result = await runCliWithEnvironment(["connect", "--extension", extension], {
      MPCTL_BROKER_SOCKET: socket,
      MPCTL_BROWSER_EXECUTABLE: launcher,
      MPCTL_BROWSER_PROFILE: "",
      WSL_DISTRO_NAME: "",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toEqual({
      code: "not_connected",
      connectionPageUrl: `chrome-extension://${extension}/connect.html`,
      instruction: expect.any(String),
    });
    expect(existsSync(marker)).toBe(false);
    // The caller opens the page in its browser environment; a later CLI call only verifies status.
    await writeFile(marker, "caller-connected");
    const verified = await runCli(["connect"], socket);
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(verified.stdout)).toEqual({ connected: true });
  });

  test("connect does not launch a browser when already connected and rejects invalid extension IDs", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "connected.sock");
    const server = await startProvider(socket, {});
    activeServers.push(server);
    const connected = await runCliWithEnvironment(["connect", "--extension", "a".repeat(32)], {
      MPCTL_BROKER_SOCKET: socket,
      MPCTL_BROWSER_EXECUTABLE: path.join(directory, "nonexistent-browser"),
    });
    expect(connected.exitCode).toBe(0);
    expect(JSON.parse(connected.stdout)).toEqual({ connected: true });
    const invalid = await runCli(["connect", "--extension", "invalid"], socket);
    expect(JSON.parse(invalid.stderr).error.code).toBe("invalid_command");
  });

  test("connect returns a handoff without guessing an extension ID when none is supplied", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "launch-failure.sock");
    const server = await startProvider(
      socket,
      {},
      {
        getStatus: async () => Result.ok({ connected: false }),
      },
    );
    activeServers.push(server);
    const result = await runCliWithEnvironment(["connect"], {
      MPCTL_BROKER_SOCKET: socket,
      MPCTL_BROWSER_EXECUTABLE: path.join(directory, "nonexistent-browser"),
      WSL_DISTRO_NAME: "",
      MPCTL_EXTENSION_ID: "",
    });
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "not_connected",
      instruction: expect.any(String),
    });
    expect(JSON.parse(result.stderr).error.connectionPageUrl).toBeUndefined();
    expect(result.stderr).not.toContain(directory);
  });

  test("connect uses the configured extension ID in the handoff without invoking PowerShell in WSL", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "long-launcher.sock");
    const marker = path.join(directory, "launcher-started");
    const launcher = path.join(directory, "browser-process");
    await writeFile(launcher, `#!/bin/sh\n: > '${marker}'\nsleep 2\n`, { mode: 0o700 });
    const server = await startProvider(
      socket,
      {},
      {
        getStatus: async () => Result.ok({ connected: existsSync(marker) }),
      },
    );
    activeServers.push(server);
    const started = Date.now();
    const result = await runCliWithEnvironment(["connect"], {
      MPCTL_BROKER_SOCKET: socket,
      MPCTL_BROWSER_EXECUTABLE: launcher,
      MPCTL_EXTENSION_ID: "b".repeat(32),
      WSL_DISTRO_NAME: "isolated-wsl-fixture",
    });
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error.connectionPageUrl).toBe(
      `chrome-extension://${"b".repeat(32)}/connect.html`,
    );
    expect(existsSync(marker)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("broker start launches an independent broker, confirms readiness, and reuses it", async () => {
    const directory = await tempDir();
    const socketPath = path.join(directory, "isolated broker.sock");
    const wsPort = await reservePort();
    const environment = {
      MPCTL_BROKER_SOCKET: socketPath,
      MPCTL_BROKER_CONFIG: path.join(directory, "test-broker.json"),
      XDG_RUNTIME_DIR: directory,
      MPCTL_PAIRING_CREDENTIAL: `cli-start-test-${crypto.randomUUID()}`,
      MPCTL_BROKER_WS_PORT: String(wsPort),
    };

    const broker: { pid?: number; socketPath: string; startupAttempted: boolean } = {
      socketPath,
      startupAttempted: false,
    };
    activeBrokerProcesses.push(broker);
    let testFailure: unknown;
    try {
      broker.startupAttempted = true;
      const started = await runCliWithEnvironment(["broker", "start"], environment);
      broker.pid = await waitForBrokerPid(socketPath);

      expect(started).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(started.stdout)).toEqual({ started: true });
      await access(socketPath);

      const status = await runCliWithEnvironment(["status"], environment);
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout)).toEqual({ connected: false });

      const startedAgain = await runCliWithEnvironment(["broker", "start"], environment);
      expect(startedAgain.exitCode).toBe(0);
      expect(JSON.parse(startedAgain.stdout)).toEqual({ started: false });
      expect(await waitForBrokerPid(socketPath)).toBe(broker.pid);
    } catch (error) {
      testFailure = error;
    }
    let cleanupFailure: unknown;
    try {
      await cleanupBroker(broker);
      const index = activeBrokerProcesses.findIndex((item) => item.socketPath === socketPath);
      if (index >= 0) activeBrokerProcesses.splice(index, 1);
    } catch (error) {
      cleanupFailure = error;
    }
    if (testFailure !== undefined && cleanupFailure !== undefined) {
      throw new AggregateError(
        [testFailure, cleanupFailure],
        "Broker test failed and cleanup was incomplete",
      );
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
    if (testFailure !== undefined) throw testFailure;
  }, 20_000);

  test("broker start persists an environment credential for a later CLI process", async () => {
    const directory = await tempDir();
    const socketPath = path.join(directory, "persistent broker.sock");
    const configPath = path.join(directory, "mpctl", "broker.json");
    const credential = `persist-${crypto.randomUUID()}`;
    const wsPort = await reservePort();
    const broker: { pid?: number; socketPath: string; startupAttempted: boolean } = {
      socketPath,
      startupAttempted: true,
    };
    activeBrokerProcesses.push(broker);
    try {
      const started = await runCliWithEnvironment(["broker", "start"], {
        MPCTL_BROKER_SOCKET: socketPath,
        MPCTL_BROKER_CONFIG: configPath,
        MPCTL_PAIRING_CREDENTIAL: credential,
        MPCTL_BROKER_WS_PORT: String(wsPort),
      });
      broker.pid = await waitForBrokerPid(socketPath);
      expect(started.exitCode).toBe(0);
      expect(started.stdout).not.toContain(credential);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        pairingCredential: credential,
      });

      await cleanupBroker(broker);
      const trackedIndex = activeBrokerProcesses.indexOf(broker);
      if (trackedIndex >= 0) activeBrokerProcesses.splice(trackedIndex, 1);

      const laterStart = await runCliWithEnvironment(["broker", "start"], {
        MPCTL_BROKER_SOCKET: socketPath,
        MPCTL_BROKER_CONFIG: configPath,
        MPCTL_PAIRING_CREDENTIAL: "",
        MPCTL_BROKER_WS_PORT: String(wsPort),
      });
      broker.pid = await waitForBrokerPid(socketPath);
      activeBrokerProcesses.push(broker);
      expect(laterStart.exitCode).toBe(0);
      expect(JSON.parse(laterStart.stdout)).toEqual({ started: true });
    } finally {
      const index = activeBrokerProcesses.indexOf(broker);
      await cleanupBroker(broker);
      if (index >= 0) activeBrokerProcesses.splice(index, 1);
    }
  }, 20_000);

  test("concurrent broker start persists only the credential of the broker that won startup", async () => {
    const directory = await tempDir();
    const socketPath = path.join(directory, "concurrent.sock");
    const configPath = path.join(directory, "mpctl", "broker.json");
    const wsPort = await reservePort();
    const credentials = [`race-a-${crypto.randomUUID()}`, `race-b-${crypto.randomUUID()}`];
    const broker: { pid?: number; socketPath: string; startupAttempted: boolean } = {
      socketPath,
      startupAttempted: true,
    };
    activeBrokerProcesses.push(broker);
    try {
      const results = await Promise.all(
        credentials.map((credential) =>
          runCliWithEnvironment(["broker", "start"], {
            MPCTL_BROKER_SOCKET: socketPath,
            MPCTL_BROKER_CONFIG: configPath,
            MPCTL_PAIRING_CREDENTIAL: credential,
            MPCTL_BROKER_WS_PORT: String(wsPort),
          }),
        ),
      );
      broker.pid = await waitForBrokerPid(socketPath);
      const ownerEnvironment = await readFile(`/proc/${broker.pid}/environ`, "utf8");
      const ownerCredential = credentials.find((credential) =>
        ownerEnvironment.includes(`MPCTL_PAIRING_CREDENTIAL=${credential}`),
      );
      expect(ownerCredential).toBeDefined();
      expect(results.map(({ exitCode, stderr }) => ({ exitCode, stderr }))).toEqual([
        { exitCode: 0, stderr: "" },
        { exitCode: 0, stderr: "" },
      ]);
      const starts = results.map((result) => JSON.parse(result.stdout).started);
      expect(starts.filter(Boolean)).toHaveLength(1);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        pairingCredential: ownerCredential,
      });
    } finally {
      const index = activeBrokerProcesses.indexOf(broker);
      await cleanupBroker(broker);
      if (index >= 0) activeBrokerProcesses.splice(index, 1);
    }
  }, 20_000);

  test("broker start fails clearly when the spawned broker exits before IPC readiness", async () => {
    const directory = await tempDir();
    const result = await runCliWithEnvironment(["broker", "start"], {
      MPCTL_BROKER_SOCKET: path.join(directory, "missing.sock"),
      MPCTL_PAIRING_CREDENTIAL: "",
      MPCTL_BROKER_CONFIG: path.join(directory, "missing-config", "broker.json"),
    });

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "pairing_not_configured" });
    expect(result.stderr).not.toContain("broker_start_failed");
  });
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mpctl-cli-test-"));
  tempDirs.push(directory);
  return directory;
}

async function startProvider(
  socketPath: string,
  workspace: Partial<{
    cleanupWorkspace(): Promise<
      import("better-result").Result<
        { groupsRemoved: number; tabsMoved: number; groupsRemaining: number },
        import("@mpctl/contracts").WorkspaceError
      >
    >;
    listArticles(): Promise<
      import("better-result").Result<
        import("@mpctl/contracts").ArticleCandidate[],
        import("@mpctl/contracts").WorkspaceError
      >
    >;
    openArticle(
      candidate: string,
    ): Promise<
      import("better-result").Result<
        import("@mpctl/contracts").ArticleResult,
        import("@mpctl/contracts").WorkspaceError
      >
    >;
    newArticle(): Promise<
      import("better-result").Result<
        import("@mpctl/contracts").ArticleResult,
        import("@mpctl/contracts").WorkspaceError
      >
    >;
    currentArticle(): Promise<
      import("better-result").Result<
        import("@mpctl/contracts").ArticleResult,
        import("@mpctl/contracts").WorkspaceError
      >
    >;
    readBody(
      article: string,
    ): Promise<
      import("better-result").Result<
        { html: string; bodyHash: string },
        import("@mpctl/contracts").WorkspaceError
      >
    >;
    writeBody(
      article: string,
      html: string,
      expectedHash: string,
    ): Promise<
      import("better-result").Result<
        { bodyHash: string },
        import("@mpctl/contracts").WorkspaceError
      >
    >;
  }>,
  connection: {
    getStatus(): Promise<
      import("better-result").Result<
        import("@mpctl/contracts").ConnectionStatus,
        import("@mpctl/contracts").WorkspaceError
      >
    >;
  } = {
    async getStatus() {
      return Result.ok({ connected: true });
    },
  },
): Promise<{ dispose(): void }> {
  const address: NodeIpcSocketAddress = { kind: "path", path: socketPath };
  const nexus = new Nexus();
  const config = usingNodeIpcDaemon({
    appId: "mpctl",
    address,
    callTimeout: 2_000,
    configure: false,
    providers: [
      { token: workspaceToken, service: encodeWorkspaceProvider(workspace) },
      {
        token: connectionToken,
        service: {
          getStatus: async () => {
            return encodeResult(connectionStatusResultCodec, await connection.getStatus());
          },
        },
      },
    ],
  });
  const endpoint = config.endpoint?.implementation as UnixSocketServerEndpoint;
  nexus.configure(config);
  await nexus.ready();
  return { dispose: () => endpoint.close() };
}

async function startConnectionOnlyProvider(
  socketPath: string,
  connected = false,
): Promise<{ dispose(): void }> {
  const address: NodeIpcSocketAddress = { kind: "path", path: socketPath };
  const config = usingNodeIpcDaemon({
    appId: "mpctl",
    address,
    configure: false,
    providers: [
      {
        token: connectionToken,
        service: {
          async getStatus() {
            return encodeResult(connectionStatusResultCodec, Result.ok({ connected }));
          },
        },
      },
    ],
  });
  const nexus = new Nexus();
  const endpoint = config.endpoint?.implementation as UnixSocketServerEndpoint;
  nexus.configure(config);
  await nexus.ready();
  return { dispose: () => endpoint.close() };
}

async function startWireStatusProvider(socketPath: string): Promise<{ dispose(): void }> {
  const config = usingNodeIpcDaemon({
    appId: "mpctl",
    address: { kind: "path", path: socketPath },
    configure: false,
    providers: [
      {
        token: connectionToken,
        service: {
          async getStatus() {
            const result = await connectionStatusResultCodec.serialize(
              Result.err({ code: "invalid_result_envelope" }),
            );
            if (Result.isError(result))
              throw new Error("protocol envelope fixture serialization failed");
            return result.value;
          },
        },
      },
    ],
  });
  const nexus = new Nexus();
  const endpoint = config.endpoint?.implementation as UnixSocketServerEndpoint;
  nexus.configure(config);
  await nexus.ready();
  return { dispose: () => endpoint.close() };
}

function encodeWorkspaceProvider(
  workspace: NonNullable<Parameters<typeof startProvider>[1]>,
): WorkspaceService {
  return {
    cleanupWorkspace: async () =>
      encodeResult(cleanupWorkspaceResultCodec, await workspace.cleanupWorkspace!()),
    listArticles: async () =>
      encodeResult(listArticlesResultCodec, await workspace.listArticles!()),
    openArticle: async (candidate) =>
      encodeResult(articleResultCodec, await workspace.openArticle!(candidate)),
    newArticle: async () => encodeResult(articleResultCodec, await workspace.newArticle!()),
    currentArticle: async () => encodeResult(articleResultCodec, await workspace.currentArticle!()),
    readBody: async (article) =>
      encodeResult(workspaceResultCodec, await workspace.readBody!(article)),
    writeBody: async (article, html, expectedHash) =>
      encodeResult(writeBodyResultCodec, await workspace.writeBody!(article, html, expectedHash)),
  };
}

async function encodeResult<T, E extends object>(
  codec: {
    serialize(
      result: import("better-result").Result<T, E | import("@mpctl/contracts").ResultProtocolError>,
    ): Promise<
      import("better-result").Result<
        SerializedResult<T, ServiceError<E>>,
        import("@mpctl/contracts").ResultProtocolError
      >
    >;
  },
  result: import("better-result").Result<T, E | import("@mpctl/contracts").ResultProtocolError>,
): Promise<SerializedResult<T, ServiceError<E>>> {
  const encoded = await codec.serialize(result);
  if (Result.isError(encoded)) {
    return { status: "error" as const, error: encoded.error };
  }
  return encoded.value;
}

async function runCli(args: string[], socketPath: string) {
  return runCliWithEnvironment(args, {
    MPCTL_BROKER_SOCKET: socketPath,
    MPCTL_PAIRING_CREDENTIAL: "",
  });
}

async function runCliWithEnvironment(
  args: string[],
  extraEnvironment: Record<string, string>,
  onStderr?: (stdout: string, stderr: string) => void,
) {
  const isolatedConfigPath = path.join(
    path.dirname(extraEnvironment.MPCTL_BROKER_SOCKET!),
    "test-broker.json",
  );
  const child = spawn(process.execPath, ["run", "packages/cli/src/main.ts", ...args], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: { ...process.env, MPCTL_BROKER_CONFIG: isolatedConfigPath, ...extraEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let observationFailure: unknown;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    try {
      onStderr?.(stdout, stderr);
    } catch (error) {
      observationFailure = error;
      child.kill("SIGKILL");
    }
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (observationFailure !== undefined) reject(observationFailure);
      else resolve(code ?? 1);
    });
  });
  return { exitCode, stdout, stderr };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a broker port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForBrokerPid(socketPath: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const entry of await readdir("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      try {
        const environment = await readFile(`/proc/${entry.name}/environ`, "utf8");
        if (!environment.includes(`MPCTL_BROKER_SOCKET=${socketPath}`)) continue;
        const commandLine = await readFile(`/proc/${entry.name}/cmdline`, "utf8");
        if (commandLine.includes("packages/broker/src/main.ts")) return pid;
      } catch {
        // The process may have exited while /proc was inspected.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Could not identify broker process for ${socketPath}`);
}

async function stopBrokerProcess(pid: number, socketPath: string): Promise<void> {
  if (!(await isExpectedBrokerProcess(pid, socketPath))) return;
  await signalExpectedBroker(pid, socketPath, "SIGTERM");
  if (await waitForBrokerExit(pid, socketPath, 5_000)) return;
  await signalExpectedBroker(pid, socketPath, "SIGKILL");
  if (await waitForBrokerExit(pid, socketPath, 2_000)) return;
  throw new Error(`Broker process ${pid} did not terminate after SIGTERM and SIGKILL`);
}

async function signalExpectedBroker(
  pid: number,
  socketPath: string,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!(await isExpectedBrokerProcess(pid, socketPath))) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

async function waitForBrokerExit(
  pid: number,
  socketPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isExpectedBrokerProcess(pid, socketPath))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !(await isExpectedBrokerProcess(pid, socketPath));
}

async function cleanupBroker(broker: {
  pid?: number;
  socketPath: string;
  startupAttempted?: boolean;
}): Promise<void> {
  const socketExists = await access(broker.socketPath).then(
    () => true,
    () => false,
  );
  const pid = broker.pid ?? (await waitForBrokerPid(broker.socketPath).catch(() => undefined));
  if (pid === undefined) {
    if (socketExists || broker.startupAttempted) {
      throw new Error(
        `Cannot verify broker startup cleanup for ${broker.socketPath}; preserving artifacts`,
      );
    }
    return;
  }
  if (!(await isExpectedBrokerProcess(pid, broker.socketPath))) {
    if (
      await access(broker.socketPath).then(
        () => true,
        () => false,
      )
    ) {
      throw new Error(
        `Broker PID ${pid} could not be revalidated for ${broker.socketPath}; preserving artifacts`,
      );
    }
    return;
  }
  await stopBrokerProcess(pid, broker.socketPath);
  if (await isExpectedBrokerProcess(pid, broker.socketPath)) {
    throw new Error(`Refusing to remove socket while broker ${pid} remains alive`);
  }
  await unlink(broker.socketPath).catch((error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  });
}

async function isExpectedBrokerProcess(pid: number, socketPath: string): Promise<boolean> {
  try {
    const [environment, commandLine] = await Promise.all([
      readFile(`/proc/${pid}/environ`, "utf8"),
      readFile(`/proc/${pid}/cmdline`, "utf8"),
    ]);
    return (
      (socketPath === "" || environment.includes(`MPCTL_BROKER_SOCKET=${socketPath}`)) &&
      commandLine.includes("packages/broker/src/main.ts")
    );
  } catch {
    return false;
  }
}
