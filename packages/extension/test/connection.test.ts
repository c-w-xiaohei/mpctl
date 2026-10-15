import { describe, expect, test, spyOn } from "bun:test";
import { Result } from "better-result";

const ledgerId = crypto.randomUUID();
const initializedLedger = { ledger: Promise.resolve(Result.ok({ ledgerId })) };
import {
  connectResultCodec,
  connectionConfig,
  controlStatusResultCodec,
  disconnectResultCodec,
  reloadResultCodec,
  requestConnectResultCodec,
} from "@mpctl/contracts";
import { createBackgroundControl, createConnectionController } from "../src/connection";

describe("explicit plugin connection", () => {
  test("a background handoff consumes a late failure without leaking private error details", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = createBackgroundControl({
        controller: () => ({
          connect: async () => {
            throw new Error("private pairing credential");
          },
          disconnect: () => Result.ok({ connected: false as const }),
          status: () => Result.ok({ connected: false }),
        }),
        reload: async () => Result.ok(undefined),
      });
      expect(await requestConnectResultCodec.deserialize(await service.requestConnect())).toEqual(
        Result.ok(undefined),
      );
      expect(logged.mock.calls).toEqual([["mpctl background connect failed: unexpected_failure"]]);
    } finally {
      logged.mockRestore();
    }
  });
  test("acknowledges connection handoff while the background dial is still pending", async () => {
    let finish!: (value: Result<void, { code: "dial_failed" }>) => void;
    let calls = 0;
    let connected = false;
    const service = createBackgroundControl({
      controller: () => ({
        connect() {
          calls++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        disconnect: () => Result.ok({ connected: false as const }),
        status: () => Result.ok({ connected }),
      }),
      reload: async () => Result.ok(undefined),
    });
    const reply = await requestConnectResultCodec.deserialize(await service.requestConnect());
    expect(reply).toEqual(Result.ok(undefined));
    expect(calls).toBe(1);
    expect(await controlStatusResultCodec.deserialize(await service.getStatus())).toEqual(
      Result.ok({ connected: false }),
    );
    connected = true;
    finish(Result.ok(undefined));
    await Promise.resolve();
    expect(await controlStatusResultCodec.deserialize(await service.getStatus())).toEqual(
      Result.ok({ connected: true }),
    );
  });
  test("G1 ledger initialization must finish before a WS dial publishes metadata", async () => {
    let release!: (result: Result<{ ledgerId: string }, { code: string }>) => void;
    const ledger = new Promise<Result<{ ledgerId: string }, { code: string }>>((done) => {
      release = done;
    });
    let dials = 0;
    let published: string | undefined;
    const controller = createConnectionController({
      ledger,
      dial: async (_url, protocols, _workspace, _control, ledgerId) => {
        dials++;
        published = ledgerId;
        return Result.ok(new FakeSocket(protocols));
      },
    });
    const connecting = controller.connect("credential");
    expect(dials).toBe(0);
    const ledgerId = crypto.randomUUID();
    release(Result.ok({ ledgerId }));
    expect((await connecting).isOk()).toBe(true);
    expect({ dials, published }).toEqual({ dials: 1, published: ledgerId });
  });
  test("published controls encode expected connection failures and explicit status", async () => {
    const controller = createConnectionController({
      ...initializedLedger,
      dial: async () => {
        throw new Error("dial failed");
      },
    });
    const service = createBackgroundControl({
      controller: () => controller,
      reload: async () => Result.ok(undefined),
    });

    const failed = await connectResultCodec.deserialize(await service.connect());
    expect(failed).toEqual(Result.err({ code: "connect_failed" }));
    expect(await controlStatusResultCodec.deserialize(await service.getStatus())).toEqual(
      Result.ok({ connected: false }),
    );
    expect(await disconnectResultCodec.deserialize(await service.disconnect())).toEqual(
      Result.ok({ connected: false }),
    );
  });

  test("maps invalid pairing credentials to the published connect failure without dialing", async () => {
    let dialCount = 0;
    const controller = createConnectionController({
      ...initializedLedger,
      dial: async () => {
        dialCount++;
        return Result.ok(new FakeSocket([connectionConfig.selectedSubprotocol]));
      },
    });

    expect(await controller.connect("bad credential")).toEqual(
      Result.err({ code: "invalid_pairing_credential" }),
    );
    const service = createBackgroundControl({
      controller: () => controller,
      reload: async () => Result.ok(undefined),
    });
    expect(await connectResultCodec.deserialize(await service.connect())).toEqual(
      Result.err({ code: "connect_failed" }),
    );
    expect(dialCount).toBe(0);
  });

  test("published reload control returns a void wire envelope", async () => {
    const service = createBackgroundControl({
      controller: () => createConnectionController(initializedLedger),
      reload: async () => Result.ok(undefined),
    });
    expect(await reloadResultCodec.deserialize(await service.reload())).toEqual(
      Result.ok(undefined),
    );
  });

  test("published reload control converts a rejected adapter into the schema error", async () => {
    const service = createBackgroundControl({
      controller: () => createConnectionController(initializedLedger),
      reload: async () => {
        throw new Error("reload adapter rejected");
      },
    });
    expect(await reloadResultCodec.deserialize(await service.reload())).toEqual(
      Result.err({ code: "reload_failed" }),
    );
  });

  test("dials only on connect and does not recreate a client after disconnect", async () => {
    const sockets: FakeSocket[] = [];
    const controller = createConnectionController({
      ...initializedLedger,
      dial(_url, protocols) {
        const socket = new FakeSocket(protocols);
        sockets.push(socket);
        return Promise.resolve(Result.ok(socket));
      },
    });
    expect(sockets).toHaveLength(0);
    expect((await controller.connect("test-pairing-secret")).isOk()).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.protocols).toEqual([
      connectionConfig.selectedSubprotocol,
      "mpctl.pair.test-pairing-secret",
    ]);
    expect(controller.status()).toEqual(Result.ok({ connected: true }));
    expect(controller.disconnect()).toEqual(Result.ok({ connected: false }));
    expect(controller.status()).toEqual(Result.ok({ connected: false }));
    expect(sockets).toHaveLength(1);
  });

  test("closes a connection when the server did not select the fixed protocol", async () => {
    const socket = new FakeSocket(["mpctl.v1"]);
    socket.selectedProtocol = "wrong";
    const controller = createConnectionController({
      ...initializedLedger,
      dial: async () => Result.ok(socket),
    });
    expect(await controller.connect("test-pairing-secret")).toEqual(
      Result.err({ code: "protocol_mismatch" }),
    );
    expect(socket.closeCount).toBe(1);
    expect(controller.status()).toEqual(Result.ok({ connected: false }));
  });

  test("coalesces concurrent explicit connect requests into one dial", async () => {
    let resolveDial!: (socket: FakeSocket) => void;
    let dialPromise: Promise<ReturnType<typeof Result.ok<FakeSocket>>> | undefined;
    let calls = 0;
    const controller = createConnectionController({
      ...initializedLedger,
      dial(_url, _protocols) {
        calls++;
        dialPromise ??= new Promise((resolve) => {
          resolveDial = (socket) => resolve(Result.ok(socket));
        });
        return dialPromise;
      },
    });
    const first = controller.connect("test-pairing-secret");
    const second = controller.connect("test-pairing-secret");
    await Promise.resolve();
    expect(calls).toBe(1);
    resolveDial(new FakeSocket([connectionConfig.selectedSubprotocol]));
    expect((await Promise.all([first, second])).every((result) => result.isOk())).toBe(true);
    expect(controller.status()).toEqual(Result.ok({ connected: true }));
  });

  test("disconnect cancels a pending dial and closes its late socket once", async () => {
    let resolveDial!: (socket: FakeSocket) => void;
    const controller = createConnectionController({
      ...initializedLedger,
      dial: () => new Promise((resolve) => (resolveDial = (socket) => resolve(Result.ok(socket)))),
    });
    const pending = controller.connect("test-pairing-secret");
    await Promise.resolve();
    controller.disconnect();
    const socket = new FakeSocket([connectionConfig.selectedSubprotocol]);
    resolveDial(socket);

    expect(await pending).toEqual(Result.err({ code: "cancelled" }));
    expect(socket.closeCount).toBe(1);
    expect(controller.status()).toEqual(Result.ok({ connected: false }));
  });

  test("reports cleanup failure while preserving the cancellation cause", async () => {
    let resolveDial!: (socket: FakeSocket) => void;
    const controller = createConnectionController({
      ...initializedLedger,
      dial: () => new Promise((resolve) => (resolveDial = (socket) => resolve(Result.ok(socket)))),
    });
    const pending = controller.connect("test-pairing-secret");
    await Promise.resolve();
    controller.disconnect();
    const socket = new FakeSocket([connectionConfig.selectedSubprotocol]);
    socket.failClose = true;
    resolveDial(socket);

    expect(await pending).toEqual(Result.err({ code: "cancelled", cleanupFailed: true }));
    expect(socket.closeCount).toBe(1);
  });

  test("disconnect returns cleanup failure instead of a false success", async () => {
    const socket = new FakeSocket([connectionConfig.selectedSubprotocol]);
    const controller = createConnectionController({
      ...initializedLedger,
      dial: async () => Result.ok(socket),
    });
    await controller.connect("test-pairing-secret");
    socket.failClose = true;

    expect(controller.disconnect()).toEqual(
      Result.err({ code: "disconnect_failed", cleanupFailed: true }),
    );
  });

  test("captures a thrown socket close without changing the disconnect Result contract", async () => {
    const socket = new FakeSocket([connectionConfig.selectedSubprotocol]);
    const controller = createConnectionController({
      ...initializedLedger,
      dial: async () => Result.ok(socket),
    });
    await controller.connect("test-pairing-secret");
    socket.throwOnClose = true;

    expect(controller.disconnect()).toEqual(
      Result.err({ code: "disconnect_failed", cleanupFailed: true }),
    );
  });

  test("listener registration failure closes the candidate and never leaves stale connected state", async () => {
    const socket = new FakeSocket([connectionConfig.selectedSubprotocol]);
    socket.failListener = true;
    const controller = createConnectionController({
      ...initializedLedger,
      dial: async () => Result.ok(socket),
    });

    expect(await controller.connect("test-pairing-secret")).toEqual(
      Result.err({ code: "dial_failed" }),
    );
    expect(socket.closeCount).toBe(1);
    expect(controller.status()).toEqual(Result.ok({ connected: false }));
  });

  test("converts rejected settings adapters to Results without dialing", async () => {
    let dials = 0;
    const loadFailure = createConnectionController({
      ...initializedLedger,
      loadSettings: async () => {
        throw new Error("settings read failed");
      },
      dial: async () => {
        dials++;
        return Result.err({ code: "dial_failed" });
      },
    });
    expect(await loadFailure.connect()).toEqual(Result.err({ code: "settings_failed" }));

    const saveFailure = createConnectionController({
      ...initializedLedger,
      saveSettings: async () => {
        throw new Error("settings write failed");
      },
      dial: async () => {
        dials++;
        return Result.err({ code: "dial_failed" });
      },
    });
    expect(await saveFailure.connect("valid-credential")).toEqual(
      Result.err({ code: "settings_failed" }),
    );
    expect(dials).toBe(0);
  });

  test("a fresh explicit connect can finish while old settings load is unsettled", async () => {
    let resolveLoad!: (
      settings: ReturnType<typeof Result.ok<{ websocketUrl: string; pairingCredential: string }>>,
    ) => void;
    let dialCount = 0;
    let loadCount = 0;
    let signalSettings!: () => void;
    const settingsStarted = new Promise<void>((resolve) => {
      signalSettings = resolve;
    });
    const controller = createConnectionController({
      ...initializedLedger,
      loadSettings: () => {
        if (++loadCount === 1)
          return new Promise((resolve) => {
            resolveLoad = resolve;
            signalSettings();
          });
        return Promise.resolve(
          Result.ok({ websocketUrl: "ws://new.invalid", pairingCredential: "new" }),
        );
      },
      dial: async (_url, protocols) => {
        dialCount++;
        return Result.ok(new FakeSocket(protocols));
      },
    });
    const old = controller.connect();
    await settingsStarted;
    controller.disconnect();
    await controller.connect("new-explicit-credential");
    const newStatus = await controller.status();
    resolveLoad(Result.ok({ websocketUrl: "ws://old.invalid", pairingCredential: "old-secret" }));

    expect(await old).toEqual(Result.err({ code: "cancelled" }));
    expect(dialCount).toBe(1);
    expect(controller.status()).toEqual(newStatus);
    expect(newStatus).toEqual(Result.ok({ connected: true }));
  });

  test("disconnect during settings save prevents the old attempt from dialing", async () => {
    let resolveSave!: () => void;
    let dialCount = 0;
    let saveCount = 0;
    const controller = createConnectionController({
      ...initializedLedger,
      saveSettings: () => {
        if (++saveCount === 1)
          return new Promise((resolve) => (resolveSave = () => resolve(Result.ok(undefined))));
        return Promise.resolve(Result.ok(undefined));
      },
      dial: async (_url, protocols) => {
        dialCount++;
        return Result.ok(new FakeSocket(protocols));
      },
    });
    const old = controller.connect("old-secret");
    await Promise.resolve();
    controller.disconnect();
    await controller.connect("new-secret");
    resolveSave();

    expect(await old).toEqual(Result.err({ code: "cancelled" }));
    expect(dialCount).toBe(1);
    expect(controller.status()).toEqual(Result.ok({ connected: true }));
  });

  test("stale disconnect callbacks and cleanup cannot clear a newer connection", async () => {
    let resolveOld!: (socket: FakeSocket) => void;
    const sockets: FakeSocket[] = [];
    let dialCount = 0;
    const controller = createConnectionController({
      ...initializedLedger,
      dial: (_url, protocols) => {
        if (++dialCount === 1)
          return new Promise((resolve) => (resolveOld = (socket) => resolve(Result.ok(socket))));
        const socket = new FakeSocket(protocols);
        sockets.push(socket);
        return Promise.resolve(Result.ok(socket));
      },
    });
    const old = controller.connect("old-secret");
    await Promise.resolve();
    controller.disconnect();
    await controller.connect("new-secret");
    const current = sockets[0]!;
    const stale = new FakeSocket([connectionConfig.selectedSubprotocol]);
    resolveOld(stale);

    expect(await old).toEqual(Result.err({ code: "cancelled" }));
    expect(stale.closeCount).toBe(1);
    stale.fireDisconnect();
    expect(await controller.status()).toEqual(Result.ok({ connected: true }));
    current.fireDisconnect();
    expect(await controller.status()).toEqual(Result.ok({ connected: false }));
  });

  test("a stale failure is replaced by a generic cancellation error", async () => {
    let rejectDial!: (error: Error) => void;
    const controller = createConnectionController({
      ...initializedLedger,
      dial: () =>
        new Promise((resolve) => (rejectDial = () => resolve(Result.err({ code: "dial_failed" })))),
    });
    const pending = controller.connect("private-secret");
    await Promise.resolve();
    controller.disconnect();
    rejectDial(new Error("ws://private.invalid private-secret"));

    expect(await pending).toEqual(Result.err({ code: "cancelled" }));
  });

  test("a stale wrong-protocol socket is closed once without exposing its protocol", async () => {
    let resolveDial!: (socket: FakeSocket) => void;
    const controller = createConnectionController({
      ...initializedLedger,
      dial: () => new Promise((resolve) => (resolveDial = (socket) => resolve(Result.ok(socket)))),
    });
    const pending = controller.connect("private-secret");
    await Promise.resolve();
    controller.disconnect();
    const socket = new FakeSocket(["wrong-protocol"]);
    socket.selectedProtocol = "private-protocol-detail";
    resolveDial(socket);

    expect(await pending).toEqual(Result.err({ code: "cancelled" }));
    expect(socket.closeCount).toBe(1);
    expect(await controller.status()).toEqual(Result.ok({ connected: false }));
  });

  test("stale dial cleanup does not clear the new attempt's coalescing slot", async () => {
    const resolvers: Array<(socket: FakeSocket) => void> = [];
    let dialCount = 0;
    const controller = createConnectionController({
      ...initializedLedger,
      dial: (_url, _protocols) => {
        dialCount++;
        return new Promise((resolve) => resolvers.push((socket) => resolve(Result.ok(socket))));
      },
    });
    const old = controller.connect("old-secret");
    await Promise.resolve();
    controller.disconnect();
    const current = controller.connect("new-secret");
    await Promise.resolve();
    const coalesced = controller.connect("ignored-secret");
    resolvers[0]!(new FakeSocket([connectionConfig.selectedSubprotocol]));

    expect(await old).toEqual(Result.err({ code: "cancelled" }));
    expect(dialCount).toBe(2);
    expect(await controller.status()).toEqual(Result.ok({ connected: false }));
    resolvers[1]!(new FakeSocket([connectionConfig.selectedSubprotocol]));
    await Promise.all([current, coalesced]);
    expect(dialCount).toBe(2);
    expect(await controller.status()).toEqual(Result.ok({ connected: true }));
  });
});

class FakeSocket {
  selectedProtocol: string = connectionConfig.selectedSubprotocol;
  closeCount = 0;
  failClose = false;
  throwOnClose = false;
  failListener = false;
  private disconnectCallback?: () => void;
  constructor(readonly protocols: string[]) {}
  get protocol() {
    return this.selectedProtocol;
  }
  close() {
    this.closeCount++;
    if (this.throwOnClose) throw new Error("socket close failed");
    return this.failClose
      ? Result.err({ code: "disconnect_failed" as const })
      : Result.ok(undefined);
  }
  onDisconnect(callback: () => void) {
    if (this.failListener) return Result.err({ code: "disconnect_failed" as const });
    this.disconnectCallback = callback;
    return Result.ok(() => {
      if (this.disconnectCallback === callback) this.disconnectCallback = undefined;
    });
  }
  fireDisconnect() {
    this.disconnectCallback?.();
  }
}
