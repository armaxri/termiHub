/**
 * Form for editing agent runtime settings (enable monitoring, file browser,
 * Docker, default shell, starting directory, log level, verbose tracing).
 *
 * Shown in the "Agent" tab of the connection editor when editing a remote agent
 * transport config. Fields that benefit from live agent data (shell list) show
 * a hint when the agent is not connected.
 */

import { AgentCapabilities, AgentSettings } from "@/types/connection";

const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;

interface AgentSettingsFormProps {
  settings: AgentSettings;
  onChange: (settings: AgentSettings) => void;
  /** Capabilities from a connected agent, used to populate shell dropdown. */
  capabilities?: AgentCapabilities;
}

export function AgentSettingsForm({ settings, onChange, capabilities }: AgentSettingsFormProps) {
  const availableShells = capabilities?.availableShells ?? [];
  const isConnected = availableShells.length > 0;

  const update = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div>
      <div className="settings-panel__category">
        <h3 className="settings-panel__category-title">Features</h3>

        <div className="settings-form__field">
          <span className="settings-form__label">System Monitoring</span>
          <label className="settings-panel__toggle">
            <input
              type="checkbox"
              checked={settings.enableMonitoring}
              onChange={(e) => update("enableMonitoring", e.target.checked)}
            />
            <span className="settings-panel__toggle-slider" />
          </label>
          <span className="settings-form__hint">
            Collect CPU, memory, and disk usage from the remote host.
          </span>
        </div>

        <div className="settings-form__field">
          <span className="settings-form__label">File Browser (SFTP)</span>
          <label className="settings-panel__toggle">
            <input
              type="checkbox"
              checked={settings.enableFileBrowser}
              onChange={(e) => update("enableFileBrowser", e.target.checked)}
            />
            <span className="settings-panel__toggle-slider" />
          </label>
          <span className="settings-form__hint">
            Browse and transfer files on the remote host via SFTP.
          </span>
        </div>

        <div className="settings-form__field">
          <span className="settings-form__label">Docker Sessions</span>
          <label className="settings-panel__toggle">
            <input
              type="checkbox"
              checked={settings.enableDocker}
              onChange={(e) => update("enableDocker", e.target.checked)}
            />
            <span className="settings-panel__toggle-slider" />
          </label>
          <span className="settings-form__hint">
            Open terminal sessions directly inside Docker containers on the remote host.
          </span>
        </div>
      </div>

      <div className="settings-panel__category">
        <h3 className="settings-panel__category-title">Session Defaults</h3>

        <label className="settings-form__field">
          <span className="settings-form__label">
            Default Shell
            {!isConnected && (
              <span
                className="settings-form__hint settings-form__hint--warning"
                style={{ display: "inline", marginLeft: "6px", fontStyle: "normal" }}
                title="Connect to query available shells"
              >
                ⚠ Connect to query shells
              </span>
            )}
          </span>
          {isConnected ? (
            <select
              value={settings.defaultShell ?? ""}
              onChange={(e) => update("defaultShell", e.target.value || null)}
            >
              <option value="">Auto-detect</option>
              {availableShells.map((shell) => (
                <option key={shell} value={shell}>
                  {shell}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              placeholder="Auto-detect"
              value={settings.defaultShell ?? ""}
              onChange={(e) => update("defaultShell", e.target.value || null)}
            />
          )}
          <span className="settings-form__hint">
            Shell used for new sessions. Leave empty to auto-detect.
          </span>
        </label>

        <label className="settings-form__field">
          <span className="settings-form__label">Starting Directory</span>
          <input
            type="text"
            value={settings.startingDirectory}
            onChange={(e) => update("startingDirectory", e.target.value)}
            placeholder="~"
          />
          <span className="settings-form__hint">
            Working directory for new sessions. Leave empty for the shell default.
          </span>
        </label>
      </div>

      <div className="settings-panel__category">
        <h3 className="settings-panel__category-title">Diagnostics</h3>

        <label className="settings-form__field">
          <span className="settings-form__label">Log Level</span>
          <select
            value={settings.logLevel}
            onChange={(e) => update("logLevel", e.target.value as AgentSettings["logLevel"])}
          >
            {LOG_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </option>
            ))}
          </select>
          <span className="settings-form__hint">
            Controls the verbosity of agent-side log output.
          </span>
        </label>

        <div className="settings-form__field">
          <span className="settings-form__label">Verbose Protocol Tracing</span>
          <label className="settings-panel__toggle">
            <input
              type="checkbox"
              checked={settings.verboseTracing}
              onChange={(e) => update("verboseTracing", e.target.checked)}
            />
            <span className="settings-panel__toggle-slider" />
          </label>
          <span className="settings-form__hint">
            Log every JSON-RPC message. Useful for debugging connection issues.
          </span>
        </div>
      </div>
    </div>
  );
}
