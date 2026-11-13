import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { currentSettingsView } from "@/store/settingsBridge";
import { Button } from "@/components/ui";
import { acknowledgeCrashReports, getCrashReportNotice } from "@/services/api";
import type { CrashReportNotice as Notice } from "@/types/diagnostics";
import { frontendLog } from "@/utils/frontendLog";
import { useDiagnosticsDialogStore } from "./diagnosticsDialogStore";
import { useBottomBannerSlot } from "@/components/BottomBanners";
import { errorMessage } from "@/utils/errorMessage";
import "./Diagnostics.css";

/**
 * Non-blocking notice shown on the first start after a crash (OBS-010).
 *
 * The check runs after mount and is never awaited by startup; a failure just
 * leaves the notice hidden. Any action (view, dismiss) marks the report as seen
 * so the notice appears once per crash. "Don't show again" persists
 * `showCrashReportNotice: false`, re-enabled from General settings.
 *
 * Two actions only (#5558): "View report" and "Close". Exporting lives in the
 * report viewer, where the user has seen what they would export; the opt-out is
 * a small inline link rather than a peer button. "View report" is a secondary
 * (not filled) button so the screen keeps a single filled primary (#5549).
 */
export function CrashReportNotice() {
  const enabled = useProjectedSettings().showCrashReportNotice ?? true;
  const updateSettings = useAppStore((s) => s.updateSettings);
  const setViewedReport = useDiagnosticsDialogStore((s) => s.setViewedReport);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getCrashReportNotice()
      .then((n) => {
        if (!cancelled) setNotice(n);
      })
      .catch((e) => frontendLog("crash_report", `notice check failed: ${errorMessage(e)}`));
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const dismiss = useCallback(() => {
    setNotice(null);
    acknowledgeCrashReports().catch((e) =>
      frontendLog("crash_report", `acknowledge failed: ${errorMessage(e)}`)
    );
  }, []);

  const handleView = useCallback(() => {
    if (notice) setViewedReport(notice.name);
    dismiss();
  }, [notice, setViewedReport, dismiss]);

  const handleNeverShow = useCallback(async () => {
    dismiss();
    try {
      await updateSettings({ ...currentSettingsView(), showCrashReportNotice: false });
    } catch (e) {
      frontendLog("crash_report", `persisting opt-out failed: ${errorMessage(e)}`);
    }
  }, [dismiss, updateSettings]);

  // #5548: the crash notice outranks every other bottom banner.
  const active = useBottomBannerSlot("crash-report", enabled && notice !== null);

  if (!enabled || !notice || !active) return null;

  return (
    <div className="crash-report-notice" role="status" data-testid="crash-report-notice">
      <span className="crash-report-notice__icon">
        <AlertTriangle size={16} />
      </span>
      <div className="crash-report-notice__text">
        <strong>termiHub closed unexpectedly last time.</strong>
        <span>
          A crash report was saved on this computer. Nothing was sent anywhere.
          <button
            type="button"
            className="crash-report-notice__never"
            onClick={handleNeverShow}
            data-testid="crash-report-notice-never"
          >
            Don't show again
          </button>
        </span>
      </div>
      <div className="crash-report-notice__actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={dismiss}
          data-testid="crash-report-notice-dismiss"
        >
          Close
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleView}
          data-testid="crash-report-notice-view"
        >
          View report
        </Button>
      </div>
    </div>
  );
}
