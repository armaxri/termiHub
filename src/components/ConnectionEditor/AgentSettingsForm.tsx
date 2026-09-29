/**
 * Form for editing agent runtime settings (enable monitoring, file browser,
 * Docker, default shell, starting directory, log level, verbose tracing).
 *
 * Shown in the "Agent" tab of the connection editor when editing a remote agent
 * transport config. Fields that benefit from live agent data (shell list) show
 * a hint when the agent is not connected.
 */

import { useEffect, useState } from "react";
import { AgentCapabilities, AgentSettings } from "@/types/connection";
import { Field, Input, NumberInput, Select, Toggle } from "@/components/ui";
import { SettingsField } from "@/components/Settings/SettingsField";

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

  // The persisted buffer size is a required `number`, but the field must be
  // able to read blank while the user retypes a value. Track the editable
  // `number | ""` locally and only persist an in-range number — a blank or
  // out-of-range entry leaves the last valid value untouched rather than
  // silently coercing to a default.
  const [scrollbackMb, setScrollbackMb] = useState<number | "">(
    settings.persistentScrollbackBufferSizeMb
  );
  useEffect(() => {
    setScrollbackMb(settings.persistentScrollbackBufferSizeMb);
  }, [settings.persistentScrollbackBufferSizeMb]);

  const handleScrollbackChange = (value: number | "") => {
    setScrollbackMb(value);
    if (value !== "" && value >= 1 && value <= 64) {
      update("persistentScrollbackBufferSizeMb", value);
    }
  };

  return (
    <div>
      <div className="settings-panel__category">
        <h3 className="settings-panel__category-title">Features</h3>

        <SettingsField
          label="System Monitoring"
          hint="Collect CPU, memory, and disk usage from the remote host."
        >
          <Toggle
            checked={settings.enableMonitoring}
            onCheckedChange={(v) => update("enableMonitoring", v)}
          />
        </SettingsField>

        <SettingsField
          label="File Browser (SFTP)"
          hint="Browse and transfer files on the remote host via SFTP."
        >
          <Toggle
            checked={settings.enableFileBrowser}
            onCheckedChange={(v) => update("enableFileBrowser", v)}
          />
        </SettingsField>

        <SettingsField
          label="Docker Sessions"
          hint="Open terminal sessions directly inside Docker containers on the remote host."
        >
          <Toggle
            checked={settings.enableDocker}
            onCheckedChange={(v) => update("enableDocker", v)}
          />
        </SettingsField>
      </div>

      <div className="settings-panel__category">
        <h3 className="settings-panel__category-title">Session Defaults</h3>

        <Field
          variant="settings"
          label="Default Shell"
          hint="Shell used for new sessions. Leave empty to auto-detect."
          labelAccessory={
            !isConnected ? (
              <span
                className="settings-form__hint settings-form__hint--warning agent-settings__shell-warning"
                title="Connect to query available shells"
              >
                ⚠ Connect to query shells
              </span>
            ) : undefined
          }
        >
          {isConnected ? (
            <Select
              value={settings.defaultShell ?? AUTO_DETECT_SHELL}
              onChange={(v) => update("defaultShell", v === AUTO_DETECT_SHELL ? null : v)}
              options={[
                { value: AUTO_DETECT_SHELL, label: "Auto-detect" },
                ...availableShells.map((shell) => ({ value: shell, label: shell })),
              ]}
            />
          ) : (
            <Input
              type="text"
              placeholder="Auto-detect"
              value={settings.defaultShell ?? ""}
              onChange={(e) => update("defaultShell", e.target.value || null)}
            />
          )}
        </Field>

        <SettingsField
          label="Starting Directory"
          hint="Working directory for new sessions. Leave empty for the shell default."
        >
          <Input
            type="text"
            value={settings.startingDirectory}
            onChange={(e) => update("startingDirectory", e.target.value)}
            placeholder="~"
          />
        </SettingsField>
      </div>

      <div className="settings-panel__category">
        <h3 className="settings-panel__category-title">Persistent Sessions</h3>

        <SettingsField
          label="Persistent Scrollback Buffer"
          hint="Size of the ring buffer kept on the agent for persistent sessions (1–64 MiB). Changes apply to newly started sessions."
        >
          <NumberInput
            min={1}
            max={64}
            step={1}
            value={scrollbackMb}
            onValueChange={handleScrollbackChange}
          />
        </SettingsField>
      </div>

      <div className="settings-panel__category">
        <h3 className="settings-panel__category-title">Diagnostics</h3>

        <SettingsField label="Log Level" hint="Controls the verbosity of agent-side log output.">
          <Select
            value={settings.logLevel}
            onChange={(v) => update("logLevel", v as AgentSettings["logLevel"])}
            options={LOG_LEVELS.map((level) => ({
              value: level,
              label: level.charAt(0).toUpperCase() + level.slice(1),
            }))}
          />
        </SettingsField>

        <SettingsField
          label="Verbose Protocol Tracing"
          hint="Log every JSON-RPC message. Useful for debugging connection issues."
        >
          <Toggle
            checked={settings.verboseTracing}
            onCheckedChange={(v) => update("verboseTracing", v)}
          />
        </SettingsField>
      </div>
    </div>
  );
}
