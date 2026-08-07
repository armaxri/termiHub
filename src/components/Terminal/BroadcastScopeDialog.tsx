import { useEffect, useMemo, useState } from "react";
import { Modal, Button, Field, Select, Checkbox } from "@/components/ui";
import { useAppStore, resolveBroadcastTargetTabIds } from "@/store/appStore";
import { useProjectedBroadcast } from "@/store/useProjectedBroadcast";
import { getAllLeaves } from "@/utils/panelTree";
import type { BroadcastScope, ConnectionType, TerminalTab } from "@/types/terminal";
import "./BroadcastScopeDialog.css";

export interface BroadcastScopeDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when the dialog should open/close. */
  onOpenChange: (open: boolean) => void;
  /**
   * The tab that owns broadcast input (the terminal the user types into). The
   * dialog only opens with a valid terminal source; `null` renders nothing.
   */
  sourceTabId: string | null;
}

/** Short, human-readable label for a terminal's connection type (SSH/local/…). */
const TYPE_LABELS: Record<string, string> = {
  ssh: "SSH",
  local: "local",
  serial: "serial",
  telnet: "telnet",
  docker: "docker",
  remote: "remote",
  "remote-session": "remote",
};

function typeLabel(type: ConnectionType): string {
  return TYPE_LABELS[type] ?? String(type);
}

/**
 * Scope-selection flow shown when the user clicks the broadcast toolbar toggle
 * (#1956). Presents the three scopes — **All terminals**, **All in current
 * panel**, **Custom selection** — each with a live target count; picking
 * "Custom" reveals a per-terminal checkbox picker (Select All / Select None).
 * Non-terminal tabs (editors, SFTP) never appear. On confirm it resolves the
 * chosen scope to a concrete target set, starts broadcast, and persists the
 * scope as `lastBroadcastScope` (via `startBroadcast`).
 *
 * Composed from the shared UI primitives (Modal/Select/Checkbox/Button).
 */
export function BroadcastScopeDialog({
  open,
  onOpenChange,
  sourceTabId,
}: BroadcastScopeDialogProps) {
  const rootPanel = useAppStore((s) => s.rootPanel);
  const tabGroups = useAppStore((s) => s.tabGroups);
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId);
  // Remembered scope sourced from the authoritative broadcast region (#2206).
  const lastBroadcastScope = useProjectedBroadcast().lastScope;
  const startBroadcast = useAppStore((s) => s.startBroadcast);

  // Resolve broadcast membership against the source's own group tree (#1980),
  // not just the active `rootPanel`.
  const resolveState = useMemo(
    () => ({ tabGroups, activeTabGroupId, rootPanel }),
    [tabGroups, activeTabGroupId, rootPanel]
  );

  const [scope, setScope] = useState<BroadcastScope>(lastBroadcastScope);
  const [customSelected, setCustomSelected] = useState<Set<string>>(new Set());

  // Terminal tabs in the active group — the only broadcast-eligible tabs and the
  // rows of the custom picker. Non-terminal tabs are excluded here.
  const terminalTabs = useMemo<TerminalTab[]>(
    () =>
      getAllLeaves(rootPanel)
        .flatMap((leaf) => leaf.tabs)
        .filter((tab) => tab.contentType === "terminal"),
    [rootPanel]
  );

  // Reset to the remembered scope and pre-select every terminal each time the
  // dialog opens, so Custom starts as "everything" and Start is immediately
  // actionable.
  useEffect(() => {
    if (open) {
      setScope(lastBroadcastScope);
      setCustomSelected(new Set(terminalTabs.map((t) => t.id)));
    }
  }, [open, lastBroadcastScope, terminalTabs]);

  const allCount = useMemo(
    () => (sourceTabId ? resolveBroadcastTargetTabIds(resolveState, "all", sourceTabId).length : 0),
    [resolveState, sourceTabId]
  );
  const panelCount = useMemo(
    () =>
      sourceTabId ? resolveBroadcastTargetTabIds(resolveState, "panel", sourceTabId).length : 0,
    [resolveState, sourceTabId]
  );

  const scopeOptions = useMemo(
    () => [
      { value: "all", label: `All terminals (${allCount})` },
      { value: "panel", label: `All in current panel (${panelCount})` },
      { value: "custom", label: "Custom selection…" },
    ],
    [allCount, panelCount]
  );

  // The concrete target set the chosen scope resolves to.
  const resolvedTargets = useMemo<string[]>(() => {
    if (!sourceTabId) return [];
    if (scope === "custom") {
      const terminalIds = new Set(terminalTabs.map((t) => t.id));
      return [...customSelected].filter((id) => terminalIds.has(id));
    }
    return resolveBroadcastTargetTabIds(resolveState, scope, sourceTabId);
  }, [scope, sourceTabId, resolveState, customSelected, terminalTabs]);

  const canStart = sourceTabId !== null && resolvedTargets.length > 0;

  const toggleCustom = (tabId: string, checked: boolean) => {
    setCustomSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  };

  const handleStart = () => {
    if (!sourceTabId || !canStart) return;
    startBroadcast(scope, sourceTabId, resolvedTargets);
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Broadcast Input"
      description="Choose which terminals receive broadcast input"
      onKeyDown={(e) => {
        if (e.key === "Enter" && canStart) handleStart();
      }}
      data-testid="broadcast-scope-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="broadcast-scope-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleStart}
            disabled={!canStart}
            data-testid="broadcast-scope-confirm"
          >
            Start Broadcast
          </Button>
        </>
      }
    >
      <Field label="Broadcast to" htmlFor="broadcast-scope-select">
        <Select
          value={scope}
          onChange={(v) => setScope(v as BroadcastScope)}
          options={scopeOptions}
          aria-label="Broadcast scope"
          data-testid="broadcast-scope-select"
        />
      </Field>

      {scope === "custom" && (
        <div className="broadcast-scope-dialog__custom">
          <div className="broadcast-scope-dialog__custom-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCustomSelected(new Set(terminalTabs.map((t) => t.id)))}
              data-testid="broadcast-scope-select-all"
            >
              Select All
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCustomSelected(new Set())}
              data-testid="broadcast-scope-select-none"
            >
              Select None
            </Button>
          </div>
          {terminalTabs.length === 0 ? (
            <p className="broadcast-scope-dialog__empty" role="status">
              No terminal sessions to broadcast to.
            </p>
          ) : (
            <ul className="broadcast-scope-dialog__list">
              {terminalTabs.map((tab) => {
                const rowId = `broadcast-target-${tab.id}`;
                return (
                  <li key={tab.id} className="broadcast-scope-dialog__row">
                    <Checkbox
                      id={rowId}
                      checked={customSelected.has(tab.id)}
                      onCheckedChange={(checked) => toggleCustom(tab.id, checked)}
                      data-testid={`broadcast-target-${tab.id}`}
                    />
                    <label htmlFor={rowId} className="broadcast-scope-dialog__row-label">
                      <span className="broadcast-scope-dialog__row-title">{tab.title}</span>
                      <span className="broadcast-scope-dialog__row-type">
                        {typeLabel(tab.connectionType)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
