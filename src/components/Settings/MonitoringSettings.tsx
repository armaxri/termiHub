import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { Toggle } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import { SettingsSectionHeading } from "./SettingsSectionHeading";
import { MonitoringSettingsFields } from "./MonitoringSettingsFields";

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
        <p className="settings-panel__description">
          Default for new SSH connections. Individual connections can override it in their SSH
          settings. Turning it off disconnects active sessions that use the default.
        </p>
        <SettingsField
          label="Power monitoring"
          hint="Monitor CPU, memory, and power events via SSH agent connections."
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
