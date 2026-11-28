import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { currentSettingsView } from "@/store/settingsBridge";
import { acknowledgeCrashReports, getCrashReportNotice } from "@/services/api";
import type { CrashReportNotice as Notice } from "@/types/diagnostics";
import { frontendLog } from "@/utils/frontendLog";
import { useDiagnosticsDialogStore } from "./diagnosticsDialogStore";
import {
  BottomBanner,
  BottomBannerAction,
  BottomBannerLink,
  useBottomBannerSlot,
  useBottomBannerStore,
} from "@/components/BottomBanners";
import { errorMessage } from "@/utils/errorMessage";
import { ICON_SIZE } from "@/components/ui/iconSize";
import "./Diagnostics.css";

/**
 * Non-blocking notice shown on the first start after a crash (OBS-010).
 *
 * The check runs after mount and is never awaited by startup; a failure just
 * leaves the notice hidden. Any action (view, dismiss) marks the report as seen
 * so the notice appears once per crash. The opt-out link persists
 * `showCrashReportNotice: false`, re-enabled from General settings.
 *
 * Actions (#5558, #5638, #5856): "View report" and "Close" in the shared
 * bottom-banner action row. Close is what most people want, so it is the main
 * (outlined, not filled, #5549) action on the right; View report is a ghost
 * button of the same size. Exporting lives in the report viewer, where the user
 * has seen what they would export. Turning the notices off is a small link
 * under the description that names its scope ("Don't tell me about future
 * crashes"), so it no longer sits first where the eye lands (R-086).
 */
/** The opt-out link, worded for its real scope: every future crash notice (R-086). */
export const CRASH_NOTICE_OPT_OUT_LABEL = "Don't tell me about future crashes";

export function CrashReportNotice() {
  const enabled = useProjectedSettings().showCrashReportNotice ?? true;
  const updateSettings = useAppStore((s) => s.updateSettings);
  const setViewedReport = useDiagnosticsDialogStore((s) => s.setViewedReport);
  const [notice, setNotice] = useState<Notice | null>(null);
  const markCrashChecked = useBottomBannerStore((s) => s.markCrashChecked);

  useEffect(() => {
    // #5753: the one-time file-manager offer waits for this check and stays
    // away for the whole session when it finds a crash.
    if (!enabled) {
      markCrashChecked("local", false);
      return;
    }
    let cancelled = false;
    getCrashReportNotice()
      .then((n) => {
        if (cancelled) return;
        markCrashChecked("local", n != null);
        setNotice(n);
      })
      .catch((e) => {
        markCrashChecked("local", false);
        frontendLog("crash_report", `notice check failed: ${errorMessage(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, markCrashChecked]);

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
    <BottomBanner
      tone="warning"
      role="status"
      data-testid="crash-report-notice"
      icon={<AlertTriangle size={ICON_SIZE.md} />}
      title="termiHub closed unexpectedly last time."
      description="A crash report was saved on this computer. Nothing was sent anywhere."
      footnote={
        <BottomBannerLink onClick={handleNeverShow} data-testid="crash-report-notice-never">
          {CRASH_NOTICE_OPT_OUT_LABEL}
        </BottomBannerLink>
      }
      actions={
        <>
          <BottomBannerAction onClick={handleView} data-testid="crash-report-notice-view">
            View report
          </BottomBannerAction>
          <BottomBannerAction main onClick={dismiss} data-testid="crash-report-notice-dismiss">
            Close
          </BottomBannerAction>
        </>
      }
    />
  );
}
