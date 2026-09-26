import { useEffect, useState } from "react";
import { Modal, Button } from "@/components/ui";
import { readAgentCrashReport, readCrashReport } from "@/services/api";
import { errorMessage } from "@/utils/errorMessage";
import { openDiagnosticsExport, useDiagnosticsDialogStore } from "./diagnosticsDialogStore";
import "./Diagnostics.css";

/**
 * Read-only view of one crash report (OBS-010): a local one (already redacted
 * on disk), or one on a connected remote agent (#3593), read over the existing
 * connection and redacted again on this computer. Shown as-is so the user sees
 * exactly what an export would contain.
 */
export function CrashReportViewer() {
  const name = useDiagnosticsDialogStore((s) => s.viewedReport);
  const agentReport = useDiagnosticsDialogStore((s) => s.viewedAgentReport);
  const setViewedReport = useDiagnosticsDialogStore((s) => s.setViewedReport);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const agentId = agentReport?.agentId ?? null;
  const agentReportName = agentReport?.name ?? null;

  useEffect(() => {
    setText(null);
    setError("");
    let read: Promise<string>;
    if (agentId && agentReportName) read = readAgentCrashReport(agentId, agentReportName);
    else if (name) read = readCrashReport(name);
    else return;
    let cancelled = false;
    read
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`Could not read the crash report: ${errorMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [name, agentId, agentReportName]);

  const close = () => setViewedReport(null);

  return (
    <Modal
      open={name !== null || agentReport !== null}
      onOpenChange={(open) => !open && close()}
      size="lg"
      title="Crash Report"
      description={
        agentReport
          ? "A crash report from a connected agent, redacted again on this computer"
          : "The locally stored, redacted crash report"
      }
      data-testid="crash-report-viewer"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              close();
              openDiagnosticsExport();
            }}
            data-testid="crash-report-viewer-export"
          >
            Export Diagnostics…
          </Button>
        </>
      }
    >
      {error ? (
        <p className="diagnostics__error" role="alert">
          {error}
        </p>
      ) : (
        <pre className="diagnostics__report" data-testid="crash-report-viewer-text">
          {text ?? "Loading…"}
        </pre>
      )}
    </Modal>
  );
}
