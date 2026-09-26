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
        label="Crash Report Notice"
        hint="After termiHub closes unexpectedly, show a notice on the next start offering to view or export the local crash report. Crash reports never leave this computer unless you export them."
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
        label="Export Diagnostics"
        hint="Save a zip with the recent redacted logs, crash reports and version/platform info to a location you choose — for attaching to a bug report. Nothing is sent anywhere."
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
