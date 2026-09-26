import { useEffect, useMemo, useState } from "react";
import { Braces, ChevronDown, ChevronRight, Eye, RotateCcw, Trash2 } from "lucide-react";
import { Button, ConfirmDialog, toast } from "@/components/ui";
import { useNetworkToolHistoryStore } from "@/store/networkToolHistoryStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import type { NetworkHistoryTool, NetworkToolRun } from "@/types/network";
import { errorMessage } from "@/utils/errorMessage";
import { exportNetworkResults } from "./exportResults";
import { NetworkRunDetailDialog } from "./NetworkRunDetailDialog";
import { runsToJson } from "./runHistory";
import { formatRunTime, runLocationLabel, RUN_STATUS_LABEL, TOOL_LABEL } from "./runHistoryFormat";

interface NetworkToolHistoryProps {
  tool: NetworkHistoryTool;
  /**
   * Re-run a past invocation with its recorded params. Omit for a panel that
   * cannot re-run (the Re-run actions are then hidden).
   */
  onRerun?: (run: NetworkToolRun) => void;
  /** Disable Re-run while the panel is already running. */
  rerunDisabled?: boolean;
}

/**
 * Collapsible "History" section at the foot of a network-tool panel (PROD-032):
 * the tool's recorded runs, newest first, each openable read-only, re-runnable
 * with the same params, and deletable; plus export-all (JSON) and clear.
 *
 * History is stored locally only (it can contain hostnames and IP addresses);
 * recording can be turned off in Settings → Sessions.
 */
export function NetworkToolHistory({ tool, onRerun, rerunDisabled }: NetworkToolHistoryProps) {
  const allRuns = useNetworkToolHistoryStore((s) => s.runs);
  const loaded = useNetworkToolHistoryStore((s) => s.loaded);
  const load = useNetworkToolHistoryStore((s) => s.load);
  const remove = useNetworkToolHistoryStore((s) => s.remove);
  const clear = useNetworkToolHistoryStore((s) => s.clear);
  const enabled = useProjectedSettings().networkToolHistoryEnabled !== false;
  const { remoteAgents } = useProjectedAgents();

  const [expanded, setExpanded] = useState(false);
  const [viewing, setViewing] = useState<NetworkToolRun | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const runs = useMemo(() => allRuns.filter((r) => r.tool === tool), [allRuns, tool]);
  const agentNames = useMemo(
    () => Object.fromEntries(remoteAgents.map((a) => [a.id, a.name])),
    [remoteAgents]
  );

  const handleDelete = async (run: NetworkToolRun) => {
    try {
      await remove(run.id);
    } catch (err) {
      toast.error("Couldn't delete the run", { description: errorMessage(err) });
    }
  };

  const handleClear = async () => {
    try {
      await clear(tool);
      toast.success(`Cleared ${TOOL_LABEL[tool]} history`);
    } catch (err) {
      toast.error("Couldn't clear the history", { description: errorMessage(err) });
    } finally {
      setConfirmClear(false);
    }
  };

  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <section className="network-history" data-testid={`network-history-${tool}`}>
      <div className="network-history__header">
        <button
          type="button"
          className="network-history__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          data-testid="network-history-toggle"
        >
          <Chevron size={14} aria-hidden="true" />
          History ({runs.length})
        </button>
        {expanded && runs.length > 0 && (
          <div className="network-panel__actions">
            <Button
              variant="ghost"
              size="xs"
              icon={<Braces size={12} />}
              onClick={() => exportNetworkResults(`${tool}-history`, runsToJson(runs), "json")}
              data-testid="network-history-export"
            >
              Export
            </Button>
            <Button
              variant="ghost"
              size="xs"
              icon={<Trash2 size={12} />}
              onClick={() => setConfirmClear(true)}
              data-testid="network-history-clear"
            >
              Clear
            </Button>
          </div>
        )}
      </div>

      {expanded && (
        <>
          {!enabled && (
            <div className="network-panel__info" data-testid="network-history-disabled">
              Run history is off — new runs are not recorded. Turn it on in Settings → Sessions.
            </div>
          )}
          {runs.length === 0 ? (
            <div className="network-panel__placeholder" data-testid="network-history-empty">
              No recorded runs yet. Finished runs are kept here (stored only on this computer).
            </div>
          ) : (
            <ul className="network-history__list">
              {runs.map((run) => (
                <li key={run.id} className="network-history__row" data-testid="network-history-row">
                  <span
                    className={`network-history__status network-history__status--${run.status}`}
                  >
                    {RUN_STATUS_LABEL[run.status]}
                  </span>
                  <span className="network-history__time">{formatRunTime(run.startedAt)}</span>
                  <span className="network-history__summary" title={run.summary}>
                    {run.summary || "—"}
                  </span>
                  <span className="network-history__location">
                    {runLocationLabel(run.runLocation, agentNames)}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    iconOnly
                    icon={<Eye size={12} />}
                    aria-label="View run"
                    title="View run"
                    onClick={() => setViewing(run)}
                    data-testid="network-history-view"
                  />
                  {onRerun && (
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      icon={<RotateCcw size={12} />}
                      aria-label="Re-run with the same parameters"
                      title="Re-run with the same parameters"
                      disabled={rerunDisabled}
                      onClick={() => onRerun(run)}
                      data-testid="network-history-rerun"
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    iconOnly
                    icon={<Trash2 size={12} />}
                    aria-label="Delete run"
                    title="Delete run"
                    errorToast={false}
                    onClick={() => handleDelete(run)}
                    data-testid="network-history-delete"
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <NetworkRunDetailDialog
        run={viewing}
        agentNames={agentNames}
        onClose={() => setViewing(null)}
        onRerun={onRerun && !rerunDisabled ? onRerun : undefined}
      />

      <ConfirmDialog
        open={confirmClear}
        title={`Clear ${TOOL_LABEL[tool]} history?`}
        variant="danger"
        message={`Remove all ${runs.length} recorded ${TOOL_LABEL[tool]} run(s)? This cannot be undone.`}
        confirmLabel="Clear history"
        testIdBase="network-history-clear"
        onConfirm={handleClear}
        onCancel={() => setConfirmClear(false)}
      />
    </section>
  );
}
