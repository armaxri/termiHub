import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { Button } from "@/components/ui";
import { acknowledgeAgentCrashNotice, getAgentCrashNotices } from "@/services/api";
import { onAgentCrashNoticesChanged } from "@/services/events";
import type { AgentCrashNotice } from "@/types/diagnostics";
import { frontendLog } from "@/utils/frontendLog";
import { openDiagnosticsExport, useDiagnosticsDialogStore } from "./diagnosticsDialogStore";
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
 * mount and follows the push. Any action (view, export, dismiss) acknowledges
 * the report, so the same crash is never announced twice. Honours the shared
 * `showCrashReportNotice` opt-out (the backend then does not check at all).
 */
export function AgentCrashReportNotice() {
  const enabled = useProjectedSettings().showCrashReportNotice ?? true;
  const { remoteAgents } = useProjectedAgents();
  const setViewedAgentReport = useDiagnosticsDialogStore((s) => s.setViewedAgentReport);
  const [notices, setNotices] = useState<AgentCrashNotice[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    getAgentCrashNotices()
      .then((list) => {
        if (!cancelled) setNotices(asList(list));
      })
      .catch((e) => frontendLog("crash_report", `agent notice check failed: ${String(e)}`));
    onAgentCrashNoticesChanged((list) => setNotices(asList(list)))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => frontendLog("crash_report", `agent notice subscribe failed: ${String(e)}`));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled]);

  const dismiss = useCallback((notice: AgentCrashNotice) => {
    setNotices((prev) => prev.filter((n) => n.agentId !== notice.agentId));
    acknowledgeAgentCrashNotice(notice.agentId, notice.name).catch((e) =>
      frontendLog("crash_report", `agent acknowledge failed: ${String(e)}`)
    );
  }, []);

  const handleView = useCallback(
    (notice: AgentCrashNotice) => {
      setViewedAgentReport({ agentId: notice.agentId, name: notice.name });
      dismiss(notice);
    },
    [setViewedAgentReport, dismiss]
  );

  const handleExport = useCallback(
    (notice: AgentCrashNotice) => {
      openDiagnosticsExport();
      dismiss(notice);
    },
    [dismiss]
  );

  if (!enabled || notices.length === 0) return null;

  const agentName = (id: string) => remoteAgents.find((a) => a.id === id)?.name ?? id;

  return (
    <>
      {notices.map((notice) => (
        <div
          key={notice.agentId}
          className="crash-report-notice"
          role="status"
          data-testid={`agent-crash-notice-${notice.agentId}`}
        >
          <span className="crash-report-notice__icon">
            <AlertTriangle size={16} />
          </span>
          <div className="crash-report-notice__text">
            <strong>
              Agent “{agentName(notice.agentId)}” crashed since it was last connected.
            </strong>
            <span>
              {notice.newCount === 1
                ? "A new crash report was saved on that host."
                : `${notice.newCount} new crash reports were saved on that host.`}{" "}
              Nothing was sent anywhere.
            </span>
          </div>
          <div className="crash-report-notice__actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dismiss(notice)}
              data-testid={`agent-crash-notice-dismiss-${notice.agentId}`}
            >
              Dismiss
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleExport(notice)}
              data-testid={`agent-crash-notice-export-${notice.agentId}`}
            >
              Export Diagnostics…
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => handleView(notice)}
              data-testid={`agent-crash-notice-view-${notice.agentId}`}
            >
              View Report
            </Button>
          </div>
        </div>
      ))}
    </>
  );
}
