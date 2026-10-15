import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { configureNexusDebug } from "@mpctl/contracts/nexus-debug";
import { connectionConfig } from "@mpctl/contracts";
import { createBackgroundControlClient } from "../../src/popup-control";
import {
  readConnectionSettings,
  saveConnectionSettings,
  type ConnectionSettings,
} from "../../src/connection";
import "../../src/connection-ui.css";

configureNexusDebug(
  "popup",
  Boolean(import.meta.env.DEV) && import.meta.env.VITE_MPCTL_NEXUS_DEBUG !== "0",
);
const controlClient = createBackgroundControlClient();
window.addEventListener("pagehide", () => {
  controlClient.dispose();
});

function Popup() {
  const [state, setState] = useState<
    "loading" | "idle" | "sending" | "requested" | "connected" | "error"
  >("loading");
  const [diagnostic, setDiagnostic] = useState("");
  const [settings, setSettings] = useState<ConnectionSettings>({
    websocketUrl: connectionConfig.websocketUrl,
    pairingCredential: "",
  });
  const [settingsReady, setSettingsReady] = useState(!import.meta.env.DEV);
  const [settingsEdited, setSettingsEdited] = useState(false);
  useEffect(() => {
    let active = true;
    void controlClient
      .get()
      .then(async (control) => {
        const result = control.isErr() ? control : await control.value.getStatus();
        if (!active) return;
        if (result.isErr()) {
          setDiagnostic(result.error.code);
          setState("error");
        } else setState(result.value.connected ? "connected" : "idle");
      })
      .catch(() => {
        if (active) setState("error");
      });
    if (import.meta.env.DEV) {
      void readConnectionSettings()
        .then((result) => {
          if (!active) return;
          if (result.isOk()) {
            setSettings(result.value);
            setSettingsReady(true);
          } else {
            setDiagnostic(result.error.code);
            setState("error");
          }
        })
        .catch(() => {
          if (active) {
            setDiagnostic("settings_failed");
            setState("error");
          }
        });
    }
    return () => {
      active = false;
    };
  }, []);

  async function connect() {
    setState("sending");
    setDiagnostic("");
    if (import.meta.env.DEV && settingsEdited) {
      const saved = await saveConnectionSettings(settings);
      if (saved.isErr()) {
        setDiagnostic(saved.error.code);
        setState("error");
        return;
      }
      setSettingsEdited(false);
    }
    const control = await controlClient.get();
    const result = control.isErr() ? control : await control.value.requestConnect();
    if (result.isErr()) {
      setDiagnostic(result.error.code);
      setState("error");
    } else setState("requested");
  }

  const messages = {
    loading: "正在准备连接…",
    idle: "连接后，返回终端继续编辑。",
    sending: "正在发起连接…",
    requested: "已发起连接，请返回终端继续操作。",
    connected: "已连接，可以返回终端继续操作。",
    error: "暂时无法发起连接，请重试。",
  };
  const busy = state === "loading" || state === "sending";
  return (
    <main className="connection-panel popup-panel">
      <header>
        <h1>mpctl</h1>
        <p className="subtitle">连接你的编辑工具</p>
      </header>
      <p className="connection-status" role="status" aria-live="polite" data-state={state}>
        {messages[state]}
      </p>
      <button
        className="primary-button"
        type="button"
        disabled={busy || !settingsReady}
        aria-busy={busy}
        onClick={() => {
          void connect().catch(() => {
            setDiagnostic("unexpected_failure");
            setState("error");
          });
        }}
      >
        {state === "sending" ? "正在发起…" : state === "error" ? "重试连接" : "发起连接"}
      </button>
      {import.meta.env.DEV && (
        <details className="developer-settings">
          <summary>开发调试</summary>
          <label htmlFor="broker-url">Broker WebSocket 地址</label>
          <input
            id="broker-url"
            type="url"
            value={settings.websocketUrl}
            disabled={busy || !settingsReady}
            onChange={(event) => {
              setSettings({ ...settings, websocketUrl: event.target.value });
              setSettingsEdited(true);
            }}
          />
          <label htmlFor="pairing-credential">配对凭证</label>
          <input
            id="pairing-credential"
            type="password"
            autoComplete="off"
            value={settings.pairingCredential}
            disabled={busy || !settingsReady}
            onChange={(event) => {
              setSettings({ ...settings, pairingCredential: event.target.value });
              setSettingsEdited(true);
            }}
          />
          <p className="developer-note">修改后点击“发起连接”保存。已有连接需先断开。</p>
          {diagnostic && (
            <p className="developer-note" role="status">
              诊断：{diagnostic}
            </p>
          )}
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setState("sending");
              void controlClient
                .get()
                .then(async (control) => {
                  const result = control.isErr() ? control : await control.value.disconnect();
                  if (result.isErr()) {
                    setDiagnostic(result.error.code);
                    setState("error");
                  } else {
                    setDiagnostic("");
                    setState("idle");
                  }
                })
                .catch(() => {
                  setDiagnostic("unexpected_failure");
                  setState("error");
                });
            }}
          >
            断开连接
          </button>
        </details>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
