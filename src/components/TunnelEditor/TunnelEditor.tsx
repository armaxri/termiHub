import { useState, useCallback, useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import {
  TunnelConfig,
  TunnelType,
  LocalForwardConfig,
  RemoteForwardConfig,
  DynamicForwardConfig,
} from "@/types/tunnel";
import { TunnelEditorMeta } from "@/types/terminal";
import { TunnelDiagram } from "./TunnelDiagram";
import "./TunnelEditor.css";

interface TunnelEditorProps {
  tabId: string;
  meta: TunnelEditorMeta;
  isVisible: boolean;
}

const DEFAULT_LOCAL: LocalForwardConfig = {
  localHost: "127.0.0.1",
  localPort: 8080,
  remoteHost: "localhost",
  remotePort: 80,
};

const DEFAULT_REMOTE: RemoteForwardConfig = {
  remoteHost: "0.0.0.0",
  remotePort: 8080,
  localHost: "127.0.0.1",
  localPort: 3000,
};

const DEFAULT_DYNAMIC: DynamicForwardConfig = {
  localHost: "127.0.0.1",
  localPort: 1080,
};

function defaultTunnelType(type: "local" | "remote" | "dynamic"): TunnelType {
  switch (type) {
    case "local":
      return { type: "local", config: { ...DEFAULT_LOCAL } };
    case "remote":
      return { type: "remote", config: { ...DEFAULT_REMOTE } };
    case "dynamic":
      return { type: "dynamic", config: { ...DEFAULT_DYNAMIC } };
  }
}

export function TunnelEditor({ tabId, meta, isVisible }: TunnelEditorProps) {
  const tunnels = useAppStore((s) => s.tunnels);
  const connections = useAppStore((s) => s.connections);
  const saveTunnel = useAppStore((s) => s.saveTunnel);
  const startTunnel = useAppStore((s) => s.startTunnel);
  const closeTab = useAppStore((s) => s.closeTab);
  const rootPanel = useAppStore((s) => s.rootPanel);

  // Find existing tunnel if editing
  const existingTunnel = meta.tunnelId ? tunnels.find((t) => t.id === meta.tunnelId) : undefined;

  // SSH connections only
  const sshConnections = connections.filter((c) => c.config.type === "ssh");

  const [name, setName] = useState(existingTunnel?.name ?? "");
  const [sshConnectionId, setSshConnectionId] = useState(
    existingTunnel?.sshConnectionId ?? sshConnections[0]?.id ?? ""
  );
  const [tunnelType, setTunnelType] = useState<TunnelType>(
    existingTunnel?.tunnelType ?? defaultTunnelType("local")
  );
  const [autoStart, setAutoStart] = useState(existingTunnel?.autoStart ?? false);
  const [reconnect, setReconnect] = useState(existingTunnel?.reconnectOnDisconnect ?? false);

  // Sync if tunnel ID changes
  useEffect(() => {
    if (existingTunnel) {
      setName(existingTunnel.name);
      setSshConnectionId(existingTunnel.sshConnectionId);
      setTunnelType(existingTunnel.tunnelType);
      setAutoStart(existingTunnel.autoStart);
      setReconnect(existingTunnel.reconnectOnDisconnect);
    }
  }, [existingTunnel]);

  const handleTypeChange = useCallback(
    (type: "local" | "remote" | "dynamic") => {
      if (tunnelType.type !== type) {
        setTunnelType(defaultTunnelType(type));
      }
    },
    [tunnelType.type]
  );

  const updateConfig = useCallback((field: string, value: string | number) => {
    setTunnelType((prev) => {
      switch (prev.type) {
        case "local":
          return { type: "local", config: { ...prev.config, [field]: value } };
        case "remote":
          return { type: "remote", config: { ...prev.config, [field]: value } };
        case "dynamic":
          return { type: "dynamic", config: { ...prev.config, [field]: value } };
      }
    });
  }, []);

  const handleSave = useCallback(
    async (andStart: boolean) => {
      const config: TunnelConfig = {
        id: existingTunnel?.id ?? `tun-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: name || "Untitled Tunnel",
        sshConnectionId,
        tunnelType,
        autoStart,
        reconnectOnDisconnect: reconnect,
      };

      try {
        await saveTunnel(config);
        if (andStart) {
          startTunnel(config.id).catch((err) =>
            console.error("Failed to start tunnel after save:", err)
          );
        }
        // Find panelId for this tab and close it
        const { findLeafByTab } = await import("@/utils/panelTree");
        const leaf = findLeafByTab(rootPanel, tabId);
        if (leaf) {
          closeTab(tabId, leaf.id);
        }
      } catch (err) {
        console.error("Failed to save tunnel:", err);
      }
    },
    [
      existingTunnel,
      name,
      sshConnectionId,
      tunnelType,
      autoStart,
      reconnect,
      saveTunnel,
      startTunnel,
      closeTab,
      rootPanel,
      tabId,
    ]
  );

  const handleCancel = useCallback(async () => {
    const { findLeafByTab } = await import("@/utils/panelTree");
    const leaf = findLeafByTab(rootPanel, tabId);
    if (leaf) {
      closeTab(tabId, leaf.id);
    }
  }, [rootPanel, tabId, closeTab]);

  return (
    <div
      className={`tunnel-editor ${isVisible ? "" : "tunnel-editor--hidden"}`}
      data-testid="tunnel-editor"
    >
      <div className="tunnel-editor__header">
        <span className="tunnel-editor__title" data-testid="tunnel-editor-title">
          {existingTunnel ? `Edit Tunnel: ${existingTunnel.name}` : "New SSH Tunnel"}
        </span>
      </div>

      <div className="tunnel-editor__form" data-testid="tunnel-editor-form">
        <div className="tunnel-editor__field">
          <label className="tunnel-editor__label">Name</label>
          <input
            className="tunnel-editor__input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Dev Database"
            data-testid="tunnel-editor-name"
          />
        </div>

        <div className="tunnel-editor__field">
          <label className="tunnel-editor__label">SSH Connection</label>
          <select
            className="tunnel-editor__select"
            value={sshConnectionId}
            onChange={(e) => setSshConnectionId(e.target.value)}
            data-testid="tunnel-editor-ssh-connection"
          >
            {sshConnections.length === 0 && <option value="">No SSH connections available</option>}
            {sshConnections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="tunnel-editor__field">
          <label className="tunnel-editor__label">Tunnel Type</label>
          <div className="tunnel-editor__type-selector" data-testid="tunnel-editor-type-selector">
            <button
              className={`tunnel-editor__type-btn ${tunnelType.type === "local" ? "tunnel-editor__type-btn--active" : ""}`}
              onClick={() => handleTypeChange("local")}
              data-testid="tunnel-type-local"
            >
              <span className="tunnel-editor__type-btn-title">Local</span>
              <span className="tunnel-editor__type-btn-desc">ssh -L</span>
            </button>
            <button
              className={`tunnel-editor__type-btn ${tunnelType.type === "remote" ? "tunnel-editor__type-btn--active" : ""}`}
              onClick={() => handleTypeChange("remote")}
              data-testid="tunnel-type-remote"
            >
              <span className="tunnel-editor__type-btn-title">Remote</span>
              <span className="tunnel-editor__type-btn-desc">ssh -R</span>
            </button>
            <button
              className={`tunnel-editor__type-btn ${tunnelType.type === "dynamic" ? "tunnel-editor__type-btn--active" : ""}`}
              onClick={() => handleTypeChange("dynamic")}
              data-testid="tunnel-type-dynamic"
            >
              <span className="tunnel-editor__type-btn-title">Dynamic</span>
              <span className="tunnel-editor__type-btn-desc">ssh -D (SOCKS5)</span>
            </button>
          </div>
        </div>

        <TunnelDiagram tunnelType={tunnelType} />

        {tunnelType.type === "local" && (
          <>
            <span className="tunnel-editor__section-title">Local Bind</span>
            <div className="tunnel-editor__row">
              <div className="tunnel-editor__field">
                <label className="tunnel-editor__label">Local Host</label>
                <input
                  className="tunnel-editor__input"
                  type="text"
                  value={tunnelType.config.localHost}
                  onChange={(e) => updateConfig("localHost", e.target.value)}
                />
              </div>
              <div className="tunnel-editor__field tunnel-editor__port-field">
                <label className="tunnel-editor__label">Local Port</label>
                <input
                  className="tunnel-editor__input"
                  type="number"
                  value={tunnelType.config.localPort}
                  onChange={(e) => updateConfig("localPort", parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
            <span className="tunnel-editor__section-title">Remote Target</span>
            <div className="tunnel-editor__row">
              <div className="tunnel-editor__field">
                <label className="tunnel-editor__label">Remote Host</label>
                <input
                  className="tunnel-editor__input"
                  type="text"
                  value={tunnelType.config.remoteHost}
                  onChange={(e) => updateConfig("remoteHost", e.target.value)}
                />
              </div>
              <div className="tunnel-editor__field tunnel-editor__port-field">
                <label className="tunnel-editor__label">Remote Port</label>
                <input
                  className="tunnel-editor__input"
                  type="number"
                  value={tunnelType.config.remotePort}
                  onChange={(e) => updateConfig("remotePort", parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
          </>
        )}

        {tunnelType.type === "remote" && (
          <>
            <span className="tunnel-editor__section-title">Remote Bind (on SSH Server)</span>
            <div className="tunnel-editor__row">
              <div className="tunnel-editor__field">
                <label className="tunnel-editor__label">Remote Host</label>
                <input
                  className="tunnel-editor__input"
                  type="text"
                  value={tunnelType.config.remoteHost}
                  onChange={(e) => updateConfig("remoteHost", e.target.value)}
                />
              </div>
              <div className="tunnel-editor__field tunnel-editor__port-field">
                <label className="tunnel-editor__label">Remote Port</label>
                <input
                  className="tunnel-editor__input"
                  type="number"
                  value={tunnelType.config.remotePort}
                  onChange={(e) => updateConfig("remotePort", parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
            <span className="tunnel-editor__section-title">Local Target</span>
            <div className="tunnel-editor__row">
              <div className="tunnel-editor__field">
                <label className="tunnel-editor__label">Local Host</label>
                <input
                  className="tunnel-editor__input"
                  type="text"
                  value={tunnelType.config.localHost}
                  onChange={(e) => updateConfig("localHost", e.target.value)}
                />
              </div>
              <div className="tunnel-editor__field tunnel-editor__port-field">
                <label className="tunnel-editor__label">Local Port</label>
                <input
                  className="tunnel-editor__input"
                  type="number"
                  value={tunnelType.config.localPort}
                  onChange={(e) => updateConfig("localPort", parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
          </>
        )}

        {tunnelType.type === "dynamic" && (
          <>
            <span className="tunnel-editor__section-title">SOCKS5 Proxy Bind</span>
            <div className="tunnel-editor__row">
              <div className="tunnel-editor__field">
                <label className="tunnel-editor__label">Local Host</label>
                <input
                  className="tunnel-editor__input"
                  type="text"
                  value={tunnelType.config.localHost}
                  onChange={(e) => updateConfig("localHost", e.target.value)}
                />
              </div>
              <div className="tunnel-editor__field tunnel-editor__port-field">
                <label className="tunnel-editor__label">Local Port</label>
                <input
                  className="tunnel-editor__input"
                  type="number"
                  value={tunnelType.config.localPort}
                  onChange={(e) => updateConfig("localPort", parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
          </>
        )}

        <div className="tunnel-editor__checkbox-row">
          <input
            className="tunnel-editor__checkbox"
            type="checkbox"
            id={`auto-start-${tabId}`}
            checked={autoStart}
            onChange={(e) => setAutoStart(e.target.checked)}
          />
          <label className="tunnel-editor__checkbox-label" htmlFor={`auto-start-${tabId}`}>
            Auto-start when app launches
          </label>
        </div>

        <div className="tunnel-editor__checkbox-row">
          <input
            className="tunnel-editor__checkbox"
            type="checkbox"
            id={`reconnect-${tabId}`}
            checked={reconnect}
            onChange={(e) => setReconnect(e.target.checked)}
          />
          <label className="tunnel-editor__checkbox-label" htmlFor={`reconnect-${tabId}`}>
            Reconnect automatically on disconnect
          </label>
        </div>

        <div className="tunnel-editor__actions">
          <button
            className="tunnel-editor__btn tunnel-editor__btn--primary"
            onClick={() => handleSave(false)}
            disabled={!sshConnectionId}
            data-testid="tunnel-editor-save"
          >
            Save
          </button>
          <button
            className="tunnel-editor__btn tunnel-editor__btn--primary"
            onClick={() => handleSave(true)}
            disabled={!sshConnectionId}
            data-testid="tunnel-editor-save-start"
          >
            Save &amp; Start
          </button>
          <button
            className="tunnel-editor__btn"
            onClick={handleCancel}
            data-testid="tunnel-editor-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
