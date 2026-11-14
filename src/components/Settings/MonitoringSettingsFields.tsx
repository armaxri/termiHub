import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { Checkbox, Toggle } from "@/components/ui";
import {
  STATUS_BAR_METRICS,
  STATUS_BAR_METRIC_LABELS,
  resolveStatusBarMetrics,
  type StatusBarMetric,
} from "@/components/StatusBar/statusBarMetrics";
import { SettingsField } from "./SettingsField";
import "./MonitoringSettingsFields.css";

/**
 * Host-monitoring defaults (#5754): whether local shell tabs collect host
 * metrics (off by default) and which metric chips the status bar shows (CPU,
 * memory, disk and network by default; swap is selectable).
 */
export function MonitoringSettingsFields() {
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);
  const shown = resolveStatusBarMetrics(settings.statusBarMetrics);

  /** Persist the chip set as an explicit list, kept in display order. */
  const toggleMetric = (metric: StatusBarMetric, checked: boolean) => {
    const next = STATUS_BAR_METRICS.filter((m) => (m === metric ? checked : shown.has(m)));
    updateSettings({ ...settings, statusBarMetrics: next });
  };

  return (
    <>
      <SettingsField
        label="Monitor local shells"
        hint="Show CPU, memory, disk and network for this computer in local shell tabs. Remote sessions are monitored with Power monitoring."
      >
        <Toggle
          checked={settings.monitorLocalShells ?? false}
          onCheckedChange={(checked) =>
            updateSettings({ ...settings, monitorLocalShells: checked })
          }
          data-testid="toggle-monitor-local-shells"
        />
      </SettingsField>

      <SettingsField
        label="Status bar metrics"
        hint="The host metrics shown in the status bar. The host menu always lists every metric."
        layout="stack"
      >
        <div
          className="monitoring-settings__metrics"
          role="group"
          aria-label="Status bar metrics"
          data-testid="settings-status-bar-metrics"
        >
          {STATUS_BAR_METRICS.map((metric) => {
            const id = `status-bar-metric-${metric}`;
            return (
              <span key={metric} className="monitoring-settings__metric">
                <Checkbox
                  id={id}
                  checked={shown.has(metric)}
                  onCheckedChange={(checked) => toggleMetric(metric, checked)}
                  data-testid={id}
                />
                <label htmlFor={id}>{STATUS_BAR_METRIC_LABELS[metric]}</label>
              </span>
            );
          })}
        </div>
      </SettingsField>
    </>
  );
}
