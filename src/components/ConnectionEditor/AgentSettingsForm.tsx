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
    <div className="agent-settings-form">
      <div className="agent-settings-form__section">
        <div className="agent-settings-form__section-title">Features</div>

        <label className="agent-settings-form__checkbox">
          <input
            type="checkbox"
            checked={settings.enableMonitoring}
            onChange={(e) => update("enableMonitoring", e.target.checked)}
          />
          Enable system monitoring
        </label>

        <label className="agent-settings-form__checkbox">
          <input
            type="checkbox"
            checked={settings.enableFileBrowser}
            onChange={(e) => update("enableFileBrowser", e.target.checked)}
          />
          Enable file browser (SFTP)
        </label>

        <label className="agent-settings-form__checkbox">
          <input
            type="checkbox"
            checked={settings.enableDocker}
            onChange={(e) => update("enableDocker", e.target.checked)}
          />
          Enable Docker session support
        </label>
      </div>

      <div className="agent-settings-form__section">
        <div className="agent-settings-form__section-title">Session Defaults</div>

        <label className="agent-settings-form__field">
          <span className="agent-settings-form__label">
            Default shell
            {!isConnected && (
              <span className="agent-settings-form__hint" title="Connect to query available shells">
                ⚠ Connect to query available shells
              </span>
            )}
          </span>
          {isConnected ? (
            <select
              className="agent-settings-form__select"
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
              className="agent-settings-form__input"
              placeholder="Auto-detect"
              value={settings.defaultShell ?? ""}
              onChange={(e) => update("defaultShell", e.target.value || null)}
            />
          )}
        </label>

        <label className="agent-settings-form__field">
          <span className="agent-settings-form__label">Starting directory</span>
          <input
            type="text"
            className="agent-settings-form__input"
            value={settings.startingDirectory}
            onChange={(e) => update("startingDirectory", e.target.value)}
          />
        </label>
      </div>

      <div className="agent-settings-form__section">
        <div className="agent-settings-form__section-title">Diagnostics</div>

        <label className="agent-settings-form__field">
          <span className="agent-settings-form__label">Log level</span>
          <select
            className="agent-settings-form__select"
            value={settings.logLevel}
            onChange={(e) => update("logLevel", e.target.value as AgentSettings["logLevel"])}
          >
            {LOG_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </option>
            ))}
          </select>
        </label>

        <label className="agent-settings-form__checkbox">
          <input
            type="checkbox"
            checked={settings.verboseTracing}
            onChange={(e) => update("verboseTracing", e.target.checked)}
          />
          Enable verbose protocol tracing
        </label>
      </div>
    </div>
  );
}
