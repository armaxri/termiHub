import { useEffect, useMemo, useState } from "react";
import { Modal, Button, Field, Select, Checkbox, EmptyState, toast } from "@/components/ui";
import { useAppStore, resolveBroadcastTargetTabIds } from "@/store/appStore";
import {
  useActiveTabGroupId,
  useLayoutRenderTree,
  useLayoutTabGroups,
} from "@/store/layoutSelectors";
import { useProjectedBroadcast } from "@/store/useProjectedBroadcast";
import { deleteBroadcastGroup, useBroadcastGroups } from "@/store/broadcastGroups";
import { groupableConnectionIds, resolveBroadcastGroup } from "@/utils/broadcastGroups";
import { errorMessage } from "@/utils/errorMessage";
import { BroadcastGroupSaveRow } from "./BroadcastGroupSaveRow";
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

/** Select-value prefix for a saved named broadcast group (PROD-061). */
const GROUP_PREFIX = "group:";

/**
 * Scope-selection flow shown when the user clicks the broadcast toolbar toggle
 * (#1956). Presents the three scopes — **All terminals**, **All in current
 * panel**, **Custom selection** — each with a live target count; picking
 * "Custom" reveals a per-terminal checkbox picker (Select All / Select None).
 * Non-terminal tabs (editors, SFTP) never appear. On confirm it resolves the
 * chosen scope to a concrete target set, starts broadcast, and persists the
 * scope as `lastBroadcastScope` (via `startBroadcast`).
 *
 * Saved named broadcast groups (PROD-061, #3443) appear as extra scopes: a
 * group resolves to the open terminals of its saved connections and starts a
 * frozen (`custom`) broadcast, listing exactly which terminals receive input and
 * which members are not open. The custom picker can save its selection as a
 * group.
 *
 * Composed from the shared UI primitives (Modal/Select/Checkbox/Button).
 */
