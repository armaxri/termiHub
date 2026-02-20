import { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { SshConfig } from "@/types/terminal";
import { checkSshAgentStatus, getHomeDir } from "@/services/api";
import { parseHostPort } from "@/utils/parseHostPort";

interface SshSettingsProps {
  config: SshConfig;
  onChange: (config: SshConfig) => void;
  onSetupAgent?: () => void;
}

export function SshSettings({ config, onChange, onSetupAgent }: SshSettingsProps) {
  const [agentStatus, setAgentStatus] = useState<string | null>(null);

  useEffect(() => {
    if (config.authMethod === "agent") {
      checkSshAgentStatus()
        .then(setAgentStatus)
        .catch(() => setAgentStatus(null));
    } else {
      setAgentStatus(null);
    }
  }, [config.authMethod]);

  const handleBrowseKeyPath = useCallback(async () => {
    let defaultPath: string | undefined;
    try {
      const home = await getHomeDir();
      defaultPath = `${home}/.ssh`;
    } catch {
      // Fall through — dialog opens without a default path
    }
    const selected = await open({
      multiple: false,
      title: "Select SSH private key",
      defaultPath,
    });
    if (selected) {
      onChange({ ...config, keyPath: selected as string });
    }
  }, [config, onChange]);

  const isWindows = navigator.userAgent.includes("Windows");

  return (
    <div className="settings-form">
      <label className="settings-form__field">
        <span className="settings-form__label">Host</span>
        <input
          type="text"
          value={config.host}
          onChange={(e) => onChange({ ...config, host: e.target.value })}
          onBlur={() => {
            const { host, port } = parseHostPort(config.host);
            if (port !== null) {
              onChange({ ...config, host, port });
            }
          }}
          placeholder="192.168.1.100"
          data-testid="ssh-settings-host-input"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Port</span>
        <input
          type="number"
          value={config.port}
          onChange={(e) => onChange({ ...config, port: parseInt(e.target.value) || 22 })}
          data-testid="ssh-settings-port-input"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Username</span>
        <input
          type="text"
          value={config.username}
          onChange={(e) => onChange({ ...config, username: e.target.value })}
          placeholder="user"
          data-testid="ssh-settings-username-input"
        />
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Auth Method</span>
        <select
          value={config.authMethod}
          onChange={(e) =>
            onChange({ ...config, authMethod: e.target.value as "password" | "key" | "agent" })
          }
          data-testid="ssh-settings-auth-method-select"
        >
          <option value="agent">SSH Agent</option>
          <option value="key">SSH Key</option>
          <option value="password">Password</option>
        </select>
      </label>
      {config.authMethod === "agent" && agentStatus !== null && agentStatus !== "running" && (
        <p className="settings-form__hint settings-form__hint--warning">
          {isWindows ? (
            <>
              SSH agent service is not running. Start it to use agent authentication.
              {onSetupAgent && (
                <button
                  type="button"
                  className="settings-form__hint-action"
                  onClick={onSetupAgent}
                  data-testid="ssh-settings-setup-agent"
                >
                  Setup SSH Agent
                </button>
              )}
            </>
          ) : (
            <>
              SSH_AUTH_SOCK is not set. Start your SSH agent with <code>eval $(ssh-agent)</code> and
              add keys with <code>ssh-add</code>.
            </>
          )}
        </p>
      )}
      {config.authMethod === "agent" && (agentStatus === null || agentStatus === "running") && (
        <p className="settings-form__hint">
          Uses keys from your running SSH agent (ssh-agent or Pageant).
        </p>
      )}
      {config.authMethod === "password" && (
        <p className="settings-form__hint">
          You will be prompted for a password each time you connect.
        </p>
      )}
      {config.authMethod === "key" && (
        <>
          <div className="settings-form__field">
            <span className="settings-form__label">Key Path</span>
            <div className="settings-form__file-row">
              <input
                type="text"
                value={config.keyPath ?? ""}
                onChange={(e) => onChange({ ...config, keyPath: e.target.value })}
                placeholder="~/.ssh/id_ed25519"
                data-testid="ssh-settings-key-path-input"
              />
              <button
                type="button"
                className="settings-form__list-browse"
                onClick={handleBrowseKeyPath}
                title="Browse"
                data-testid="ssh-settings-key-path-browse"
              >
                ...
              </button>
            </div>
          </div>
          <label className="settings-form__field">
            <span className="settings-form__label">Key Passphrase (optional)</span>
            <input
              type="password"
              value={config.password ?? ""}
              onChange={(e) => onChange({ ...config, password: e.target.value || undefined })}
              placeholder="Leave empty if unencrypted"
              data-testid="ssh-settings-key-passphrase-input"
            />
          </label>
        </>
      )}
      <label className="settings-form__field settings-form__field--checkbox">
        <input
          type="checkbox"
          checked={config.enableX11Forwarding ?? false}
          onChange={(e) => onChange({ ...config, enableX11Forwarding: e.target.checked })}
          data-testid="ssh-settings-x11-checkbox"
        />
        <span className="settings-form__label">Enable X11 Forwarding</span>
      </label>
      <p className="settings-form__hint">
        Forwards remote GUI applications to your local X server (requires XQuartz on macOS).
      </p>
      <label className="settings-form__field">
        <span className="settings-form__label">Power Monitoring</span>
        <select
          value={
            config.enableMonitoring === undefined
              ? "default"
              : config.enableMonitoring
                ? "enabled"
                : "disabled"
          }
          onChange={(e) => {
            const v = e.target.value;
            onChange({
              ...config,
              enableMonitoring: v === "default" ? undefined : v === "enabled",
            });
          }}
          data-testid="ssh-settings-monitoring-select"
        >
          <option value="default">Default (from Settings)</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">File Browser</span>
        <select
          value={
            config.enableFileBrowser === undefined
              ? "default"
              : config.enableFileBrowser
                ? "enabled"
                : "disabled"
          }
          onChange={(e) => {
            const v = e.target.value;
            onChange({
              ...config,
              enableFileBrowser: v === "default" ? undefined : v === "enabled",
            });
          }}
          data-testid="ssh-settings-filebrowser-select"
        >
          <option value="default">Default (from Settings)</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
      </label>
    </div>
  );
}
