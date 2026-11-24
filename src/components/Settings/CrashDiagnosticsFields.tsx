import { FileArchive } from "lucide-react";
import type { AppSettings } from "@/types/connection";
import { Button, Toggle } from "@/components/ui";
import { openDiagnosticsExport } from "@/components/Diagnostics/diagnosticsDialogStore";
import { SettingsField } from "./SettingsField";
import type { SettingsUpdate } from "./GeneralSettings";

interface CrashDiagnosticsFieldsProps {
  settings: AppSettings;
  onChange: (update: SettingsUpdate) => void;
}

/**
 * General → Diagnostics controls for local crash reports (OBS-010): the
 * next-start crash notice toggle and the "Export diagnostics" entry point.
 */
export function CrashDiagnosticsFields({ settings, onChange }: CrashDiagnosticsFieldsProps) {
  return (
    <>
      <SettingsField
        label="Crash report notice"
        hint="Offer the crash report on the next start. Reports stay on this computer."
        help="After termiHub closes unexpectedly, the next start shows a notice offering to view or export the local crash report. Crash reports never leave this computer unless you export them."
        hintTestId="settings-show-crash-report-notice-hint"
        helpTestId="settings-show-crash-report-notice-help"
      >
        <Toggle
          checked={settings.showCrashReportNotice ?? true}
          onCheckedChange={(checked) =>
            onChange((prev) => ({ ...prev, showCrashReportNotice: checked }))
          }
          data-testid="settings-show-crash-report-notice"
        />
      </SettingsField>
      <SettingsField
        label="Export diagnostics"
        hint="Save redacted logs and crash reports as a zip. Nothing is sent anywhere."
        help="The zip holds the recent redacted logs, the crash reports and version and platform info, saved to a location you choose, for attaching to a bug report."
        hintTestId="settings-export-diagnostics-hint"
        helpTestId="settings-export-diagnostics-help"
      >
        <Button
          variant="secondary"
          size="sm"
          icon={<FileArchive size={14} />}
          onClick={() => openDiagnosticsExport()}
          data-testid="settings-export-diagnostics"
        >
          Export diagnostics…
        </Button>
      </SettingsField>
    </>
  );
}