export function BroadcastScopeDialog({
  open,
  onOpenChange,
  sourceTabId,
}: BroadcastScopeDialogProps) {
  const rootPanel = useLayoutRenderTree();
  const tabGroups = useLayoutTabGroups();
  const activeTabGroupId = useActiveTabGroupId();
  // Remembered scope sourced from the authoritative broadcast region (#2206).
  const lastBroadcastScope = useProjectedBroadcast().lastScope;
  const startBroadcast = useAppStore((s) => s.startBroadcast);

  // Resolve broadcast membership against the source's own group tree (#1980),
  // not just the active `rootPanel`.
  const resolveState = useMemo(
    () => ({ tabGroups, activeTabGroupId, rootPanel }),
    [tabGroups, activeTabGroupId, rootPanel]
  );

  const groups = useBroadcastGroups();
  // `all` / `panel` / `custom`, or `group:<id>` for a saved named group.
  const [scopeValue, setScopeValue] = useState<string>(lastBroadcastScope);
  const isGroupScope = scopeValue.startsWith(GROUP_PREFIX);
  const selectedGroup = isGroupScope
    ? (groups.find((g) => `${GROUP_PREFIX}${g.id}` === scopeValue) ?? null)
    : null;
  // A named group broadcasts as a frozen custom selection (no auto-joining).
  const scope: BroadcastScope = isGroupScope ? "custom" : (scopeValue as BroadcastScope);
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
      setScopeValue(lastBroadcastScope);
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
      ...groups.map((g) => ({
        value: `${GROUP_PREFIX}${g.id}`,
        label: `Group "${g.name}" (${resolveBroadcastGroup(terminalTabs, g).tabIds.length} open)`,
      })),
    ],
    [allCount, panelCount, groups, terminalTabs]
  );

  const groupResolution = useMemo(
    () => (selectedGroup ? resolveBroadcastGroup(terminalTabs, selectedGroup) : null),
    [selectedGroup, terminalTabs]
  );

  // The concrete target set the chosen scope resolves to.
  const resolvedTargets = useMemo<string[]>(() => {
    if (!sourceTabId) return [];
    // A group that vanished (deleted in another window) resolves to nothing —
    // never silently to a broader scope.
    if (isGroupScope) return groupResolution?.tabIds ?? [];
    if (scope === "custom") {
      const terminalIds = new Set(terminalTabs.map((t) => t.id));
      return [...customSelected].filter((id) => terminalIds.has(id));
    }
    return resolveBroadcastTargetTabIds(resolveState, scope, sourceTabId);
  }, [
    scope,
    sourceTabId,
    resolveState,
    customSelected,
    terminalTabs,
    groupResolution,
    isGroupScope,
  ]);

  const groupable = useMemo(
    () => groupableConnectionIds(terminalTabs, customSelected),
    [terminalTabs, customSelected]
  );
  const titleOf = (tabId: string) => terminalTabs.find((t) => t.id === tabId)?.title ?? tabId;

  const canStart = sourceTabId !== null && resolvedTargets.length > 0;

  const toggleCustom = (tabId: string, checked: boolean) => {
    setCustomSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  };

  const handleDeleteGroup = async () => {
    if (!selectedGroup) return;
    try {
      await deleteBroadcastGroup(selectedGroup.id);
      toast.success(`Deleted broadcast group "${selectedGroup.name}"`);
      setScopeValue("custom");
    } catch (err) {
      toast.error(`Failed to delete broadcast group: ${errorMessage(err)}`);
    }
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
        // Enter a focused control already consumed (opening the scope Select,
        // saving a group name) must not also start broadcasting.
        if (e.defaultPrevented) return;
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
            {`Start Broadcast (${resolvedTargets.length + (sourceTabId && !resolvedTargets.includes(sourceTabId) ? 1 : 0)})`}
          </Button>
        </>
      }
    >
      <Field label="Broadcast to" htmlFor="broadcast-scope-select">
        <Select
          value={scopeValue}
          onChange={setScopeValue}
          options={scopeOptions}
          aria-label="Broadcast scope"
          data-testid="broadcast-scope-select"
        />
      </Field>

      {selectedGroup && groupResolution && (
        <div className="broadcast-scope-dialog__custom" data-testid="broadcast-group-summary">
          {groupResolution.tabIds.length === 0 ? (
            <EmptyState title="None of this group's connections are open in this tab group." />
          ) : (
            <ul className="broadcast-scope-dialog__list" data-testid="broadcast-group-members">
              {groupResolution.tabIds.map((tabId) => (
                <li key={tabId} className="broadcast-scope-dialog__row">
                  <span className="broadcast-scope-dialog__row-title">{titleOf(tabId)}</span>
                </li>
              ))}
            </ul>
          )}
          {groupResolution.missingConnectionIds.length > 0 && (
            <p className="broadcast-scope-dialog__note" role="status">
              {`${groupResolution.missingConnectionIds.length} saved connection${
                groupResolution.missingConnectionIds.length === 1 ? " is" : "s are"
              } not open and will not receive input.`}
            </p>
          )}
          {sourceTabId && !groupResolution.tabIds.includes(sourceTabId) && (
            <p className="broadcast-scope-dialog__note" role="status">
              {`You type in "${titleOf(sourceTabId)}", which is not in this group — it receives the input too.`}
            </p>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDeleteGroup}
            data-testid="broadcast-group-delete"
          >
            Delete group
          </Button>
        </div>
      )}

      {scope === "custom" && !isGroupScope && (
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
            <EmptyState title="No terminal sessions to broadcast to." />
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
          <BroadcastGroupSaveRow
            connectionIds={groupable.connectionIds}
            unsavedCount={groupable.unsavedCount}
            onSaved={(group) => setScopeValue(`${GROUP_PREFIX}${group.id}`)}
          />
        </div>
      )}
    </Modal>
  );
}
