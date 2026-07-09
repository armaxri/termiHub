/**
 * Form for editing agent runtime settings (enable monitoring, file browser,
 * Docker, default shell, starting directory, log level, verbose tracing).
 *
 * Shown in the "Agent" tab of the connection editor when editing a remote agent
 * transport config. Fields that benefit from live agent data (shell list) show
 * a hint when the agent is not connected.
 */

import { AgentCapabilities, AgentSettings } from "@/types/connection";
import { Input, Select, Toggle } from "@/components/ui";

const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;

/**
 * Sentinel for the "auto-detect" shell option. Radix Select reserves the empty
 * string to clear the selection, so an explicit non-empty value is required and
 * mapped back to `null` (auto-detect) at the call site.
 */
const AUTO_DETECT_SHELL = "__auto__";

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
          <Toggle
            checked={settings.enableMonitoring}
            onCheckedChange={(v) => update("enableMonitoring", v)}
            aria-label="System Monitoring"
          />
          <span className="settings-form__hint">
            Collect CPU, memory, and disk usage from the remote host.
          </span>
        </div>

        <div className="settings-form__field">
          <span className="settings-form__label">File Browser (SFTP)</span>
          <Toggle
            checked={settings.enableFileBrowser}
            onCheckedChange={(v) => update("enableFileBrowser", v)}
            aria-label="File Browser (SFTP)"
          />
          <span className="settings-form__hint">
            Browse and transfer files on the remote host via SFTP.
          </span>
        </div>

        <div className="settings-form__field">
          <span className="settings-form__label">Docker Sessions</span>
          <Toggle
            checked={settings.enableDocker}
            onCheckedChange={(v) => update("enableDocker", v)}
            aria-label="Docker Sessions"
          />
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
            <Select
              value={settings.defaultShell ?? AUTO_DETECT_SHELL}
              onChange={(v) => update("defaultShell", v === AUTO_DETECT_SHELL ? null : v)}
              options={[
                { value: AUTO_DETECT_SHELL, label: "Auto-detect" },
                ...availableShells.map((shell) => ({ value: shell, label: shell })),
              ]}
              aria-label="Default Shell"
            />
          ) : (
            <Input
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
          <Input
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
        <h3 className="settings-panel__category-title">Persistent Sessions</h3>

        <label className="settings-form__field">
          <span className="settings-form__label">Persistent Scrollback Buffer</span>
          <Input
            type="number"
            min={1}
            max={64}
            step={1}
            value={settings.persistentScrollbackBufferSizeMb}
            onChange={(e) =>
              update(
                "persistentScrollbackBufferSizeMb",
                Math.min(64, Math.max(1, parseInt(e.target.value, 10) || 1))
              )
            }
          />
          <span className="settings-form__hint">
            Size of the ring buffer kept on the agent for persistent sessions (1–64 MiB). Changes
            apply to newly started sessions.
          </span>
        </label>
      </div>

      <div className="settings-panel__category">
        <h3 className="settings-panel__category-title">Diagnostics</h3>

        <label className="settings-form__field">
          <span className="settings-form__label">Log Level</span>
          <Select
            value={settings.logLevel}
            onChange={(v) => update("logLevel", v as AgentSettings["logLevel"])}
            options={LOG_LEVELS.map((level) => ({
              value: level,
              label: level.charAt(0).toUpperCase() + level.slice(1),
            }))}
            aria-label="Log Level"
          />
          <span className="settings-form__hint">
            Controls the verbosity of agent-side log output.
          </span>
        </label>

        <div className="settings-form__field">
          <span className="settings-form__label">Verbose Protocol Tracing</span>
          <Toggle
            checked={settings.verboseTracing}
            onCheckedChange={(v) => update("verboseTracing", v)}
            aria-label="Verbose Protocol Tracing"
          />
          <span className="settings-form__hint">
            Log every JSON-RPC message. Useful for debugging connection issues.
          </span>
        </div>
      </div>
    </div>
  );
}
