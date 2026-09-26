import { useEffect, useState } from "react";
import { Modal, Button } from "@/components/ui";
import { readCrashReport } from "@/services/api";
import { errorMessage } from "@/utils/errorMessage";
import { openDiagnosticsExport, useDiagnosticsDialogStore } from "./diagnosticsDialogStore";
import "./Diagnostics.css";

/**
 * Read-only view of one local crash report (OBS-010). The text on disk is
 * already redacted; it is shown as-is so the user sees exactly what an export
 * would contain.
 */
export function CrashReportViewer() {
  const name = useDiagnosticsDialogStore((s) => s.viewedReport);
  const setViewedReport = useDiagnosticsDialogStore((s) => s.setViewedReport);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setText(null);
    setError("");
    if (!name) return;
    let cancelled = false;
    readCrashReport(name)
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`Could not read the crash report: ${errorMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  const close = () => setViewedReport(null);

  return (
    <Modal
      open={name !== null}
      onOpenChange={(open) => !open && close()}
      size="lg"
      title="Crash Report"
      description="The locally stored, redacted crash report"
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
