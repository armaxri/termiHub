import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { Toggle } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import { SettingsSectionHeading } from "./SettingsSectionHeading";
import { MonitoringSettingsFields } from "./MonitoringSettingsFields";

/** One line: what the toggle does, for which connections (#5930: not only the agent). */
export const POWER_MONITORING_HINT = "Monitor CPU, memory and power events for SSH connections.";

/**
 * What turning it off really does (#5930, `updateSettings` in settingsSlice): the
 * host monitor of open sessions that use the default stops; the SSH session and
 * its terminal stay connected, so no confirmation is needed.
 */
export const POWER_MONITORING_HELP =
  "Turning it off stops the CPU and memory monitor of open sessions that use this default. The sessions stay connected.";

/**
 * The Monitoring settings category (#5775): host metrics for SSH agent sessions
 * (Power monitoring), for this computer's local shells, and the status-bar
 * chips. These lived under External files ▸ Advanced, where nobody looked for
 * them; the setting keys are unchanged, so no migration is needed.
 */
export function MonitoringSettings() {
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);

  return (
    <div className="settings-panel__category" data-testid="settings-monitoring">
      <div className="settings-panel__section">
        <div className="settings-panel__section-header">
          <SettingsSectionHeading>Remote sessions</SettingsSectionHeading>
        </div>
        <p
          className="settings-panel__description"
          data-testid="settings-monitoring-remote-description"
        >
          Default for new SSH connections. Each connection can override it in its SSH settings.
        </p>
        <SettingsField
          label="Power monitoring"
          hint={POWER_MONITORING_HINT}
          help={POWER_MONITORING_HELP}
          hintTestId="settings-power-monitoring-hint"
          helpTestId="settings-power-monitoring-help"
        >
          <Toggle
            checked={settings.powerMonitoringEnabled}
            onCheckedChange={() =>
              updateSettings({
                ...settings,
                powerMonitoringEnabled: !settings.powerMonitoringEnabled,
              })
            }
            data-testid="toggle-power-monitoring"
          />
        </SettingsField>
      </div>

      <div className="settings-panel__section">
        <div className="settings-panel__section-header">
          <SettingsSectionHeading>This computer and status bar</SettingsSectionHeading>
        </div>
        <MonitoringSettingsFields />
      </div>
    </div>
  );
}
