// This actual workspace/CLI regression consumes browser-domain production code.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference lib="dom" />
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="../../extension/node_modules/@types/chrome/index.d.ts" />
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { Nexus } from "@nexus-js/core";
import {
  usingNodeIpcDaemon,
  usingNodeIpcClient,
  UnixSocketServerEndpoint,
} from "@nexus-js/node-ipc";
import { assetCommand } from "../src/asset";
import {
  connectionToken,
  workspaceToken,
  cleanupWorkspaceResultCodec,
  listArticlesResultCodec,
  articleResultCodec,
  workspaceResultCodec,
  articleFieldsResultCodec,
  articleStateResultCodec,
  articleCheckResultCodec,
  assetListResultCodec,
  operationResultCodec,
  articleCoverResultCodec,
  protocolVersion,
  connectionStatusResultCodec,
  type ServiceError,
  type WorkspaceService,
  createOperationId,
} from "@mpctl/contracts";
import { Result } from "better-result";
import { installIdbFixture } from "../../extension/test/idb-fixture";
import { navigationFixture } from "../../extension/test/browser/fixtures/navigation-workspace";
const fixtureLedgerId = crypto.randomUUID();
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
  withConnection,
  operationOutcome,
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
  test("open's confirmed live reference crosses IPC and is directly usable without current", async () => {
    const restore = installIdbFixture();
    const f = await navigationFixture();
    const directory = await tempDir();
    const socket = path.join(directory, "live-open.sock");
    f.addSaved("A");
    const nexus = new Nexus();
    const config = usingNodeIpcDaemon({
      appId: "mpctl",
      address: { kind: "path", path: socket },
      configure: false,
      providers: [
        { token: workspaceToken, service: f.workspace },
        {
          token: connectionToken,
          service: {
            getStatus: async () => ({
              status: "ok" as const,
              value: {
                connected: true,
                brokerVersion: protocolVersion,
                extensionVersion: protocolVersion,
                ledgerId: f.operations.ledgerId,
                keyLedgerId: f.operations.ledgerId,
              },
            }),
          },
        },
      ],
    });
    nexus.configure(config);
    await nexus.ready();
    try {
      const opened = await runCli(["article", "open", "A"], socket);
      expect(opened.exitCode).toBe(0);
      const reply = JSON.parse(opened.stdout);
      expect(reply.article).toMatch(/^ephemeral:/);
      const file = path.join(directory, "body.html");
      expect(
        (await runCli(["article", "pull", reply.article, "--body", file], socket)).exitCode,
      ).toBe(0);
      expect(await readFile(file, "utf8")).toBe("dirty content retained");
      const history = await runCli(
        ["article", "open", "A", "--operation", reply.snapshot.operationId],
        socket,
      );
      expect(JSON.parse(history.stdout).article).toBeUndefined();
      expect(JSON.parse(history.stdout).snapshot).toEqual(reply.snapshot);
    } finally {
      (config.endpoint!.implementation as UnixSocketServerEndpoint).close();
      f.dispose();
      restore();
    }
  });

  test("complete inspect stdout is a SAVE input; malformed or foreign state fails locally", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "complete-inspect.sock");
    const state = {
      article: "article-ref",
      title: " Title ",
      author: "",
      summary: "Summary",
      bodyHash: "a".repeat(64),
      fieldsHash: "b".repeat(64),
      coverHash: "c".repeat(64),
    };
    let saved = 0;
    activeServers.push(
      await startProvider(socket, {
        async inspectArticle(article, options) {
          expect(article).toBe(state.article);
          expect(options).toEqual({ all: true });
          return Result.ok(state);
        },
        async saveArticle(article, bodyHash, fieldsHash, coverHash) {
          expect(article).toBe(state.article);
          expect([bodyHash, fieldsHash, coverHash]).toEqual([
            state.bodyHash,
            state.fieldsHash,
            state.coverHash,
          ]);
          saved++;
          return Result.ok({ article, title: state.title, bodyHash });
        },
      }),
    );
    const inspected = await runCli(["article", "inspect", state.article, "--all"], socket);
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout)).toEqual(state);
    const file = path.join(directory, "state.json");
    await writeFile(file, inspected.stdout);
    expect(
      (await runCli(["article", "save", state.article, "--expect", file], socket)).exitCode,
    ).toBe(0);
    expect(saved).toBe(1);
    for (const contents of [
      "{",
      JSON.stringify({ ...state, article: "other" }),
      JSON.stringify({ ...state, bodyHash: "invalid" }),
      JSON.stringify({ title: "", author: "", summary: "", fieldsHash: state.fieldsHash }),
    ]) {
      await writeFile(file, contents);
      const rejected = await runCli(["article", "save", state.article, "--expect", file], socket);
      expect(rejected.exitCode).toBe(1);
      expect(JSON.parse(rejected.stderr).error.code).toBe("invalid_command");
    }
    expect(saved).toBe(1);
  });

  test("complete inspection refuses a fields-only or different-article reply", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "incomplete-state.sock");
    let foreign = false;
    activeServers.push(
      await startProvider(socket, {
        async inspectArticle() {
          const fields = { title: "Title", author: "", summary: "", fieldsHash: "b".repeat(64) };
          return Result.ok(
            foreign
              ? { ...fields, article: "other", bodyHash: "a".repeat(64), coverHash: "c".repeat(64) }
              : fields,
          );
        },
      }),
    );
    for (foreign of [false, true]) {
      const result = await runCli(["article", "inspect", "ref", "--all"], socket);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_result_envelope");
    }
  });

  test("F1 actual cleanup CLI retains original committed placement/cause/key and status adds zero effects", async () => {
    const restore = installIdbFixture();
    const f = await navigationFixture();
    const directory = await tempDir();
    const socket = path.join(directory, "cleanup-evidence.sock");
    f.manager.cleanupWorkspace = async (progress) => {
      await progress!.dispatch("tab_group", async () => {
        f.counters.group++;
      });
      await progress!.placed!();
      return Result.err({
        code: "page_failed",
        observedFailure: { kind: "runtime", causeCode: "tab_group_failed" },
      });
    };
    const nexus = new Nexus();
    let wire: any;
    const config = usingNodeIpcDaemon({
      appId: "mpctl",
      address: { kind: "path", path: socket },
      configure: false,
      providers: [
        {
          token: workspaceToken,
          service: {
            ...f.workspace,
            cleanupWorkspace: async () => {
              wire = await f.workspace.cleanupWorkspace();
              return wire;
            },
          },
        },
        {
          token: connectionToken,
          service: {
            getStatus: async () => ({
              status: "ok" as const,
              value: {
                connected: true,
                brokerVersion: protocolVersion,
                extensionVersion: protocolVersion,
                ledgerId: f.operations.ledgerId,
              },
            }),
          },
        },
      ],
    });
    nexus.configure(config);
    await nexus.ready();
    try {
      const result = await runCli(["workspace", "cleanup"], socket);
      expect(result.exitCode).toBe(1);
      const terminal = JSON.parse(result.stderr.trim()).error;
      expect(terminal).toMatchObject({
        code: "page_failed",
        snapshot: {
          operationId: wire.error.snapshot.operationId,
          state: "settled",
          effect: { maintenance: true, placements: 1 },
          result: {
            error: { cause: { at: "bg.navigation", kind: "runtime", code: "tab_group_failed" } },
          },
        },
      });
      const counts = { ...f.counters };
      const status = await runCli(["operation", "status", terminal.snapshot.operationId], socket);
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout).snapshot).toEqual(wire.error.snapshot);
      expect(f.counters).toEqual(counts);
      expect(counts.group).toBe(1);
      // The same decoded error also carries validated diagnostics/blocking facts;
      // the terminal must not reconstruct them.
      const cleanup = f.workspace.cleanupWorkspace;
      f.workspace.cleanupWorkspace = async () => {
        const response = await cleanup();
        if (
          response.status !== "error" ||
          !("snapshot" in response.error) ||
          !response.error.snapshot
        )
          throw new Error("missing maintenance snapshot");
        return {
          status: "error",
          error: {
            ...response.error,
            blockingOperationId: terminal.snapshot.operationId,
            issue: {
              operationId: response.error.snapshot.operationId,
              failure: {
                code: "storage_failed",
                cause: { at: "bg.persistence", kind: "runtime", code: "storage_failed" },
              },
            },
          },
        };
      };
      // Provider's forwarding wrapper uses the current production service slot.
      const detailed = await runCli(["workspace", "cleanup"], socket);
      expect(detailed.exitCode).toBe(1);
      const facts = JSON.parse(detailed.stderr.trim()).error;
      expect(facts).toMatchObject({
        snapshot: { effect: { placements: 1 } },
        blockingOperationId: terminal.snapshot.operationId,
        issue: { failure: { code: "storage_failed" } },
      });
    } finally {
      (config.endpoint!.implementation as UnixSocketServerEndpoint).close();
      f.dispose();
      restore();
    }
  });
  test("F2/G0 actual spawned CLI consumes admitted status epoch with no key RPC; explicit old key never gets replacement", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "epoch.sock");
    const epoch = crypto.randomUUID();
    let keys = 0;
    let native = 0;
    const provider = encodeWorkspaceProvider({
      newArticle: async () => Result.ok({ article: "unused", title: "", bodyHash: "a".repeat(64) }),
    });
    provider.newArticle = async (input) => {
      if (!input.operationId.startsWith(`op:${epoch}:`))
        return {
          status: "error",
          error: { operationId: input.operationId, failure: { code: "ledger_mismatch" } },
        };
      native++;
      return (
        await operationResultCodec.serialize(
          Result.ok({
            snapshot: {
              operationId: input.operationId,
              operation: "new",
              state: "settled",
              effect: {
                navigation: true,
                outcome: "confirmed",
                pageCreated: true,
                auxiliaryCreated: [],
                targetBound: true,
              },
              result: { status: "ok", value: {} },
            },
          }),
        )
      ).unwrap();
    };
    const forbidden = {
      ...provider,
      getKeyLedger: async () => {
        keys++;
        throw new Error("no new handshake permitted");
      },
    };
    const nexus = new Nexus();
    const config = usingNodeIpcDaemon({
      appId: "mpctl",
      address: { kind: "path", path: socket },
      configure: false,
      providers: [
        { token: workspaceToken, service: forbidden },
        {
          token: connectionToken,
          service: {
            getStatus: async () => ({
              status: "ok" as const,
              value: {
                connected: true,
                brokerVersion: protocolVersion,
                extensionVersion: protocolVersion,
                ledgerId: fixtureLedgerId,
                keyLedgerId: epoch,
              },
            }),
          },
        },
      ],
    });
    nexus.configure(config);
    await nexus.ready();
    activeServers.push({
      dispose: () => (config.endpoint!.implementation as UnixSocketServerEndpoint).close(),
    });
    const first = await runCli(["article", "new"], socket);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).snapshot.operationId).toStartWith(`op:${epoch}:`);
    const old = createOperationId(fixtureLedgerId);
    const failed = await runCli(["article", "new", "--operation", old], socket);
    expect(failed.exitCode).not.toBe(0);
    expect(JSON.parse(failed.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
      operationId: old,
      code: "ledger_mismatch",
    });
    expect({ keys, native }).toEqual({ keys: 0, native: 1 });
  });
  test("E3 BODY cleanup is an interaction diagnostic and cannot replace a committed success", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "body-cleanup.sock");
    activeServers.push(
      await startProvider(socket, {
        writeBody: async () => Result.ok({ bodyHash: "a".repeat(64) }),
      }),
    );
    const client = new Nexus().configure(
      usingNodeIpcClient({
        appId: "body-cleanup-test",
        resolveAddress: () => ({ kind: "path", path: socket }),
        configure: false,
      }),
    );
    await client.ready();
    const connection = await client.connect({
      target: { context: "node-ipc-daemon", appId: "mpctl", instance: "default" },
    });
    const prototype = Object.getPrototypeOf(connection);
    const original = prototype.disconnect;
    const disconnect = spyOn(prototype, "disconnect").mockImplementation(
      function (this: import("@nexus-js/core").Connection) {
        original.call(this);
        throw new Error("private cleanup");
      },
    );
    const previous = process.env.MPCTL_BROKER_SOCKET;
    process.env.MPCTL_BROKER_SOCKET = socket;
    try {
      const result = await withConnection(async ({ workspace, keyLedgerId }) =>
        workspace.writeBody({
          article: "ref",
          html: "next",
          expectedHash: "b".repeat(64),
          operationId: `op:${keyLedgerId}:${crypto.randomUUID()}`,
        }),
      );
      expect(result).toMatchObject(
        Result.ok({
          snapshot: {
            state: "settled",
            effect: { outcome: "confirmed", bodyHash: "a".repeat(64) },
            result: { status: "ok" },
          },
          issue: {
            failure: {
              code: "cleanup_failed",
              cause: { at: "cli.cleanup", code: "broker_disconnect_failed" },
            },
          },
        }),
      );
    } finally {
      disconnect.mockRestore();
      connection.disconnect();
      if (previous === undefined) delete process.env.MPCTL_BROKER_SOCKET;
      else process.env.MPCTL_BROKER_SOCKET = previous;
    }
  });
  test("E3 operation status succeeds for failed business snapshots, push does not", () => {
    const snapshot = {
      operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
      operation: "body" as const,
      state: "settled" as const,
      effect: { outcome: "not_dispatched" as const },
      result: { status: "error" as const, error: { code: "content_conflict" as const } },
    };
    expect(operationOutcome({ snapshot }, true).isOk()).toBe(true);
    const pushed = operationOutcome({ snapshot }, false);
    expect(pushed.isErr()).toBe(true);
    expect(pushed.isErr() && pushed.error.details?.snapshot).toEqual(snapshot);
  });
  test.each(["read-legacy", "read-enriched", "set-legacy", "set-enriched"] as const)(
    "W2 correction cover %s retains primary code and received read facts over IPC",
    async (mode) => {
      const directory = await tempDir();
      const socket = path.join(directory, "cover-domain.sock");
      const readFailure = {
        stage: "native_read",
        kind: "runtime",
        causeCode: "cover_read_failed",
        component: "cover",
      } as const;
      const error = {
        code: "cover_unavailable" as const,
        ...(mode.endsWith("enriched") ? { readFailure } : {}),
      };
      activeServers.push(
        await startProvider(socket, {
          readArticleCover: async () => Result.err(error),
          setArticleCover: async () =>
            Result.err({
              code: "cover_unavailable",
              cause: {
                at: "bg.preflight",
                kind: mode.endsWith("enriched") ? "runtime" : "domain",
                code: mode.endsWith("enriched") ? "cover_read_failed" : "cover_unavailable",
              },
            }),
        }),
      );
      const previous = process.env.MPCTL_BROKER_SOCKET;
      process.env.MPCTL_BROKER_SOCKET = socket;
      try {
        const result = await withConnection<unknown>(({ workspace }) =>
          mode.startsWith("read")
            ? workspace.readArticleCover("ref")
            : workspace.setArticleCover({
                article: "ref",
                asset: "asset",
                expectedCoverHash: "0".repeat(64),
                operationId: `op:${fixtureLedgerId}:${crypto.randomUUID()}`,
              }),
        );
        if (mode.startsWith("set")) {
          expect(result.isOk()).toBe(true);
          if (result.isOk())
            expect(result.value).toMatchObject({
              snapshot: {
                effect: { cover: true, outcome: "not_dispatched" },
                result: {
                  status: "error",
                  error: {
                    code: "cover_unavailable",
                    cause: {
                      at: "bg.preflight",
                      kind: mode.endsWith("enriched") ? "runtime" : "domain",
                      code: mode.endsWith("enriched") ? "cover_read_failed" : "cover_unavailable",
                    },
                  },
                },
              },
            });
          return;
        }
        expect(result.isErr()).toBe(true);
        if (result.isOk()) throw new Error("expected cover failure");
        expect(result.error.code).toBe("cover_unavailable");
        expect(result.error.details?.readFailure).toEqual(
          mode.endsWith("enriched") ? readFailure : undefined,
        );
        expect(result.error.details).not.toHaveProperty("coverFailure");
      } finally {
        if (previous === undefined) delete process.env.MPCTL_BROKER_SOCKET;
        else process.env.MPCTL_BROKER_SOCKET = previous;
      }
    },
  );
  test.each(["fields", "cover", "save"] as const)(
    "W2 correction received %s preflight readFailure survives genuine IPC",
    async (operation) => {
      const directory = await tempDir();
      const socket = path.join(directory, "preflight-read.sock");
      activeServers.push(
        await startProvider(socket, {
          updateArticleFields: async () =>
            Result.err({
              code: "page_failed",
              cause: { at: "content.readback", kind: "runtime", code: "dom_read_failed" },
              cleanup: { at: "cli.cleanup", kind: "runtime", code: "library_cleanup_failed" },
            }),
          setArticleCover: async () =>
            Result.err({
              code: "page_failed",
              cause: { at: "bg.preflight", kind: "runtime", code: "dom_read_failed" },
              cleanup: {
                at: "content.cover_cleanup",
                kind: "runtime",
                code: "library_cleanup_failed",
              },
            }),
          saveArticle: async () =>
            Result.err({
              code: "page_failed",
              cause: { at: "bg.preflight", kind: "runtime", code: "dom_read_failed" },
              cleanup: {
                at: "content.history_cleanup",
                kind: "runtime",
                code: "library_cleanup_failed",
              },
            }),
        }),
      );
      const previous = process.env.MPCTL_BROKER_SOCKET;
      process.env.MPCTL_BROKER_SOCKET = socket;
      try {
        const result = await withConnection<unknown>(({ workspace }) =>
          operation === "fields"
            ? workspace.updateArticleFields({
                article: "ref",
                fields: { title: "next" },
                expectedHash: "0".repeat(64),
                operationId: `op:${fixtureLedgerId}:${crypto.randomUUID()}`,
              })
            : operation === "cover"
              ? workspace.setArticleCover({
                  article: "ref",
                  asset: "asset",
                  expectedCoverHash: "0".repeat(64),
                  operationId: `op:${fixtureLedgerId}:${crypto.randomUUID()}`,
                })
              : workspace.saveArticle({
                  article: "ref",
                  expectedBodyHash: "0".repeat(64),
                  expectedFieldsHash: "0".repeat(64),
                  expectedCoverHash: "0".repeat(64),
                  operationId: `op:${fixtureLedgerId}:${crypto.randomUUID()}`,
                }),
        );
        if (operation === "fields") {
          expect(result.isOk()).toBe(true);
          if (result.isOk())
            expect(result.value).toMatchObject({
              snapshot: {
                operation: "fields",
                effect: { outcome: "not_dispatched", attempted: [] },
                result: {
                  status: "error",
                  error: {
                    code: "page_failed",
                    cause: { code: "dom_read_failed" },
                    cleanup: { code: "library_cleanup_failed" },
                  },
                },
              },
            });
          return;
        }
        expect(result.isOk()).toBe(true);
        if (result.isOk())
          expect(result.value).toMatchObject({
            snapshot: {
              operation,
              effect: { outcome: "not_dispatched" },
              result: {
                status: "error",
                error: {
                  code: "page_failed",
                  cause: { at: "bg.preflight", kind: "runtime", code: "dom_read_failed" },
                  cleanup: { code: "library_cleanup_failed" },
                },
              },
            },
          });
      } finally {
        if (previous === undefined) delete process.env.MPCTL_BROKER_SOCKET;
        else process.env.MPCTL_BROKER_SOCKET = previous;
      }
    },
  );
  test.each(["first-cleanup", "later-broker-cleanup"] as const)(
    "W2 received cover first cause and %s survive IPC disconnect failure",
    async (mode) => {
      const directory = await tempDir();
      const socket = path.join(directory, "cover-cleanup-seam.sock");
      activeServers.push(
        await startProvider(socket, {
          async setArticleCover() {
            return Result.err({
              code: "content_conflict",
              cause: { at: "content.preflight", kind: "domain", code: "content_conflict" },
              ...(mode === "first-cleanup"
                ? {
                    cleanup: {
                      at: "content.cover_cleanup",
                      kind: "runtime",
                      code: "dialog_cleanup_failed",
                    },
                  }
                : {}),
            });
          },
        }),
      );
      const client = new Nexus().configure(
        usingNodeIpcClient({
          appId: "cleanup-test",
          resolveAddress: () => ({ kind: "path", path: socket }),
          configure: false,
        }),
      );
      await client.ready();
      const connection = await client.connect({
        target: { context: "node-ipc-daemon", appId: "mpctl", instance: "default" },
      });
      const prototype = Object.getPrototypeOf(connection);
      const original = prototype.disconnect;
      const disconnect = spyOn(prototype, "disconnect").mockImplementation(
        function (this: import("@nexus-js/core").Connection) {
          original.call(this);
          throw new Error("private cleanup");
        },
      );
      const previous = process.env.MPCTL_BROKER_SOCKET;
      process.env.MPCTL_BROKER_SOCKET = socket;
      try {
        const result = await withConnection(({ workspace }) =>
          workspace.setArticleCover({
            article: "ref",
            asset: "asset",
            expectedCoverHash: "0".repeat(64),
            operationId: `op:${fixtureLedgerId}:${crypto.randomUUID()}`,
          }),
        );
        expect(result.isOk()).toBe(true);
        if (result.isOk())
          expect(result.value).toMatchObject({
            snapshot: {
              result: {
                status: "error",
                error: {
                  code: "content_conflict",
                  cause: { at: "content.preflight", kind: "domain", code: "content_conflict" },
                  ...(mode === "first-cleanup"
                    ? {
                        cleanup: {
                          at: "content.cover_cleanup",
                          kind: "runtime",
                          code: "dialog_cleanup_failed",
                        },
                      }
                    : {}),
                },
              },
            },
            issue: {
              failure: {
                code: "cleanup_failed",
                cause: { at: "cli.cleanup", kind: "runtime", code: "broker_disconnect_failed" },
              },
            },
          });
      } finally {
        disconnect.mockRestore();
        connection.disconnect();
        if (previous === undefined) delete process.env.MPCTL_BROKER_SOCKET;
        else process.env.MPCTL_BROKER_SOCKET = previous;
      }
    },
  );
  test.each(["body", "cover", "save", "read"] as const)(
    "W2 %s real remote exception keeps observed boundary cause",
    async (operation) => {
      const directory = await tempDir();
      const socket = path.join(directory, "cause-seam.sock");
      activeServers.push(
        await startProvider(socket, {
          async writeBody() {
            throw new Error("private");
          },
          async setArticleCover() {
            throw new Error("private");
          },
          async saveArticle() {
            throw new Error("private");
          },
          async readBody() {
            throw new Error("private");
          },
        }),
      );
      const previous = process.env.MPCTL_BROKER_SOCKET;
      process.env.MPCTL_BROKER_SOCKET = socket;
      try {
        const result = await withConnection<unknown>(({ workspace }) =>
          operation === "body"
            ? workspace.writeBody({
                article: "ref",
                html: "next",
                expectedHash: "0".repeat(64),
                operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
              })
            : operation === "cover"
              ? workspace.setArticleCover({
                  article: "ref",
                  asset: "asset",
                  expectedCoverHash: "0".repeat(64),
                  operationId: `op:${fixtureLedgerId}:${crypto.randomUUID()}`,
                })
              : operation === "save"
                ? workspace.saveArticle({
                    article: "ref",
                    expectedBodyHash: "0".repeat(64),
                    expectedFieldsHash: "0".repeat(64),
                    expectedCoverHash: "0".repeat(64),
                    operationId: `op:${fixtureLedgerId}:${crypto.randomUUID()}`,
                  })
                : workspace.readBody("ref"),
        );
        expect(result.isErr()).toBe(true);
        if (result.isOk()) return;
        const detail =
          operation !== "read"
            ? result.error.details?.issue?.failure.cause
            : result.error.details?.readFailure;
        expect(detail).toMatchObject(
          operation !== "read"
            ? { at: "cli.call", kind: "nexus", code: "E_REMOTE_EXCEPTION" }
            : {
                stage: "workspace_call",
                kind: "nexus",
                causeCode: "E_REMOTE_EXCEPTION",
                ...(operation === "read" ? {} : { outcome: "unknown" }),
              },
        );
        if (operation === "read") expect(detail).not.toHaveProperty("outcome");
      } finally {
        if (previous === undefined) delete process.env.MPCTL_BROKER_SOCKET;
        else process.env.MPCTL_BROKER_SOCKET = previous;
      }
    },
  );
  test.each(["remote", "provider"] as const)(
    "W2 typed field boundary %s retains cause and observed facts",
    async (mode) => {
      const directory = await tempDir();
      const socket = path.join(directory, "field-seam.sock");
      activeServers.push(
        await startProvider(socket, {
          async updateArticleFields() {
            if (mode === "remote") throw new Error("private remote error");
            return Result.err({
              code: "field_update_unknown",
              cause: { at: "content.field_edit", kind: "runtime", code: "field_setter_failed" },
              effect: {
                outcome: "partial",
                requested: ["title", "author", "summary"],
                attempted: ["title", "author"],
                confirmed: ["title"],
                unknown: ["author"],
              },
            });
          },
        }),
      );
      const previous = process.env.MPCTL_BROKER_SOCKET;
      process.env.MPCTL_BROKER_SOCKET = socket;
      try {
        const result = await withConnection(({ workspace }) =>
          workspace.updateArticleFields({
            operationId: createOperationId(fixtureLedgerId),
            article: "ref",
            fields: { title: "new", author: "new", summary: "never attempted" },
            expectedHash: "0".repeat(64),
          }),
        );
        if (mode === "remote") {
          expect(result.isErr()).toBe(true);
          if (result.isErr())
            expect(result.error.details?.issue?.failure.cause).toMatchObject({
              at: "cli.call",
              kind: "nexus",
              code: "E_REMOTE_EXCEPTION",
            });
        } else {
          expect(result.isOk()).toBe(true);
          if (result.isOk())
            expect(result.value.snapshot).toMatchObject({
              effect: { confirmed: ["title"], unknown: ["author"] },
              result: { status: "error", error: { cause: { code: "field_setter_failed" } } },
            });
        }
      } finally {
        if (previous === undefined) delete process.env.MPCTL_BROKER_SOCKET;
        else process.env.MPCTL_BROKER_SOCKET = previous;
      }
    },
  );
  test.each([
    "missing-broker",
    "missing-extension",
    "empty-broker",
    "empty-extension",
    "wrong-broker",
    "wrong-extension",
    "matched",
  ])("W2 exact metadata admission: %s before workspace acquisition/callback", async (mode) => {
    const directory = await tempDir();
    const socket = path.join(directory, "admission.sock");
    let callbacks = 0;
    activeServers.push(
      await startProvider(
        socket,
        {},
        {
          async getStatus() {
            return Result.ok({
              connected: true,
              ledgerId: fixtureLedgerId,
              keyLedgerId: fixtureLedgerId,
              ...(mode === "missing-broker"
                ? {}
                : {
                    brokerVersion:
                      mode === "empty-broker"
                        ? ""
                        : mode === "wrong-broker"
                          ? "0.9.0"
                          : protocolVersion,
                  }),
              ...(mode === "missing-extension"
                ? {}
                : {
                    extensionVersion:
                      mode === "empty-extension"
                        ? ""
                        : mode === "wrong-extension"
                          ? "0.9.0"
                          : protocolVersion,
                  }),
            });
          },
        },
      ),
    );
    const previous = process.env.MPCTL_BROKER_SOCKET;
    process.env.MPCTL_BROKER_SOCKET = socket;
    const probe = new Nexus().configure(
      usingNodeIpcClient({
        appId: "admission-probe",
        resolveAddress: () => ({ kind: "path", path: socket }),
        configure: false,
      }),
    );
    await probe.ready();
    const probeConnection = await probe.connect({
      target: { context: "node-ipc-daemon", appId: "mpctl", instance: "default" },
    });
    const prototype = Object.getPrototypeOf(probeConnection);
    const originalGet = prototype.safeGet;
    let workspaceAcquisitions = 0;
    const acquisition = spyOn(prototype, "safeGet").mockImplementation(function (
      this: import("@nexus-js/core").Connection,
      token: Parameters<import("@nexus-js/core").Connection["safeGet"]>[0],
      options: Parameters<import("@nexus-js/core").Connection["safeGet"]>[1],
    ) {
      if (token === workspaceToken) workspaceAcquisitions++;
      return originalGet.call(this, token, options);
    });
    try {
      const result = await withConnection(async () => {
        callbacks++;
        return Result.ok("called");
      });
      if (mode === "matched") expect(result).toEqual(Result.ok("called"));
      else
        expect(Result.isError(result) && result.error.details).toMatchObject({
          connectionFailure: {
            action: "connect",
            stage: "version_check",
            kind: "protocol",
            causeCode: "version_mismatch",
          },
        });
      expect(callbacks).toBe(mode === "matched" ? 1 : 0);
      expect(workspaceAcquisitions).toBe(mode === "matched" ? 1 : 0);
    } finally {
      acquisition.mockRestore();
      probeConnection.disconnect();
      if (previous === undefined) delete process.env.MPCTL_BROKER_SOCKET;
      else process.env.MPCTL_BROKER_SOCKET = previous;
    }
  });
  test.each(["asset_ambiguous", "asset_upload_unknown", "known-created"] as const)(
    "R3 legacy %s upload preserves received domain evidence",
    async (mode) => {
      const directory = await tempDir();
      const socket = path.join(directory, "legacy.sock");
      const file = path.join(directory, "legacy.png");
      await writeFile(file, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
      let calls = 0;
      activeServers.push(
        await startProvider(
          socket,
          {
            async uploadAsset() {
              calls++;
              return Result.err(
                mode === "known-created"
                  ? {
                      code: "asset_upload_unknown",
                      effect: {
                        outcome: "confirmed",
                        filename: "legacy.png",
                        thumbnailUrl: "https://mmbiz.qpic.cn/test/300",
                      },
                    }
                  : { code: mode },
              );
            },
          },
          {
            async getStatus() {
              return Result.ok({
                connected: true,
                brokerVersion: protocolVersion,
                extensionVersion: protocolVersion,
                ledgerId: fixtureLedgerId,
                keyLedgerId: fixtureLedgerId,
              });
            },
          },
        ),
      );
      const result = await runCli(["asset", "upload", "ref", "--file", file], socket);
      expect(JSON.parse(result.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
        code: mode === "known-created" ? "asset_upload_unknown" : mode,
        snapshot: {
          operation: "upload",
          effect: { outcome: mode === "known-created" ? "confirmed" : "unknown" },
        },
      });
      expect(calls).toBe(1);
    },
  );

  test.each(["malformed", "remote", "missing-status", "missing-workspace"] as const)(
    "R3 %s status/acquisition failure never dispatches upload",
    async (mode) => {
      const directory = await tempDir();
      const socket = path.join(directory, "status.sock");
      const file = path.join(directory, "input.png");
      await writeFile(file, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
      let calls = 0;
      const config = usingNodeIpcDaemon({
        appId: "mpctl",
        address: { kind: "path", path: socket },
        configure: false,
        providers: [
          ...(mode === "missing-status"
            ? []
            : [
                {
                  token: connectionToken,
                  service: {
                    async getStatus() {
                      if (mode === "remote") throw new Error("private provider exception");
                      if (mode === "malformed")
                        return { status: "ok", value: { connected: "bad" } } as never;
                      return encodeResult(
                        connectionStatusResultCodec,
                        Result.ok({
                          connected: true,
                          brokerVersion: protocolVersion,
                          extensionVersion: protocolVersion,
                          ledgerId: fixtureLedgerId,
                          keyLedgerId: fixtureLedgerId,
                        }),
                      );
                    },
                  },
                },
              ]),
          ...(mode === "missing-workspace"
            ? []
            : [
                {
                  token: workspaceToken,
                  service: encodeWorkspaceProvider({
                    async uploadAsset() {
                      calls++;
                      return Result.err({ code: "asset_ambiguous" });
                    },
                  }),
                },
              ]),
        ],
      });
      const provider = new Nexus().configure(config);
      await provider.ready();
      activeServers.push({
        dispose: () => (config.endpoint!.implementation as UnixSocketServerEndpoint).close(),
      });
      const result = await runCli(["asset", "upload", "ref", "--file", file], socket);
      expect(JSON.parse(result.stderr).error.code).toBe(
        mode === "malformed"
          ? "invalid_result_envelope"
          : mode === "remote"
            ? "E_REMOTE_EXCEPTION"
            : "E_SERVICE_UNAVAILABLE",
      );
      if (mode !== "missing-workspace")
        expect(JSON.parse(result.stderr).error.connectionFailure).toMatchObject({
          action: "status",
          stage:
            mode === "missing-status"
              ? "status_acquire"
              : mode === "malformed"
                ? "status_decode"
                : "status_call",
          kind: mode === "malformed" ? "protocol" : "nexus",
          causeCode:
            mode === "malformed"
              ? "invalid_result_envelope"
              : mode === "remote"
                ? "E_REMOTE_EXCEPTION"
                : "E_SERVICE_UNAVAILABLE",
        });
      expect(calls).toBe(0);
    },
  );

  test.each(["success", "error", "status-error"] as const)(
    "R3 actual broker disconnect failure after %s preserves effect and first error",
    async (mode) => {
      const directory = await tempDir();
      const socket = path.join(directory, "cleanup.sock");
      const file = path.join(directory, "cleanup.png");
      await writeFile(file, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
      let calls = 0;
      activeServers.push(
        await startProvider(
          socket,
          {
            async uploadAsset() {
              calls++;
              return mode === "success"
                ? Result.ok({ asset: "asset-ref", filename: "cleanup.png" })
                : Result.err({
                    code: "asset_upload_unknown",
                    effect: {
                      outcome: "confirmed",
                      filename: "cleanup.png",
                      thumbnailUrl: "https://mmbiz.qpic.cn/test/300",
                    },
                    cause: { at: "bg.preflight", kind: "nexus", code: "E_CONN_CLOSED" },
                  });
            },
          },
          {
            async getStatus() {
              if (mode === "status-error") throw new Error("private status failure");
              return Result.ok({
                connected: true,
                brokerVersion: protocolVersion,
                extensionVersion: protocolVersion,
                ledgerId: fixtureLedgerId,
                keyLedgerId: fixtureLedgerId,
              });
            },
          },
        ),
      );
      const client = new Nexus().configure(
        usingNodeIpcClient({
          appId: "cleanup-fixture",
          configure: false,
          resolveAddress: () => ({ kind: "path", path: socket }),
        }),
      );
      await client.ready();
      const acquired = await client.safeConnect({
        target: { context: "node-ipc-daemon", appId: "mpctl", instance: "default" },
      });
      if (Result.isError(acquired)) throw acquired.error;
      const prototype = Object.getPrototypeOf(acquired.value);
      const original = prototype.disconnect;
      const disconnect = spyOn(prototype, "disconnect").mockImplementation(
        function (this: import("@nexus-js/core").Connection) {
          original.call(this);
          throw new Error("private disconnect failure");
        },
      );
      const previous = process.env.MPCTL_BROKER_SOCKET;
      process.env.MPCTL_BROKER_SOCKET = socket;
      try {
        const result = await assetCommand("upload", "ref", { file });
        expect(Result.isError(result)).toBe(true);
        if (Result.isError(result))
          expect(result.error).toMatchObject({
            code:
              mode === "success"
                ? "cleanup_failed"
                : mode === "status-error"
                  ? "E_REMOTE_EXCEPTION"
                  : "asset_upload_unknown",
            details:
              mode === "status-error"
                ? { cleanupFailed: true }
                : {
                    snapshot: { effect: { outcome: "confirmed" } },
                    issue: {
                      failure: { cause: { at: "cli.cleanup", code: "broker_disconnect_failed" } },
                    },
                  },
          });
        expect(calls).toBe(mode === "status-error" ? 0 : 1);
      } finally {
        disconnect.mockRestore();
        acquired.value.disconnect();
        if (previous === undefined) delete process.env.MPCTL_BROKER_SOCKET;
        else process.env.MPCTL_BROKER_SOCKET = previous;
      }
    },
  );
  test("asset upload rejects invalid local image bytes without starting a broker", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "must-not-connect.sock");
    const file = path.join(directory, "not-image.png");
    await writeFile(file, "not an image");
    const result = await runCli(["asset", "upload", "article-ref", "--file", file], socket);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_asset");
    expect(result.stderr).not.toContain("broker_start_failed");
  });

  test("article cover reads and sets only with complete flags; save returns native-confirmed unverified snapshot", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "article-actions.sock");
    const calls: string[] = [];
    const server = await startProvider(socket, {
      async readArticleCover() {
        calls.push("read-cover");
        return Result.ok({ coverHash: "a".repeat(64) });
      },
      async setArticleCover(article, asset, hash) {
        calls.push(`set:${article}:${asset}:${hash}`);
        return Result.ok({ coverHash: "b".repeat(64) });
      },
      async saveArticle(article, body, fields, cover) {
        calls.push(`save:${article}`);
        expect([body, fields, cover]).toEqual(["a", "b", "c"].map((x) => x.repeat(64)));
        return Result.ok({
          article: "fresh-ref",
          title: "Persisted title",
          bodyHash: "d".repeat(64),
        });
      },
    });
    activeServers.push(server);
    const read = await runCli(["article", "cover", "old-ref"], socket);
    expect(JSON.parse(read.stdout)).toEqual({ coverHash: "a".repeat(64) });
    const incomplete = await runCli(
      ["article", "cover", "old-ref", "--asset", "asset-ref"],
      socket,
    );
    expect(incomplete.exitCode).toBe(1);
    expect(calls).toEqual(["read-cover"]);
    const set = await runCli(
      ["article", "cover", "old-ref", "--asset", "asset-ref", "--expected-hash", "a".repeat(64)],
      socket,
    );
    expect(JSON.parse(set.stdout)).toMatchObject({
      snapshot: {
        operation: "cover",
        state: "settled",
        effect: { cover: true, outcome: "confirmed", coverHash: "b".repeat(64) },
      },
    });
    const stateFile = path.join(directory, "state.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        article: "old-ref",
        title: "Title",
        author: "",
        summary: "",
        bodyHash: "a".repeat(64),
        fieldsHash: "b".repeat(64),
        coverHash: "c".repeat(64),
      }),
    );
    const save = await runCli(["article", "save", "old-ref", "--expect", stateFile], socket);
    expect(JSON.parse(save.stdout)).toMatchObject({
      snapshot: {
        operation: "save",
        state: "settled",
        effect: {
          outcome: "confirmed",
          persistence: "unverified",
        },
      },
    });
    expect(JSON.parse(save.stdout).snapshot.result.value).toEqual({});
    expect(save.exitCode).toBe(0);
    expect(set.stderr).toMatch(/^operation op:/);
    expect(save.stderr).toMatch(/^operation op:/);
    const beforeInvalid = [...calls];
    for (const flags of [
      ["--from-body", "0"],
      ["--from-body", "1.5"],
      ["--from-body", "1"],
      ["--from-body", "1", "--asset", "asset-ref", "--expected-body-hash", "a".repeat(64)],
      ["--expected-body-hash", "a".repeat(64)],
    ]) {
      expect(
        (
          await runCli(
            ["article", "cover", "old-ref", ...flags, "--expected-hash", "a".repeat(64)],
            socket,
          )
        ).exitCode,
      ).toBe(1);
    }
    expect(calls).toEqual(beforeInvalid);
    const bodyCover = await runCli(
      [
        "article",
        "cover",
        "old-ref",
        "--from-body",
        "1",
        "--expected-body-hash",
        "a".repeat(64),
        "--expected-hash",
        "a".repeat(64),
      ],
      socket,
    );
    expect(bodyCover.exitCode).toBe(0);
    expect(JSON.parse(bodyCover.stdout).snapshot.operation).toBe("cover");
    expect(calls.at(-1)).toBe(`set:old-ref:body:1:${"a".repeat(64)}`);
  });

  test("cover/save mutation IPC preserves known facts and maps lost replies to mutation unknown", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "article-mutation-errors.sock");
    let mode: "facts" | "lost" | "malformed" = "facts";
    const provider = await startProvider(socket, {
      async setArticleCover() {
        if (mode === "lost") throw new Error("fixture lost response after dispatch");
        if (mode === "malformed") return Result.ok({ coverHash: "not-a-hash" } as never);
        return Result.err({
          code: "cover_update_unknown",
          effect: { cover: true, outcome: "unknown", baselineHash: "a".repeat(64) },
          cause: { at: "content.cover_confirm", kind: "domain", code: "confirmation_timeout" },
          cleanup: { at: "content.cover_cleanup", kind: "domain", code: "cleanup_failed" },
        });
      },
      async saveArticle() {
        if (mode === "lost") throw new Error("fixture lost response after dispatch");
        if (mode === "malformed")
          return Result.err({
            code: "save_unknown",
            effect: { outcome: "confirmed", persistence: "bogus" },
          } as never);
        return Result.err({
          code: "save_unknown",
          effect: { outcome: "confirmed", persistence: "unverified" },
          cause: { at: "bg.fresh_read", kind: "nexus", code: "E_CONN_CLOSED" },
          cleanup: { at: "content.history_cleanup", kind: "domain", code: "cleanup_failed" },
        });
      },
    });
    activeServers.push(provider);
    const coverArgs = [
      "article",
      "cover",
      "article-ref",
      "--asset",
      "asset-ref",
      "--expected-hash",
      "a".repeat(64),
    ];
    const stateFile = path.join(directory, "state.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        article: "article-ref",
        title: "Title",
        author: "",
        summary: "",
        bodyHash: "a".repeat(64),
        fieldsHash: "b".repeat(64),
        coverHash: "c".repeat(64),
      }),
    );
    const saveArgs = ["article", "save", "article-ref", "--expect", stateFile];
    const knownSave = await runCli(saveArgs, socket);
    expect(knownSave.exitCode).toBe(1);
    expect(JSON.parse(knownSave.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
      code: "save_unknown",
      snapshot: {
        effect: { outcome: "confirmed", persistence: "unverified" },
        result: {
          status: "error",
          error: {
            code: "save_unknown",
            cause: { at: "bg.fresh_read", kind: "nexus", code: "E_CONN_CLOSED" },
            cleanup: { at: "content.history_cleanup", kind: "domain", code: "cleanup_failed" },
          },
        },
      },
      instruction: expect.stringContaining("不要换键重做"),
    });
    const knownCover = await runCli(coverArgs, socket);
    expect(knownCover.exitCode).toBe(1);
    expect(JSON.parse(knownCover.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
      code: "cover_update_unknown",
      snapshot: {
        effect: { cover: true, outcome: "unknown", baselineHash: "a".repeat(64) },
        result: {
          status: "error",
          error: {
            cleanup: { at: "content.cover_cleanup", kind: "domain", code: "cleanup_failed" },
          },
        },
      },
      instruction: expect.stringContaining("不要换键重做"),
    });

    mode = "lost";
    const lostSave = await runCli(saveArgs, socket);
    expect(JSON.parse(lostSave.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
      code: "operation_unresolved",
      issue: { failure: { cause: { at: "cli.call", kind: "nexus", code: "E_REMOTE_EXCEPTION" } } },
      instruction: expect.stringContaining("不要换键重做"),
    });
    const lostCover = await runCli(coverArgs, socket);
    expect(JSON.parse(lostCover.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
      code: "operation_unresolved",
      issue: { failure: { cause: { at: "cli.call", kind: "nexus", code: "E_REMOTE_EXCEPTION" } } },
      instruction: expect.stringContaining("不要换键重做"),
    });

    mode = "malformed";
    expect(
      JSON.parse((await runCli(saveArgs, socket)).stderr.trim().split("\n").at(-1)!).error.code,
    ).toBe("invalid_result_envelope");
    expect(
      JSON.parse((await runCli(coverArgs, socket)).stderr.trim().split("\n").at(-1)!).error.code,
    ).toBe("invalid_result_envelope");
  });

  test("asset upload crosses CLI Node IPC as Blob bytes plus independent filename and MIME", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "asset-upload.sock");
    const file = path.join(directory, "original-name.png");
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await writeFile(file, bytes);
    const server = await startProvider(socket, {
      async uploadAsset(article, payload) {
        expect(article).toBe("article-ref");
        expect(payload.filename).toBe("original-name.png");
        expect(payload.mimeType).toBe("image/png");
        expect(new Uint8Array(await payload.blob.arrayBuffer())).toEqual(bytes);
        return Result.ok({
          asset: "ephemeral:fixture",
          filename: payload.filename,
          thumbnailUrl: "https://mmbiz.qpic.cn/thumb/300",
        });
      },
    });
    activeServers.push(server);
    const result = await runCli(["asset", "upload", "article-ref", "--file", file], socket);
    expect(result.exitCode).toBe(0);
    const reply = JSON.parse(result.stdout);
    expect(result.stderr).toBe(`operation ${reply.snapshot.operationId}\n`);
    expect(reply).toMatchObject({
      snapshot: {
        operation: "upload",
        state: "settled",
        effect: {
          outcome: "confirmed",
          filename: "original-name.png",
          thumbnailUrl: "https://mmbiz.qpic.cn/thumb/300",
        },
      },
    });
    expect(reply.snapshot).not.toHaveProperty("asset");
    expect(result.stdout).not.toContain(file);
  });

  test("asset list reports only the visible-page scope over CLI IPC", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "asset-list.sock");
    const server = await startProvider(socket, {
      async listAssets(article) {
        expect(article).toBe("article-ref");
        return Result.ok({
          scope: "visible-page",
          cards: [
            {
              asset: "ephemeral:visible-card",
              filename: "visible.png",
              thumbnailUrl: "https://mmbiz.qpic.cn/thumb/300",
            },
          ],
        });
      },
    });
    activeServers.push(server);
    const result = await runCli(["asset", "list", "article-ref"], socket);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      scope: "visible-page",
      cards: [
        {
          asset: "ephemeral:visible-card",
          filename: "visible.png",
          thumbnailUrl: "https://mmbiz.qpic.cn/thumb/300",
        },
      ],
    });
  });

  test("asset upload reports an uncertain dispatched outcome and never retries", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "asset-unknown.sock");
    const file = path.join(directory, "uncertain.png");
    await writeFile(file, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    let calls = 0;
    const server = await startProvider(socket, {
      async uploadAsset() {
        calls++;
        return Result.err({
          code: "asset_upload_unknown",
          cause: { at: "content.upload_confirm", kind: "domain", code: "snapshot_incomplete" },
          cleanup: { at: "content.library_cleanup", kind: "domain", code: "cleanup_failed" },
        });
      },
    });
    activeServers.push(server);
    const result = await runCli(["asset", "upload", "article-ref", "--file", file], socket);
    expect(result.exitCode).toBe(1);
    expect(calls).toBe(1);
    expect(JSON.parse(result.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
      code: "asset_upload_unknown",
      snapshot: {
        effect: { outcome: "unknown" },
        result: {
          error: {
            cause: { at: "content.upload_confirm", kind: "domain", code: "snapshot_incomplete" },
            cleanup: { at: "content.library_cleanup", kind: "domain", code: "cleanup_failed" },
          },
        },
      },
    });
  });

  test("validates title and malformed field JSON before starting or connecting to a broker", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "must-not-connect.sock");
    const fields = path.join(directory, "fields.json");
    await writeFile(fields, JSON.stringify({ title: "x".repeat(65) }));
    const result = await runCli(
      ["article", "update", "article-ref", "--fields", fields, "--expected-hash", "a".repeat(64)],
      socket,
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("invalid_fields");
    expect(result.stderr).not.toContain("broker_start_failed");
  });

  test("upload preserves Nexus remote exceptions separately from malformed business envelopes", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "upload-errors.sock");
    const file = path.join(directory, "input.png");
    await writeFile(file, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    let mode: "throw" | "malformed" = "throw";
    let calls = 0;
    const provider = await startProvider(socket, {
      async uploadAsset() {
        calls++;
        if (mode === "throw") throw new Error("private-url-secret-must-not-escape");
        return Result.ok({ asset: "test", filename: "input.png", unexpected: true } as never);
      },
    });
    activeServers.push(provider);
    const thrown = await runCli(["asset", "upload", "ref", "--file", file], socket);
    expect(JSON.parse(thrown.stderr.trim().split("\n").at(-1)!).error.issue.failure.cause).toEqual({
      at: "cli.call",
      kind: "nexus",
      code: "E_REMOTE_EXCEPTION",
    });
    expect(thrown.stderr).not.toContain("private-url-secret");
    expect(calls).toBe(1);
    mode = "malformed";
    const malformed = await runCli(["asset", "upload", "ref", "--file", file], socket);
    expect(JSON.parse(malformed.stderr.trim().split("\n").at(-1)!).error.issue.failure.code).toBe(
      "invalid_result_envelope",
    );
    expect(calls).toBe(2);
  });

  test("upload's local validation identifies file_read and never reaches a provider", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "upload-no-call.sock");
    let calls = 0;
    const provider = await startProvider(socket, {
      async uploadAsset() {
        calls++;
        throw new Error("must not execute");
      },
    });
    activeServers.push(provider);
    const failed = await runCli(
      ["asset", "upload", "ref", "--file", path.join(directory, "missing.png")],
      socket,
    );
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.stderr).error.failure.cause).toEqual({
      at: "cli.file_read",
      kind: "runtime",
      code: "file_error",
    });
    expect(calls).toBe(0);
  });

  test("field update returns only fieldsHash and preserves partial-result facts", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "update.sock");
    const fields = path.join(directory, "fields.json");
    await writeFile(fields, JSON.stringify({ summary: "更新" }));
    const server = await startProvider(socket, {
      async updateArticleFields(article, input, hash) {
        expect([article, input, hash]).toEqual([
          "article-ref",
          { summary: "更新" },
          "a".repeat(64),
        ]);
        return Result.ok({ fieldsHash: "b".repeat(64) });
      },
    });
    activeServers.push(server);
    const result = await runCli(
      ["article", "update", "article-ref", "--fields", fields, "--expected-hash", "a".repeat(64)],
      socket,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      snapshot: {
        operation: "fields",
        state: "settled",
        effect: {
          fieldsHash: "b".repeat(64),
          requested: ["summary"],
          attempted: ["summary"],
          confirmed: ["summary"],
          unknown: [],
        },
      },
    });
    expect(result.stderr).toBe(`operation ${JSON.parse(result.stdout).snapshot.operationId}\n`);
  });
  test("article check crosses real CLI IPC and returns exactly bounded issue arrays", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "check.sock");
    const issues: import("@mpctl/contracts").ArticleCheckResult = {
      errors: ["title_empty"],
      warnings: ["cover_unchecked"],
    };
    const server = await startProvider(socket, {
      async checkArticle(article) {
        expect(article).toBe("article-ref");
        return Result.ok(issues);
      },
    });
    activeServers.push(server);
    const checked = await runCli(["article", "check", "article-ref"], socket);
    expect(checked).toEqual({ exitCode: 0, stdout: `${JSON.stringify(issues)}\n`, stderr: "" });
    expect(Object.keys(JSON.parse(checked.stdout))).toEqual(["errors", "warnings"]);
  });
  test("unknown check errors are not retried", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "check-error.sock");
    let calls = 0;
    const server = await startProvider(socket, {
      async checkArticle() {
        calls++;
        return Result.err({ code: "target_unavailable" });
      },
    });
    activeServers.push(server);
    const checked = await runCli(["article", "check", "article-ref"], socket);
    expect(checked.exitCode).toBe(1);
    expect(JSON.parse(checked.stderr).error).toEqual({ code: "target_unavailable" });
    expect(calls).toBe(1);
  });
  test("field update unknown errors preserve only unique bounded field names and do not retry", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "update-unknown.sock");
    const fields = path.join(directory, "fields-unknown.json");
    await writeFile(fields, JSON.stringify({ author: "New" }));
    let calls = 0;
    const server = await startProvider(socket, {
      async updateArticleFields() {
        calls++;
        return Result.err({
          code: "field_update_unknown",
          effect: {
            outcome: "unknown",
            requested: ["author"],
            attempted: ["author"],
            confirmed: [],
            unknown: ["author"],
          },
        });
      },
    });
    activeServers.push(server);
    const result = await runCli(
      ["article", "update", "article-ref", "--fields", fields, "--expected-hash", "a".repeat(64)],
      socket,
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr.split("\n").slice(1).join("\n")).error).toMatchObject({
      code: "field_update_unknown",
      snapshot: { operation: "fields", effect: { confirmed: [], unknown: ["author"] } },
    });
    expect(calls).toBe(1);
  });
  test("inspect returns exactly the fields-only snapshot through broker IPC", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "inspect.sock");
    const fields = { title: " 标题 ", author: "作者", summary: "", fieldsHash: "a".repeat(64) };
    const server = await startProvider(socket, {
      async inspectArticle(article) {
        expect(article).toBe("article-ref");
        return Result.ok(fields);
      },
    });
    activeServers.push(server);
    const result = await runCli(["article", "inspect", "article-ref"], socket);
    expect(result).toEqual({ exitCode: 0, stdout: `${JSON.stringify(fields)}\n`, stderr: "" });
    expect(Object.keys(JSON.parse(result.stdout))).toEqual([
      "title",
      "author",
      "summary",
      "fieldsHash",
    ]);
  });
  test("inspect preserves failure codes and only suggests a new reference for an unavailable target", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "inspect-failures.sock");
    const server = await startProvider(socket, {
      async inspectArticle(article) {
        if (article === "locked-out") return Result.err({ code: "not_logged_in" });
        if (article === "broken-page") return Result.err({ code: "page_failed" });
        return Result.err({ code: "target_unavailable", stage: "target_not_ready" });
      },
    });
    activeServers.push(server);

    for (const [article, code] of [
      ["locked-out", "not_logged_in"],
      ["broken-page", "page_failed"],
      ["stale-ref", "target_unavailable"],
    ] as const) {
      const result = await runCli(["article", "inspect", article], socket);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      const error = JSON.parse(result.stderr).error;
      expect(error.code).toBe(code);
      if (code === "target_unavailable") {
        expect(error.instruction).toBe(
          "用 article current 获取新引用，或 list → open 指定已有稿。",
        );
        expect(error.stage).toBe("target_not_ready");
      } else {
        expect(error.stage).toBeUndefined();
        expect(error.instruction).toBe(
          code === "not_logged_in" ? "在浏览器中登录公众号." : undefined,
        );
      }
      expect(
        Object.keys(error).every((key) => ["code", "instruction", "stage"].includes(key)),
      ).toBe(true);
    }
  });
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
    for (const args of [
      ["article", "open", "候选 A"],
      ["article", "new"],
    ]) {
      const navigation = await runCli(args, socket);
      expect(navigation.exitCode).toBe(0);
      expect(JSON.parse(navigation.stdout).snapshot.effect).toMatchObject({
        navigation: true,
        outcome: "confirmed",
        bodyHash,
      });
      expect(JSON.parse(navigation.stdout).snapshot.result.value).toEqual({});
    }

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
    expect(JSON.parse(pushedEmpty.stdout)).toMatchObject({
      snapshot: {
        state: "settled",
        effect: { outcome: "confirmed", bodyHash },
        result: { status: "ok" },
      },
    });
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
    expect(JSON.parse(created.stdout).snapshot).toMatchObject({
      operation: "new",
      state: "settled",
      effect: { bodyHash: "0".repeat(64) },
      result: { status: "ok", value: {} },
    });
    expect(created.stderr).toBe(`operation ${JSON.parse(created.stdout).snapshot.operationId}\n`);
    const opened = await runCli(["article", "open", "candidate-1"], socket);
    expect(opened.exitCode).toBe(0);
    expect(JSON.parse(opened.stdout).snapshot).toMatchObject({
      operation: "open",
      state: "settled",
      effect: { bodyHash: "0".repeat(64) },
      result: { status: "ok", value: {} },
    });
    expect(opened.stderr).toBe(`operation ${JSON.parse(opened.stdout).snapshot.operationId}\n`);
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
    expect(JSON.parse(result.stderr.trim().split("\n").at(-1)!).error.code).toBe(
      "target_unavailable",
    );
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
      ["article", "current", "--new", "--candidate", "A"],
      ["article", "cover", "ref", "--operation", createOperationId(fixtureLedgerId)],
      ["article", "save", "ref"],
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
      ["operation", "status", "--help"],
      ["article", "check", "--help"],
      ["article", "save", "--help"],
      ["asset", "--help"],
      ["asset", "list", "--help"],
      ["asset", "upload", "--help"],
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

  test("article help follows selection/edit/save workflow and discloses version safety", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "help-must-not-start.sock");
    const root = await runCli(["--help"], socket);
    const articleHelp = await runCli(["article", "--help"], socket);
    const inspectHelp = await runCli(["article", "inspect", "--help"], socket);
    const updateHelp = await runCli(["article", "update", "--help"], socket);
    const checkHelp = await runCli(["article", "check", "--help"], socket);
    const saveHelp = await runCli(["article", "save", "--help"], socket);

    expect(root.exitCode).toBe(0);
    expect(root.stderr).toBe("");
    expect(articleHelp.exitCode).toBe(0);
    expect(articleHelp.stdout).toContain("选择文章：");
    expect(articleHelp.stdout).toContain("正文文件：");
    expect(articleHelp.stdout).toContain("文章字段：");
    expect(articleHelp.stdout.indexOf("选择文章：")).toBeLessThan(
      articleHelp.stdout.indexOf("正文文件："),
    );
    expect(articleHelp.stdout.indexOf("正文文件：")).toBeLessThan(
      articleHelp.stdout.indexOf("文章字段："),
    );
    expect(articleHelp.stdout.indexOf("文章字段：")).toBeLessThan(
      articleHelp.stdout.indexOf("检查与保存："),
    );
    const fieldCommands = articleHelp.stdout.split("文章字段：")[1]!.split("图片封面：")[0]!;
    const selectionCommands = articleHelp.stdout.split("选择文章：")[1]!.split("正文文件：")[0]!;
    expect(fieldCommands).toContain("inspect [options] <article>");
    expect(fieldCommands).toContain("update [options] <article>");
    expect(selectionCommands).not.toMatch(/^\s+inspect\b/m);
    expect(selectionCommands).not.toMatch(/^\s+update\b/m);
    expect(selectionCommands).toContain("list");
    expect(selectionCommands).toContain("open");
    expect(selectionCommands).toContain("new");
    expect(selectionCommands).toContain("current");
    for (const result of [articleHelp, inspectHelp, updateHelp, checkHelp, saveHelp]) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(inspectHelp.stdout).toContain("Usage: mpctl article inspect [options] <article>");
    expect(inspectHelp.stdout).toContain("--all");
    expect(inspectHelp.stdout).toContain("不是原子快照或云端证明");
    expect(updateHelp.stdout).toContain("--fields <json-file>");
    expect(updateHelp.stdout).toContain("--expected-hash <fieldsHash>");
    expect(checkHelp.stdout).toContain("不是保存前置步骤");
    expect(saveHelp.stdout).toContain("--expect <json-file>");
    expect(saveHelp.stdout).not.toContain("--expected-fields-hash");
    expect(saveHelp.stdout).toContain("persistence:unverified");
    expect(existsSync(socket)).toBe(false);
  });

  test("asset help discloses visible-page handles and upload uncertainty without starting a broker", async () => {
    const directory = await tempDir();
    const socket = path.join(directory, "asset-help-no-broker.sock");
    const listed = await runCli(["asset", "list", "--help"], socket);
    const uploaded = await runCli(["asset", "upload", "--help"], socket);
    for (const result of [listed, uploaded]) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(listed.stdout).toContain("visible-page");
    expect(uploaded.stdout).toContain("--file <path>");
    expect(uploaded.stdout).toContain("首次确认成功返回 asset");
    expect(uploaded.stdout).toContain("历史重提只返回持久结果");
    expect(uploaded.stdout).toContain("缩略图不是正文原图");
    expect(existsSync(socket)).toBe(false);
  });

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
    expect(JSON.parse(failed.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
      code: "page_failed",
      snapshot: {
        effect: { pageCreated: true },
        result: { error: { cause: { at: "bg.navigation", code: "target_not_ready" } } },
      },
      instruction: expect.stringContaining("不要换键重做"),
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
            ledgerId: fixtureLedgerId,
            keyLedgerId: fixtureLedgerId,
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
      expectedVersion: protocolVersion,
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
    const error = JSON.parse(result.stderr.trim().split("\n").at(-1)!).error;
    expect(error.code).toBe("page_failed");
    expect(error.snapshot.result.error).toEqual({
      code: "page_failed",
      cause: { at: "bg.navigation", kind: "domain", code: "native_target_missing" },
    });
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
    const error = JSON.parse(result.stderr.trim().split("\n").at(-1)!).error;
    expect(error.code).toBe("page_failed");
    expect(error.snapshot.result.error).toEqual({
      code: "page_failed",
      cause: { at: "bg.navigation", kind: "domain", code: "source_ambiguous" },
    });
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
    const error = JSON.parse(result.stderr.trim().split("\n").at(-1)!).error;
    expect(error.code).toBe("target_unavailable");
    expect(error.snapshot.result.error).toEqual({
      code: "target_unavailable",
      cause: { at: "bg.navigation", kind: "domain", code: "target_not_ready" },
    });
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
    expect(result.stderr).toBe(`operation ${JSON.parse(result.stdout).snapshot.operationId}\n`);
    expect(JSON.parse(result.stdout).snapshot).toMatchObject({
      operation: "new",
      effect: { bodyHash: "0".repeat(64) },
      result: { status: "ok", value: {} },
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
    expect(JSON.parse(result.stdout).snapshot).toMatchObject({
      operation: "new",
      effect: { bodyHash: "0".repeat(64) },
      result: { status: "ok", value: {} },
    });
    expect(result.stderr).toBe(`operation ${JSON.parse(result.stdout).snapshot.operationId}\n`);
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
    expect(JSON.parse(result.stderr.trim().split("\n").at(-1)!).error).toMatchObject({
      code: "operation_unresolved",
      issue: { failure: { cause: { at: "cli.call", kind: "nexus", code: "E_REMOTE_EXCEPTION" } } },
    });
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
    expect(JSON.parse(result.stderr.trim().split("\n").at(-1)!).error.code).toBe(
      "target_unavailable",
    );
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
        getStatus: async () =>
          Result.ok({
            connected: existsSync(marker),
            ...(existsSync(marker)
              ? { ledgerId: fixtureLedgerId, keyLedgerId: fixtureLedgerId }
              : {}),
          }),
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
    inspectArticle(
      article: string,
      options?: { all?: true },
    ): Promise<
      import("better-result").Result<
        import("@mpctl/contracts").ArticleInspection,
        import("@mpctl/contracts").WorkspaceError
      >
    >;
    updateArticleFields(
      article: string,
      fields: { title?: string; author?: string; summary?: string },
      expectedHash: string,
    ): Promise<
      import("better-result").Result<
        { fieldsHash: string },
        import("@mpctl/contracts").Failure & { effect?: import("@mpctl/contracts").FieldsEffect }
      >
    >;
    checkArticle(
      article: string,
    ): Promise<
      import("better-result").Result<
        import("@mpctl/contracts").ArticleCheckResult,
        import("@mpctl/contracts").WorkspaceError
      >
    >;
    listAssets(
      article: string,
    ): Promise<
      import("better-result").Result<
        import("@mpctl/contracts").AssetList,
        import("@mpctl/contracts").WorkspaceError
      >
    >;
    uploadAsset(
      article: string,
      payload: {
        blob: Blob;
        filename: string;
        mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      },
    ): Promise<
      import("better-result").Result<
        import("@mpctl/contracts").AssetCard,
        import("@mpctl/contracts").Failure & { effect?: import("@mpctl/contracts").UploadEffect }
      >
    >;
    readArticleCover(
      article: string,
    ): Promise<
      import("better-result").Result<
        { coverHash: string },
        import("@mpctl/contracts").WorkspaceError
      >
    >;
    setArticleCover(
      article: string,
      asset: string,
      expectedHash: string,
    ): Promise<
      import("better-result").Result<
        { coverHash: string },
        import("@mpctl/contracts").Failure & { effect?: import("@mpctl/contracts").CoverEffect }
      >
    >;
    saveArticle(
      article: string,
      bodyHash: string,
      fieldsHash: string,
      coverHash: string,
    ): Promise<
      import("better-result").Result<
        import("@mpctl/contracts").ArticleResult,
        import("@mpctl/contracts").Failure & { effect?: import("@mpctl/contracts").SaveEffect }
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
      return Result.ok({
        connected: true,
        brokerVersion: protocolVersion,
        extensionVersion: protocolVersion,
        ledgerId: fixtureLedgerId,
        keyLedgerId: fixtureLedgerId,
      });
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
            return encodeResult(
              connectionStatusResultCodec,
              Result.ok({
                connected,
                brokerVersion: protocolVersion,
                extensionVersion: protocolVersion,
                ...(connected ? { ledgerId: fixtureLedgerId, keyLedgerId: fixtureLedgerId } : {}),
              }),
            );
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

async function navigationResult(
  operationId: string,
  operation: "new" | "open",
  result: Awaited<
    ReturnType<NonNullable<NonNullable<Parameters<typeof startProvider>[1]>["newArticle"]>>
  >,
) {
  return encodeResult(
    operationResultCodec,
    Result.ok({
      snapshot: {
        operationId,
        operation,
        state: "settled" as const,
        effect: {
          navigation: true as const,
          outcome: result.isOk()
            ? ("confirmed" as const)
            : result.error.pageCreated
              ? ("unknown" as const)
              : ("not_dispatched" as const),
          pageCreated: result.isOk() || !!(result.isErr() && result.error.pageCreated),
          auxiliaryCreated: [],
          targetBound: result.isOk(),
          ...(result.isOk() ? { bodyHash: result.value.bodyHash } : {}),
        },
        result: result.isOk()
          ? { status: "ok" as const, value: {} }
          : {
              status: "error" as const,
              error: {
                code: result.error.code as import("@mpctl/contracts").Failure["code"],
                ...(result.error.stage
                  ? {
                      cause: {
                        at: "bg.navigation" as const,
                        kind: "domain" as const,
                        code: result.error.stage,
                      },
                    }
                  : {}),
              },
            },
      },
    }),
  );
}
function encodeWorkspaceProvider(
  workspace: NonNullable<Parameters<typeof startProvider>[1]>,
): WorkspaceService {
  return {
    cleanupWorkspace: async () =>
      encodeResult(cleanupWorkspaceResultCodec, await workspace.cleanupWorkspace!()),
    listArticles: async () =>
      encodeResult(listArticlesResultCodec, await workspace.listArticles!()),
    openArticle: async (input) =>
      navigationResult(input.operationId, "open", await workspace.openArticle!(input.candidate)),
    newArticle: async (input) =>
      navigationResult(input.operationId, "new", await workspace.newArticle!()),
    currentArticle: async () => encodeResult(articleResultCodec, await workspace.currentArticle!()),
    readBody: async (article) =>
      encodeResult(workspaceResultCodec, await workspace.readBody!(article)),
    writeBody: async (input) => {
      const result = await workspace.writeBody!(input.article, input.html, input.expectedHash);
      const snapshot = result.isOk()
        ? {
            operationId: input.operationId,
            operation: "body" as const,
            state: "settled" as const,
            effect: { outcome: "confirmed" as const, bodyHash: result.value.bodyHash },
            result: { status: "ok" as const, value: {} },
          }
        : {
            operationId: input.operationId,
            operation: "body" as const,
            state: "settled" as const,
            effect: { outcome: "not_dispatched" as const },
            result: {
              status: "error" as const,
              error: { code: result.error.code as import("@mpctl/contracts").Failure["code"] },
            },
          };
      return encodeResult(operationResultCodec, Result.ok({ snapshot }));
    },
    getOperation: async () => ({
      status: "error",
      error: { failure: { code: "operation_not_found" } },
    }),
    inspectArticle: async (article, options) =>
      encodeResult(
        options?.all ? articleStateResultCodec : articleFieldsResultCodec,
        await workspace.inspectArticle!(article, options),
      ),
    updateArticleFields: async (input) => {
      const result = await workspace.updateArticleFields!(
        input.article,
        input.fields,
        input.expectedHash,
      );
      const requested = (["title", "author", "summary"] as const).filter(
        (name) => input.fields[name] !== undefined,
      );
      const effect: import("@mpctl/contracts").FieldsEffect = result.isOk()
        ? {
            outcome: "confirmed",
            requested,
            attempted: requested,
            confirmed: requested,
            unknown: [],
            fieldsHash: result.value.fieldsHash,
          }
        : (result.error.effect ?? {
            outcome: "not_dispatched",
            requested,
            attempted: [],
            confirmed: [],
            unknown: [],
          });
      const snapshot = {
        operationId: input.operationId,
        operation: "fields" as const,
        state: "settled" as const,
        effect,
        result: result.isOk()
          ? { status: "ok" as const, value: {} }
          : {
              status: "error" as const,
              error: {
                code: result.error.code,
                ...(result.error.cause ? { cause: result.error.cause } : {}),
                ...(result.error.cleanup ? { cleanup: result.error.cleanup } : {}),
              },
            },
      };
      return encodeResult(operationResultCodec, Result.ok({ snapshot }));
    },
    checkArticle: async (article) =>
      encodeResult(articleCheckResultCodec, await workspace.checkArticle!(article)),
    listAssets: async (article) =>
      encodeResult(assetListResultCodec, await workspace.listAssets!(article)),
    uploadAsset: async (input) => {
      const result = await workspace.uploadAsset!(input.article, input);
      if (result.isOk() && "unexpected" in result.value)
        return { status: "ok", value: result.value } as never;
      const effect: import("@mpctl/contracts").UploadEffect = result.isOk()
        ? {
            outcome: "confirmed",
            filename: result.value.filename,
            thumbnailUrl: result.value.thumbnailUrl ?? "https://mmbiz.qpic.cn/test/300",
          }
        : (result.error.effect ?? { outcome: "unknown", filename: input.filename });
      const failure = result.isErr()
        ? (() => {
            const { effect: _effect, ...failure } = result.error;
            return failure;
          })()
        : undefined;
      return encodeResult(
        operationResultCodec,
        Result.ok({
          snapshot: {
            operationId: input.operationId,
            operation: "upload",
            state: "settled",
            effect,
            result: failure ? { status: "error", error: failure } : { status: "ok", value: {} },
          },
        }),
      );
    },
    readArticleCover: async (article) =>
      encodeResult(articleCoverResultCodec, await workspace.readArticleCover!(article)),
    setArticleCover: async (input) => {
      const outcome = await workspace.setArticleCover!(
        input.article,
        "asset" in input ? input.asset : `body:${input.bodyImage}`,
        input.expectedCoverHash,
      );
      const { effect: failureEffect, ...failure } = outcome.isErr() ? outcome.error : {};
      return encodeResult(
        operationResultCodec,
        Result.ok({
          snapshot: {
            operationId: input.operationId,
            operation: "cover",
            state: "settled",
            effect: outcome.isOk()
              ? { cover: true, outcome: "confirmed", coverHash: outcome.value.coverHash }
              : (failureEffect ?? { cover: true, outcome: "not_dispatched" }),
            result: outcome.isOk()
              ? { status: "ok", value: {} }
              : { status: "error", error: failure as import("@mpctl/contracts").Failure },
          },
        }),
      );
    },
    saveArticle: async (input) => {
      const outcome = await workspace.saveArticle!(
        input.article,
        input.expectedBodyHash,
        input.expectedFieldsHash,
        input.expectedCoverHash,
      );
      const { effect: failureEffect, ...failure } = outcome.isErr() ? outcome.error : {};
      return encodeResult(
        operationResultCodec,
        Result.ok({
          snapshot: {
            operationId: input.operationId,
            operation: "save",
            state: "settled",
            effect: outcome.isOk()
              ? {
                  outcome: "confirmed",
                  persistence: "unverified",
                }
              : (failureEffect ?? { outcome: "not_dispatched", persistence: "unverified" }),
            result: outcome.isOk()
              ? { status: "ok", value: {} }
              : { status: "error", error: failure as import("@mpctl/contracts").Failure },
          },
        }),
      );
    },
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
    env: {
      ...process.env,
      MPCTL_BROKER_CONFIG: isolatedConfigPath,
      XDG_RUNTIME_DIR: path.dirname(isolatedConfigPath),
      MPCTL_PAIRING_CREDENTIAL: "",
      MPCTL_BROKER_WS_PORT: "",
      MPCTL_EXTENSION_ID: "",
      ...extraEnvironment,
    },
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
