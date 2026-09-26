import { Braces, Download, RotateCcw } from "lucide-react";
import { Button, Modal } from "@/components/ui";
import type { NetworkToolRun } from "@/types/network";
import { DiagnosticResultsTable } from "./DiagnosticResultsTable";
import { exportNetworkResults } from "./exportResults";
import { runToCsv, runsToJson } from "./runHistory";
import { formatRunTime, runLocationLabel, RUN_STATUS_LABEL, TOOL_LABEL } from "./runHistoryFormat";

interface NetworkRunDetailDialogProps {
  /** The run to show; the dialog is closed when `null`. */
  run: NetworkToolRun | null;
  /** Agent id → display name, for the "Ran on" line. */
  agentNames: Record<string, string>;
  onClose: () => void;
  /** Re-run with the recorded params; omitted when the panel cannot re-run. */
  onRerun?: (run: NetworkToolRun) => void;
}

/**
 * Read-only view of one recorded network-tool run (PROD-032): when and where it
 * ran, with which parameters, how it ended, and its stored result table —
 * exportable as CSV or JSON, and re-runnable with the same parameters.
 */
export function NetworkRunDetailDialog({
  run,
  agentNames,
  onClose,
  onRerun,
}: NetworkRunDetailDialogProps) {
  if (!run) return null;

  const baseName = `${run.tool}-${run.startedAt.slice(0, 19)}`;
  const result = run.result;
  const columns = (result?.columns ?? []).map((label, i) => ({ key: String(i), label }));
  const rows = (result?.rows ?? []).map((row) =>
    Object.fromEntries(row.map((cell, i) => [String(i), cell == null ? null : String(cell)]))
  );
  const trimmed = result != null && result.totalRows > result.rows.length;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`${TOOL_LABEL[run.tool]} run`}
      description="A recorded network tool run (read-only)"
      size="lg"
      data-testid="network-run-detail"
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            icon={<Download size={14} />}
            disabled={!result}
            onClick={() => exportNetworkResults(baseName, runToCsv(run))}
            data-testid="network-run-detail-export-csv"
          >
            Export CSV
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Braces size={14} />}
            onClick={() => exportNetworkResults(baseName, runsToJson([run]), "json")}
            data-testid="network-run-detail-export-json"
          >
            Export JSON
          </Button>
          {onRerun && (
            <Button
              variant="primary"
              size="sm"
              icon={<RotateCcw size={14} />}
              onClick={() => {
                onRerun(run);
                onClose();
              }}
              data-testid="network-run-detail-rerun"
            >
              Re-run
            </Button>
          )}
        </>
      }
    >
      <dl className="network-run-detail__meta">
        <dt>Started</dt>
        <dd>{formatRunTime(run.startedAt)}</dd>
        <dt>Ended</dt>
        <dd>{formatRunTime(run.endedAt)}</dd>
        <dt>Ran on</dt>
        <dd>{runLocationLabel(run.runLocation, agentNames)}</dd>
        <dt>Status</dt>
        <dd data-testid="network-run-detail-status">{RUN_STATUS_LABEL[run.status]}</dd>
        {Object.entries(run.params).map(([key, value]) => (
          <div key={key} className="network-run-detail__param">
            <dt>{key}</dt>
            <dd>{value == null || value === "" ? "—" : String(value)}</dd>
          </div>
        ))}
      </dl>
      {run.summary && (
        <div className="network-panel__stats" data-testid="network-run-detail-summary">
          {run.summary}
        </div>
      )}
      {run.error && <div className="network-panel__error">{run.error}</div>}
      <DiagnosticResultsTable
        columns={columns}
        rows={rows}
        rowTestIdPrefix="network-run-detail-row"
        footer={
          trimmed
            ? `Showing the first ${result.rows.length} of ${result.totalRows} rows (history keeps a bounded copy)`
            : null
        }
      />
    </Modal>
  );
}
