import { useState, useCallback, useEffect } from "react";
import { Monitor, Server, AlertTriangle } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import {
  TunnelConfig,
  TunnelType,
  LocalForwardConfig,
  RemoteForwardConfig,
  DynamicForwardConfig,
  RunLocation,
  THIS_COMPUTER,
} from "@/types/tunnel";
import { TunnelEditorMeta } from "@/types/terminal";
import { Button, Input, NumberInput, Select, Field, Toggle, toast } from "@/components/ui";
import { useEditorKeyboard } from "@/hooks/useEditorKeyboard";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
import { frontendLog } from "@/utils/frontendLog";
import {
  isAgentHost,
  tunnelEndpointLines,
  tunnelReachabilityWarning,
  WIDE_BIND_HOST,
} from "@/utils/tunnelHost";
import { TunnelDiagram } from "./TunnelDiagram";
import { validateTunnelType } from "./tunnelValidation";
import "./TunnelEditor.css";

/** Encode a run-location as a `Select` option value, and decode it back. */
const HOST_THIS = "this";
function encodeHost(host: RunLocation): string {
  return isAgentHost(host) ? `agent:${host.agentId}` : HOST_THIS;
}
function decodeHost(value: string): RunLocation {
  return value.startsWith("agent:")
    ? { kind: "agent", agentId: value.slice("agent:".length) }
    : THIS_COMPUTER;
}

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
  const { connections } = useProjectedConnections();
  const { remoteAgents } = useProjectedAgents();
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
  // Which machine hosts this tunnel (S3, #2155). New tunnels default to This
  // computer — agent hosting is opt-in.
  const [host, setHost] = useState<RunLocation>(existingTunnel?.host ?? THIS_COMPUTER);
  const [autoStart, setAutoStart] = useState(existingTunnel?.autoStart ?? false);
  const [reconnect, setReconnect] = useState(existingTunnel?.reconnectOnDisconnect ?? false);

  // Sync if tunnel ID changes
  useEffect(() => {
    if (existingTunnel) {
      setName(existingTunnel.name);
      setSshConnectionId(existingTunnel.sshConnectionId);
      setTunnelType(existingTunnel.tunnelType);
      setHost(existingTunnel.host ?? THIS_COMPUTER);
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

  const updateConfig = useCallback((field: string, value: string | number | "") => {
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

  // Inline validation of the forwarding host/port fields. Blocks Save while any
  // visible field is invalid. `tunnelType` is a fresh object on every edit, so
  // memoizing the check would never hit; it iterates only a few fields.
  const { errors, valid } = validateTunnelType(tunnelType);
  const canSave = !!sshConnectionId && valid;

  const handleSave = useCallback(
    async (andStart: boolean) => {
      const config: TunnelConfig = {
        id: existingTunnel?.id ?? `tun-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: name || "Untitled Tunnel",
        sshConnectionId,
        tunnelType,
        host,
        autoStart,
        reconnectOnDisconnect: reconnect,
      };

      try {
        await saveTunnel(config);
        if (andStart) {
          startTunnel(config.id).catch((err) => {
            frontendLog("tunnel_editor", `Failed to start tunnel after save: ${err}`);
            toast.error("Failed to start tunnel");
          });
        }
        // Find panelId for this tab and close it
        const { findLeafByTab } = await import("@/utils/panelTree");
        const leaf = findLeafByTab(rootPanel, tabId);
        if (leaf) {
          closeTab(tabId, leaf.id);
        }
      } catch (err) {
        frontendLog("tunnel_editor", `Failed to save tunnel: ${err}`);
        throw err instanceof Error ? err : new Error("Failed to save tunnel");
      }
    },
    [
      existingTunnel,
      name,
      sshConnectionId,
      tunnelType,
      host,
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

  const sshOptions = sshConnections.map((c) => ({ value: c.id, label: c.name }));

  // Tunnel host (run-location) selector: This computer + every remote agent.
  const hostOptions = [
    { value: HOST_THIS, label: "This computer" },
    ...remoteAgents.map((a) => ({ value: `agent:${a.id}`, label: `Agent · ${a.name}` })),
  ];
  const hostAgentName = isAgentHost(host)
    ? (remoteAgents.find((a) => a.id === host.agentId)?.name ?? host.agentId)
    : undefined;
  const sshLabel = sshConnections.find((c) => c.id === sshConnectionId)?.name;
  const endpointLines = tunnelEndpointLines(tunnelType, host, {
    agentName: hostAgentName,
    sshLabel,
  });
  const reachability = tunnelReachabilityWarning(tunnelType, host, hostAgentName);

  /** Widen an agent-hosted loopback bind to 0.0.0.0 so this computer can reach it. */
  const handleWidenBind = useCallback(() => {
    updateConfig("localHost", WIDE_BIND_HOST);
  }, [updateConfig]);

  const nameRef = useAutofocusSelect<HTMLInputElement>();

  // Enter (from a single-line field) saves; Escape cancels.
  const handleKeyDown = useEditorKeyboard({
    onSubmit: () => void handleSave(false),
    onCancel: () => void handleCancel(),
    canSubmit: canSave,
  });

  return (
    <div
      className={`tunnel-editor ${isVisible ? "" : "tunnel-editor--hidden"}`}
      data-testid="tunnel-editor"
      onKeyDown={handleKeyDown}
    >
      <div className="tunnel-editor__header">
        <span className="tunnel-editor__title" data-testid="tunnel-editor-title">
          {existingTunnel ? `Edit Tunnel: ${existingTunnel.name}` : "New SSH Tunnel"}
        </span>
      </div>

      <div className="tunnel-editor__form" data-testid="tunnel-editor-form">
        <Field label="Name" htmlFor={`tunnel-name-${tabId}`}>
          <Input
            ref={nameRef}
            id={`tunnel-name-${tabId}`}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Dev Database"
            data-testid="tunnel-editor-name"
          />
        </Field>

        <Field label="SSH Connection" htmlFor={`tunnel-ssh-${tabId}`}>
          <Select
            value={sshConnectionId || undefined}
            onChange={setSshConnectionId}
            options={sshOptions}
            placeholder="No SSH connections available"
            aria-label="SSH Connection"
            data-testid="tunnel-editor-ssh-connection"
          />
        </Field>

        <Field label="Tunnel host" htmlFor={`tunnel-host-${tabId}`}>
          <Select
            value={encodeHost(host)}
            onChange={(v) => setHost(decodeHost(v))}
            options={hostOptions}
            aria-label="Tunnel host"
            data-testid="tunnel-editor-host"
          />
        </Field>

        <div className="tunnel-editor__field">
          <label className="tunnel-editor__label">Tunnel Type</label>
          <div className="tunnel-editor__type-selector" data-testid="tunnel-editor-type-selector">
            <button
              className={`tunnel-editor__type-option ${tunnelType.type === "local" ? "tunnel-editor__type-option--active" : ""}`}
              onClick={() => handleTypeChange("local")}
              data-testid="tunnel-type-local"
            >
              <span className="tunnel-editor__type-option-title">Local</span>
              <span className="tunnel-editor__type-option-desc">ssh -L</span>
            </button>
            <button
              className={`tunnel-editor__type-option ${tunnelType.type === "remote" ? "tunnel-editor__type-option--active" : ""}`}
              onClick={() => handleTypeChange("remote")}
              data-testid="tunnel-type-remote"
            >
              <span className="tunnel-editor__type-option-title">Remote</span>
              <span className="tunnel-editor__type-option-desc">ssh -R</span>
            </button>
            <button
              className={`tunnel-editor__type-option ${tunnelType.type === "dynamic" ? "tunnel-editor__type-option--active" : ""}`}
              onClick={() => handleTypeChange("dynamic")}
              data-testid="tunnel-type-dynamic"
            >
              <span className="tunnel-editor__type-option-title">Dynamic</span>
              <span className="tunnel-editor__type-option-desc">ssh -D (SOCKS5)</span>
            </button>
          </div>
        </div>

        <TunnelDiagram tunnelType={tunnelType} />

        <div className="tunnel-editor__endpoints" data-testid="tunnel-editor-endpoints">
          <div className="tunnel-editor__endpoints-host">
            {isAgentHost(host) ? <Server size={13} /> : <Monitor size={13} />}
            <span>
              Host:{" "}
              <strong>{isAgentHost(host) ? `agent ${hostAgentName}` : "this computer"}</strong>
            </span>
          </div>
          {endpointLines.map((line, i) => (
            <div className="tunnel-editor__endpoint-line" key={i}>
              <strong>{line.label}</strong> {line.machine && <span>{line.machine}</span>}
              {line.machine && line.address ? " · " : ""}
              {line.address && <code>{line.address}</code>}
              {line.note && <span className="tunnel-editor__endpoint-note"> ({line.note})</span>}
            </div>
          ))}
        </div>

        {reachability && (
          <div className="tunnel-editor__reachability" data-testid="tunnel-editor-reachability">
            <AlertTriangle size={14} className="tunnel-editor__reachability-icon" />
            <span className="tunnel-editor__reachability-text">
              {reachability.message}{" "}
              <button
                type="button"
                className="tunnel-editor__reachability-action"
                onClick={handleWidenBind}
                data-testid="tunnel-editor-widen-bind"
              >
                Widen bind
              </button>
            </span>
          </div>
        )}

        {tunnelType.type === "local" && (
          <>
            <span className="tunnel-editor__section-title">Local Bind</span>
            <div className="tunnel-editor__row">
              <Field
                label="Local Host"
                htmlFor={`tunnel-local-host-${tabId}`}
                error={errors.localHost}
              >
                <Input
                  id={`tunnel-local-host-${tabId}`}
                  type="text"
                  value={tunnelType.config.localHost}
                  onChange={(e) => updateConfig("localHost", e.target.value)}
                  error={!!errors.localHost}
                />
              </Field>
              <Field
                label="Local Port"
                htmlFor={`tunnel-local-port-${tabId}`}
                className="tunnel-editor__port-field"
                error={errors.localPort}
              >
                <NumberInput
                  id={`tunnel-local-port-${tabId}`}
                  value={tunnelType.config.localPort}
                  onValueChange={(v) => updateConfig("localPort", v)}
                  error={!!errors.localPort}
                  data-testid="tunnel-editor-local-port"
                />
              </Field>
            </div>
            <span className="tunnel-editor__section-title">Remote Target</span>
            <div className="tunnel-editor__row">
              <Field
                label="Remote Host"
                htmlFor={`tunnel-remote-host-${tabId}`}
                error={errors.remoteHost}
              >
                <Input
                  id={`tunnel-remote-host-${tabId}`}
                  type="text"
                  value={tunnelType.config.remoteHost}
                  onChange={(e) => updateConfig("remoteHost", e.target.value)}
                  error={!!errors.remoteHost}
                  data-testid="tunnel-editor-remote-host"
                />
              </Field>
              <Field
                label="Remote Port"
                htmlFor={`tunnel-remote-port-${tabId}`}
                className="tunnel-editor__port-field"
                error={errors.remotePort}
              >
                <NumberInput
                  id={`tunnel-remote-port-${tabId}`}
                  value={tunnelType.config.remotePort}
                  onValueChange={(v) => updateConfig("remotePort", v)}
                  error={!!errors.remotePort}
                  data-testid="tunnel-editor-remote-port"
                />
              </Field>
            </div>
          </>
        )}

        {tunnelType.type === "remote" && (
          <>
            <span className="tunnel-editor__section-title">Remote Bind (on SSH Server)</span>
            <div className="tunnel-editor__row">
              <Field
                label="Remote Host"
                htmlFor={`tunnel-r-remote-host-${tabId}`}
                error={errors.remoteHost}
              >
                <Input
                  id={`tunnel-r-remote-host-${tabId}`}
                  type="text"
                  value={tunnelType.config.remoteHost}
                  onChange={(e) => updateConfig("remoteHost", e.target.value)}
                  error={!!errors.remoteHost}
                  data-testid="tunnel-editor-remote-host"
                />
              </Field>
              <Field
                label="Remote Port"
                htmlFor={`tunnel-r-remote-port-${tabId}`}
                className="tunnel-editor__port-field"
                error={errors.remotePort}
              >
                <NumberInput
                  id={`tunnel-r-remote-port-${tabId}`}
                  value={tunnelType.config.remotePort}
                  onValueChange={(v) => updateConfig("remotePort", v)}
                  error={!!errors.remotePort}
                  data-testid="tunnel-editor-remote-port"
                />
              </Field>
            </div>
            <span className="tunnel-editor__section-title">Local Target</span>
            <div className="tunnel-editor__row">
              <Field
                label="Local Host"
                htmlFor={`tunnel-r-local-host-${tabId}`}
                error={errors.localHost}
              >
                <Input
                  id={`tunnel-r-local-host-${tabId}`}
                  type="text"
                  value={tunnelType.config.localHost}
                  onChange={(e) => updateConfig("localHost", e.target.value)}
                  error={!!errors.localHost}
                />
              </Field>
              <Field
                label="Local Port"
                htmlFor={`tunnel-r-local-port-${tabId}`}
                className="tunnel-editor__port-field"
                error={errors.localPort}
              >
                <NumberInput
                  id={`tunnel-r-local-port-${tabId}`}
                  value={tunnelType.config.localPort}
                  onValueChange={(v) => updateConfig("localPort", v)}
                  error={!!errors.localPort}
                  data-testid="tunnel-editor-local-port"
                />
              </Field>
            </div>
          </>
        )}

        {tunnelType.type === "dynamic" && (
          <>
            <span className="tunnel-editor__section-title">SOCKS5 Proxy Bind</span>
            <div className="tunnel-editor__row">
              <Field
                label="Local Host"
                htmlFor={`tunnel-d-local-host-${tabId}`}
                error={errors.localHost}
              >
                <Input
                  id={`tunnel-d-local-host-${tabId}`}
                  type="text"
                  value={tunnelType.config.localHost}
                  onChange={(e) => updateConfig("localHost", e.target.value)}
                  error={!!errors.localHost}
                />
              </Field>
              <Field
                label="Local Port"
                htmlFor={`tunnel-d-local-port-${tabId}`}
                className="tunnel-editor__port-field"
                error={errors.localPort}
              >
                <NumberInput
                  id={`tunnel-d-local-port-${tabId}`}
                  value={tunnelType.config.localPort}
                  onValueChange={(v) => updateConfig("localPort", v)}
                  error={!!errors.localPort}
                  data-testid="tunnel-editor-local-port"
                />
              </Field>
            </div>
          </>
        )}

        <div className="tunnel-editor__checkbox-row">
          <Toggle id={`auto-start-${tabId}`} checked={autoStart} onCheckedChange={setAutoStart} />
          <label className="tunnel-editor__checkbox-label" htmlFor={`auto-start-${tabId}`}>
            Auto-start when app launches
          </label>
        </div>

        <div className="tunnel-editor__checkbox-row">
          <Toggle id={`reconnect-${tabId}`} checked={reconnect} onCheckedChange={setReconnect} />
          <label className="tunnel-editor__checkbox-label" htmlFor={`reconnect-${tabId}`}>
            Reconnect automatically on disconnect
          </label>
        </div>

        <div className="tunnel-editor__actions">
          <Button
            variant="primary"
            onClick={() => handleSave(false)}
            disabled={!canSave}
            data-testid="tunnel-editor-save"
          >
            Save
          </Button>
          <Button
            variant="primary"
            onClick={() => handleSave(true)}
            disabled={!canSave}
            data-testid="tunnel-editor-save-start"
          >
            Save &amp; Start
          </Button>
          <Button variant="secondary" onClick={handleCancel} data-testid="tunnel-editor-cancel">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
