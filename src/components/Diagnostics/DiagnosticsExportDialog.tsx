import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Modal, Button, toast } from "@/components/ui";
import {
  exportDiagnosticsBundle,
  listAgentCrashReports,
  previewDiagnosticsBundle,
} from "@/services/api";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import type {
  AgentCrashReportRef,
  AgentCrashReports,
  DiagnosticsBundleEntry,
} from "@/types/diagnostics";
import { errorMessage } from "@/utils/errorMessage";
import { formatBytes } from "@/utils/formatters";
import { AgentCrashReportsSection, agentReportKey } from "./AgentCrashReportsSection";
import { useDiagnosticsDialogStore } from "./diagnosticsDialogStore";
import "./Diagnostics.css";

/** Default file name for a diagnostics bundle, dated so successive exports don't collide. */
export function defaultDiagnosticsFileName(now: Date = new Date()): string {
  return `termihub-diagnostics-${now.toISOString().slice(0, 10)}.zip`;
}

/** The remote reports that are still included (not excluded by the user). */
export function selectedAgentReports(
  agents: AgentCrashReports[] | null,
  excluded: ReadonlySet<string>
): AgentCrashReportRef[] {
  return (agents ?? []).flatMap((a) =>
    a.supported && !a.error
      ? a.reports
          .filter((r) => !excluded.has(agentReportKey(a.agentId, r.name)))
          .map((r) => ({ agentId: a.agentId, name: r.name }))
      : []
  );
}

/**
 * Help → "Export diagnostics" (OBS-010). Lists exactly which files the bundle
 * will contain — including crash reports of already-connected remote agents,
 * each of which the user can exclude (#3574) — then, only when the user
 * confirms and picks a destination in the save dialog, writes a redacted zip
 * there. Nothing is sent anywhere.
 */
export function DiagnosticsExportDialog() {
  const open = useDiagnosticsDialogStore((s) => s.exportOpen);
  const setOpen = useDiagnosticsDialogStore((s) => s.setExportOpen);
  const [entries, setEntries] = useState<DiagnosticsBundleEntry[] | null>(null);
  const [error, setError] = useState("");
  const [agentReports, setAgentReports] = useState<AgentCrashReports[] | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const { remoteAgents } = useProjectedAgents();

  useEffect(() => {
    setEntries(null);
    setError("");
    setAgentReports(null);
    setExcluded(new Set());
    if (!open) return;
    let cancelled = false;
    previewDiagnosticsBundle()
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`Could not list the diagnostics files: ${errorMessage(err)}`);
      });
    // Agent reports load separately so a slow agent never delays the preview.
    listAgentCrashReports()
      .then((list) => {
        if (!cancelled) setAgentReports(list);
      })
      .catch(() => {
        if (!cancelled) setAgentReports([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const agentName = useCallback(
    (agentId: string) => remoteAgents.find((a) => a.id === agentId)?.name ?? agentId,
    [remoteAgents]
  );

  const handleToggle = useCallback((key: string, include: boolean) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (include) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    const destination = await save({
      defaultPath: defaultDiagnosticsFileName(),
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (!destination) return;
    try {
      const result = await exportDiagnosticsBundle(
        destination,
        selectedAgentReports(agentReports, excluded)
      );
      toast.success(`Diagnostics saved (${result.fileCount} files)`, { description: result.path });
      setOpen(false);
    } catch (err) {
      const message = errorMessage(err);
      setError(`Export failed: ${message}`);
      throw err;
    }
  }, [setOpen, agentReports, excluded]);

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
      <AgentCrashReportsSection
        agents={agentReports}
        agentName={agentName}
        excluded={excluded}
        onToggle={handleToggle}
      />
      {error && (
        <p className="diagnostics__error" role="alert" data-testid="diagnostics-export-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
