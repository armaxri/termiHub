import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { acknowledgeAgentCrashNotice, getAgentCrashNotices } from "@/services/api";
import { onAgentCrashNoticesChanged } from "@/services/events";
import type { AgentCrashNotice } from "@/types/diagnostics";
import { frontendLog } from "@/utils/frontendLog";
import { useDiagnosticsDialogStore } from "./diagnosticsDialogStore";
import {
  BottomBanner,
  BottomBannerAction,
  useBottomBannerSlot,
  useBottomBannerStore,
} from "@/components/BottomBanners";
import { errorMessage } from "@/utils/errorMessage";
import "./Diagnostics.css";

/** Treat a missing or malformed reply as "no notices" rather than crash. */
function asList(list: AgentCrashNotice[] | null | undefined): AgentCrashNotice[] {
  return Array.isArray(list) ? list : [];
}

/**
 * Non-blocking notices for remote agents that crashed since they were last
 * connected (#3593) — one per agent, styled like the local crash notice.
 *
 * The backend checks an agent once after each (re)connect, off the connect
 * path, and pushes the pending list; this component only fetches that list on
 * mount and follows the push. Any action (view, dismiss) acknowledges
 * the report, so the same crash is never announced twice. Honours the shared
 * `showCrashReportNotice` opt-out (the backend then does not check at all).
 *
 * Only the first pending notice is shown; closing it reveals the next (#5548).
 * Like the local notice it offers "View report" and "Close" only (#5558) —
 * exporting lives in the report viewer.
 */
export function AgentCrashReportNotice() {
  const enabled = useProjectedSettings().showCrashReportNotice ?? true;
  const { remoteAgents } = useProjectedAgents();
  const setViewedAgentReport = useDiagnosticsDialogStore((s) => s.setViewedAgentReport);
  const [notices, setNotices] = useState<AgentCrashNotice[]>([]);
  const markCrashChecked = useBottomBannerStore((s) => s.markCrashChecked);

  useEffect(() => {
    // #5753: the one-time file-manager offer waits for this check and stays
    // away for the whole session when a crash notice shows (also a later one,
    // pushed after an agent connects — see useBottomBannerSlot).
    if (!enabled) {
      markCrashChecked("agent", false);
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    getAgentCrashNotices()
      .then((list) => {
        if (cancelled) return;
        const pending = asList(list);
        markCrashChecked("agent", pending.length > 0);
        setNotices(pending);
      })
      .catch((e) => {
        markCrashChecked("agent", false);
        frontendLog("crash_report", `agent notice check failed: ${errorMessage(e)}`);
      });
    onAgentCrashNoticesChanged((list) => setNotices(asList(list)))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) =>
        frontendLog("crash_report", `agent notice subscribe failed: ${errorMessage(e)}`)
      );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled, markCrashChecked]);

  const dismiss = useCallback((notice: AgentCrashNotice) => {
    setNotices((prev) => prev.filter((n) => n.agentId !== notice.agentId));
    acknowledgeAgentCrashNotice(notice.agentId, notice.name).catch((e) =>
      frontendLog("crash_report", `agent acknowledge failed: ${errorMessage(e)}`)
    );
  }, []);

  const handleView = useCallback(
    (notice: AgentCrashNotice) => {
      setViewedAgentReport({ agentId: notice.agentId, name: notice.name });
      dismiss(notice);
    },
    [setViewedAgentReport, dismiss]
  );

  // #5548: one bottom banner at a time — agent crash notices rank below the
  // local crash notice and above promotional prompts, and show one by one.
  const active = useBottomBannerSlot("agent-crash-report", enabled && notices.length > 0);

  if (!enabled || notices.length === 0 || !active) return null;

  const agentName = (id: string) => remoteAgents.find((a) => a.id === id)?.name ?? id;

  const notice = notices[0];

  return (
    <BottomBanner
      tone="warning"
      role="status"
      data-testid={`agent-crash-notice-${notice.agentId}`}
      icon={<AlertTriangle size={16} />}
      title={<>Agent “{agentName(notice.agentId)}” crashed since it was last connected.</>}
      description={
        <>
          {notice.newCount === 1
            ? "A new crash report was saved on that host."
            : `${notice.newCount} new crash reports were saved on that host.`}{" "}
          Nothing was sent anywhere.
        </>
      }
      actions={
        <>
          <BottomBannerAction
            onClick={() => dismiss(notice)}
            data-testid={`agent-crash-notice-dismiss-${notice.agentId}`}
          >
            Close
          </BottomBannerAction>
          <BottomBannerAction
            main
            onClick={() => handleView(notice)}
            data-testid={`agent-crash-notice-view-${notice.agentId}`}
          >
            View report
          </BottomBannerAction>
        </>
      }
    />
  );
}
