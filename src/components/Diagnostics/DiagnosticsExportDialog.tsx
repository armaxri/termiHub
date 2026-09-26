import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Modal, Button, toast } from "@/components/ui";
import { exportDiagnosticsBundle, previewDiagnosticsBundle } from "@/services/api";
import type { DiagnosticsBundleEntry } from "@/types/diagnostics";
import { errorMessage } from "@/utils/errorMessage";
import { formatBytes } from "@/utils/formatters";
import { useDiagnosticsDialogStore } from "./diagnosticsDialogStore";
import "./Diagnostics.css";

/** Default file name for a diagnostics bundle, dated so successive exports don't collide. */
export function defaultDiagnosticsFileName(now: Date = new Date()): string {
  return `termihub-diagnostics-${now.toISOString().slice(0, 10)}.zip`;
}

/**
 * Help → "Export diagnostics" (OBS-010). Lists exactly which files the bundle
 * will contain, then — only when the user confirms and picks a destination in
 * the save dialog — writes a redacted zip there. Nothing is sent anywhere.
 */
export function DiagnosticsExportDialog() {
  const open = useDiagnosticsDialogStore((s) => s.exportOpen);
  const setOpen = useDiagnosticsDialogStore((s) => s.setExportOpen);
  const [entries, setEntries] = useState<DiagnosticsBundleEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setEntries(null);
    setError("");
    if (!open) return;
    let cancelled = false;
    previewDiagnosticsBundle()
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`Could not list the diagnostics files: ${errorMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSave = useCallback(async () => {
    const destination = await save({
      defaultPath: defaultDiagnosticsFileName(),
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (!destination) return;
    try {
      const result = await exportDiagnosticsBundle(destination);
      toast.success(`Diagnostics saved (${result.fileCount} files)`, { description: result.path });
      setOpen(false);
    } catch (err) {
      const message = errorMessage(err);
      setError(`Export failed: ${message}`);
      throw err;
    }
  }, [setOpen]);

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      size="lg"
      title="Export Diagnostics"
      description="Choose where to save a redacted diagnostics bundle"
      data-testid="diagnostics-export-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            errorToast={false}
            pendingLabel="Saving…"
            disabled={entries === null}
            data-testid="diagnostics-export-save"
          >
            Save…
          </Button>
        </>
      }
    >
      <p className="diagnostics__note">
        termiHub never sends diagnostics anywhere. This creates a zip on your computer that you can
        attach to a bug report. Credentials, host names, IP addresses, usernames and home paths are
        redacted; terminal session content is never included.
      </p>
      <p className="diagnostics__note">The bundle will contain:</p>
      {entries === null && !error && <p className="diagnostics__note">Gathering files…</p>}
      {entries && (
        <ul className="diagnostics__list" data-testid="diagnostics-export-files">
          {entries.map((e) => (
            <li key={e.name} className="diagnostics__row">
              <span className="diagnostics__name">{e.name}</span>
              <span className="diagnostics__meta">
                {e.description} · {formatBytes(e.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="diagnostics__error" role="alert" data-testid="diagnostics-export-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
