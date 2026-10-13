import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPopupConfig } from "@nexus-js/chrome";
import { Nexus } from "@nexus-js/core";
import { Result } from "better-result";
import { chromeTarget } from "@nexus-js/chrome";
import { backgroundControlToken } from "../../src/background-contracts";
import { createPopupControl } from "../../src/popup-control";
import {
  connectResultCodec,
  connectionConfig,
  controlStatusResultCodec,
  disconnectResultCodec,
} from "@mpctl/contracts";
import {
  readConnectionSettings,
  saveConnectionSettings,
  type ConnectionSettings,
} from "../../src/connection";

function Popup() {
  const [settings, setSettings] = useState<ConnectionSettings>({
    websocketUrl: connectionConfig.websocketUrl,
    pairingCredential: "",
  });
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState("");
  const operation = useRef(0);
  const editedSettings = useRef({ websocketUrl: false, pairingCredential: false });
  useEffect(() => {
    void readConnectionSettings()
      .then((saved) => {
        if (saved.isErr()) {
          setMessage("连接设置读取失败");
          return;
        }
        setSettings((current) => ({
          websocketUrl: editedSettings.current.websocketUrl
            ? current.websocketUrl
            : saved.value.websocketUrl,
          pairingCredential: editedSettings.current.pairingCredential
            ? current.pairingCredential
            : saved.value.pairingCredential,
        }));
      })
      .catch(() => setMessage("连接设置读取失败"));
    void getControl()
      .then(async (control) => {
        if (operation.current !== 0) return;
        if (control.isErr()) {
          setMessage(
            `后台暂不可用，请点击重试${"cleanupFailed" in control.error && control.error.cleanupFailed ? "（连接清理失败）" : ""}`,
          );
          return;
        }
        const status = await control.value.getStatus();
        if (status.isErr()) setMessage("后台暂不可用，请点击重试");
        else setConnected(status.value.connected);
      })
      .catch(() => setMessage("后台暂不可用，请点击重试"));
  }, []);
  const update = (patch: Partial<ConnectionSettings>) => {
    if (patch.websocketUrl !== undefined) editedSettings.current.websocketUrl = true;
    if (patch.pairingCredential !== undefined) editedSettings.current.pairingCredential = true;
    setSettings((old) => ({ ...old, ...patch }));
  };
  async function toggle() {
    const currentOperation = ++operation.current;
    const cancelling = connecting;
    if (cancelling || connected) setConnecting(false);
    else setConnecting(true);
    const acquired = await getControl();
    if (operation.current !== currentOperation) return;
    if (acquired.isErr()) {
      setMessage(
        `后台暂不可用，请点击重试${"cleanupFailed" in acquired.error && acquired.error.cleanupFailed ? "（连接清理失败）" : ""}`,
      );
      setConnecting(false);
      return;
    }
    const control = acquired.value;
    if (cancelling || connected) {
      const decoded = await control.disconnect();
      if (operation.current !== currentOperation) return;
      if (decoded.isErr()) setMessage("操作失败，请重试");
      else {
        setConnected(decoded.value.connected);
        setMessage("已断开");
      }
      setConnecting(false);
      return;
    }
    const saved = await saveConnectionSettings(settings);
    if (operation.current !== currentOperation) return;
    if (saved.isErr()) {
      setMessage("设置保存失败，请重试");
      setConnecting(false);
      return;
    }
    const status = await control.connect();
    if (operation.current !== currentOperation) return;
    if (status.isErr()) setMessage("操作失败，请重试");
    else {
      setConnected(status.value.connected);
      setMessage(status.value.connected ? "已连接" : "已断开");
    }
    if (operation.current === currentOperation) setConnecting(false);
  }
  return (
    <main>
      <h1>mpctl</h1>
      <label>
        Broker WebSocket 地址
        <input
          value={settings.websocketUrl}
          onChange={(event) => update({ websocketUrl: event.target.value })}
        />
      </label>
      <label>
        配对凭证
        <input
          type="password"
          autoComplete="off"
          value={settings.pairingCredential}
          onChange={(event) => update({ pairingCredential: event.target.value })}
        />
      </label>
      <p role="status">
        {connected ? "已连接" : "未连接"} {message}
      </p>
      <button
        type="button"
        onClick={() =>
          void toggle().catch(() => {
            setMessage("操作失败，请重试");
            setConnecting(false);
          })
        }
      >
        {connecting ? "取消连接" : connected ? "断开" : "显式连接"}
      </button>
    </main>
  );
}

const popupControl = createPopupControl(() => {
  const runtimeResult = Result.try({
    try: () => new Nexus(),
    catch: () => ({ code: "runtime_unavailable" as const }),
  });
  if (runtimeResult.isErr()) return runtimeResult;
  const runtime = runtimeResult.value;
  const configResult = Result.try({
    try: () => createPopupConfig(),
    catch: () => ({ code: "runtime_unavailable" as const }),
  });
  if (configResult.isErr()) return configResult;
  const config = configResult.value;
  const endpoint = config.endpoint?.implementation;
  if (!endpoint) return Result.err({ code: "runtime_unavailable" as const });
  const configured = Result.try({
    try: () => runtime.configure(config),
    catch: () => ({ code: "runtime_unavailable" as const }),
  });
  if (configured.isErr()) {
    const cleanup = Result.try({
      try: () => endpoint.close(),
      catch: () => ({ code: "runtime_unavailable" as const }),
    });
    return cleanup.isErr()
      ? Result.err({ ...configured.error, cleanupFailed: true as const })
      : configured;
  }
  return Result.ok({
    runtime: {
      ready: () => runtime.ready(),
      connect: async () => {
        const connection = await Result.tryPromise({
          try: () =>
            runtime.connect({
              target: chromeTarget.background(),
              timeout: 2_000,
            }),
          catch: () => ({ code: "background_unavailable" as const }),
        });
        if (connection.isErr()) return connection;
        return Result.try({
          try: () => connection.value.get(backgroundControlToken),
          catch: () => ({ code: "background_unavailable" as const }),
        });
      },
    },
    endpoint,
  });
});
const getControl = async () => {
  const acquired = await popupControl.get();
  if (acquired.isErr()) return acquired;
  const remote = acquired.value;
  const connect = async () => {
    const wire = await Result.tryPromise({
      try: async () => await remote.connect(),
      catch: () => ({ code: "connect_failed" as const }),
    });
    return wire.isErr() ? wire : connectResultCodec.deserialize(wire.value);
  };
  const disconnect = async () => {
    const wire = await Result.tryPromise({
      try: async () => await remote.disconnect(),
      catch: () => ({ code: "disconnect_failed" as const }),
    });
    return wire.isErr() ? wire : disconnectResultCodec.deserialize(wire.value);
  };
  const getStatus = async () => {
    const wire = await Result.tryPromise({
      try: async () => await remote.getStatus(),
      catch: () => ({ code: "status_failed" as const }),
    });
    return wire.isErr() ? wire : controlStatusResultCodec.deserialize(wire.value);
  };
  return Result.ok({
    connect,
    disconnect,
    getStatus,
  });
};

createRoot(document.getElementById("root")!).render(<Popup />);
