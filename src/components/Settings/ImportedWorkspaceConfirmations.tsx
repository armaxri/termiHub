import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, ConfirmDialog, toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { loadWorkspace } from "@/services/workspaceApi";
import {
  collectImportedItems,
  importKeyKind,
  withImportsRevoked,
} from "@/services/workspaceImportTrust";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";
import { compareNames } from "@/utils/locale";
import type { WorkspaceSummary } from "@/types/workspace";

/** Where a confirmed key is held in a saved workspace. */
interface KeyUsage {
  workspaceName: string;
  kind: "command" | "connection";
  tabLabel: string;
  text: string;
}

/** One row of the list: a confirmed key and what it confirms in one workspace. */
interface ConfirmationRow {
  key: string;
  usage?: KeyUsage;
}

/** One workspace (or the "no longer used" bucket) and its confirmed rows. */
interface ConfirmationGroup {
  id: string;
  title: string;
  rows: ConfirmationRow[];
}

/** What the confirmation dialog would revoke. */
type PendingRevoke = { scope: "all" } | { scope: "one"; key: string; label: string };

/**
 * Hashes every held item of every saved workspace and maps each allowlist key to
 * the places it is used. Entries are content hashes, so this is the only way to
 * tell the user what a key confirms. A workspace that fails to load is skipped
 * (its keys then read as "no longer used", which revoking cannot make worse).
 */
async function resolveKeyUsage(
  workspaces: readonly WorkspaceSummary[]
): Promise<Map<string, KeyUsage[]>> {
  const usage = new Map<string, KeyUsage[]>();
  await Promise.all(
    workspaces.map(async (summary) => {
      let definition;
      try {
        definition = await loadWorkspace(summary.id);
      } catch (err) {
        frontendLog(
          "settings",
          `Imported confirmations: failed to load workspace ${summary.id}: ${errorMessage(err)}`
        );
        return;
      }
      if (!definition?.tabGroups) return;
      for (const item of collectImportedItems(definition.tabGroups)) {
        const key = await item.key();
        const entry: KeyUsage = {
          workspaceName: definition.name ?? summary.name,
          kind: item.kind,
          tabLabel: item.tabLabel,
          text: item.text,
        };
        usage.set(key, [...(usage.get(key) ?? []), entry]);
      }
    })
  );
  return usage;
}

function groupRows(
  allowlist: readonly string[],
  usage: Map<string, KeyUsage[]> | null
): ConfirmationGroup[] {
  const byWorkspace = new Map<string, ConfirmationRow[]>();
  const unused: ConfirmationRow[] = [];
  for (const key of allowlist) {
    const uses = usage?.get(key);
    if (!uses || uses.length === 0) {
      unused.push({ key });
      continue;
    }
    for (const use of uses) {
      byWorkspace.set(use.workspaceName, [
        ...(byWorkspace.get(use.workspaceName) ?? []),
        { key, usage: use },
      ]);
    }
  }
  const groups: ConfirmationGroup[] = [...byWorkspace.entries()]
    .sort(([a], [b]) => compareNames(a, b))
    .map(([name, rows]) => ({ id: `ws-${name}`, title: `Workspace “${name}”`, rows }));
  if (unused.length > 0) {
    groups.push({
      id: "unused",
      title: usage === null ? "Checking saved workspaces…" : "No longer used",
      rows: unused,
    });
  }
  return groups;
}

/** A short, human label for a key nobody uses any more (its hash prefix). */
function unusedLabel(key: string): string {
  const kind = importKeyKind(key);
  const hash = key.slice(key.indexOf(":") + 1, key.indexOf(":") + 13);
  const noun = kind === "command" ? "Command" : kind === "connection" ? "Connection" : "Entry";
  return `${noun} ${hash}…`;
}

function rowLabel(row: ConfirmationRow): string {
  return row.usage ? row.usage.text : unusedLabel(row.key);
}

/**
 * Settings → Security: the imported workspace commands and inline connection
 * configs confirmed on this machine (#4445, follow-up to #4434), with revoke-one
 * and revoke-all. Each entry is a content hash, so the list matches the keys
 * against the held items of the saved workspaces to show what they confirm;
 * keys no saved workspace holds any more read as "no longer used".
 *
 * Revoking only edits `workspaceImportAllowlist`: it takes effect the next time
 * a workspace launches, and the workspace editor shows the item as unconfirmed
 * again. Tabs already running keep what they were launched with.
 */
export function ImportedWorkspaceConfirmations() {
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);
  const workspaces = useAppStore((s) => s.workspaces);
  const allowlist = useMemo(
    () => settings.workspaceImportAllowlist ?? [],
    [settings.workspaceImportAllowlist]
  );
  const [usage, setUsage] = useState<Map<string, KeyUsage[]> | null>(null);
  const [pending, setPending] = useState<PendingRevoke | null>(null);

  const hasEntries = allowlist.length > 0;
  useEffect(() => {
    if (!hasEntries) return;
    let cancelled = false;
    void resolveKeyUsage(workspaces).then((resolved) => {
      if (!cancelled) setUsage(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaces, hasEntries]);

  const groups = useMemo(() => groupRows(allowlist, usage), [allowlist, usage]);

  const revoke = useCallback(async () => {
    if (!pending) return;
    const keys = pending.scope === "all" ? allowlist : [pending.key];
    await updateSettings({
      ...settings,
      workspaceImportAllowlist: withImportsRevoked(allowlist, keys),
    });
    setPending(null);
    toast.success(
      pending.scope === "all"
        ? "Revoked all imported workspace confirmations"
        : "Revoked the confirmation"
    );
  }, [pending, allowlist, settings, updateSettings]);

  const count = allowlist.length;

  return (
    <div className="settings-panel__section" data-testid="imported-confirmations">
      <div className="settings-panel__section-header">
        <h3 className="settings-panel__section-title">Imported Workspace Confirmations</h3>
        {hasEntries && (
          <div className="settings-panel__section-actions">
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 size={14} />}
              onClick={() => setPending({ scope: "all" })}
              data-testid="imported-confirmations-revoke-all"
            >
              Revoke All
            </Button>
          </div>
        )}
      </div>
      <p className="settings-panel__description">
        Commands and connections from an imported workspace do not run until you confirm them on
        this machine. Revoking a confirmation takes effect the next time a workspace launches; the
        item then waits for confirmation again.
      </p>
      <p className="settings-panel__description" data-testid="imported-confirmations-count">
        {count === 0
          ? "No imported commands or connections are confirmed on this machine."
          : `${count} imported ${count === 1 ? "item is" : "items are"} confirmed on this machine.`}
      </p>

      {groups.map((group) => (
        <div
          key={group.id}
          className="settings-panel__field"
          data-testid={`imported-confirmations-group-${group.id}`}
        >
          <span className="settings-panel__field-label">{group.title}</span>
          <ul className="settings-panel__list">
            {group.rows.map((row) => {
              const label = rowLabel(row);
              return (
                <li
                  key={`${group.id}-${row.key}-${row.usage?.tabLabel ?? ""}`}
                  className="settings-panel__list-item"
                  data-testid={`imported-confirmation-${row.key}`}
                >
                  <span className="settings-panel__list-item-body">
                    {row.usage && (
                      <span className="settings-panel__list-item-meta">
                        {row.usage.tabLabel} · {row.usage.kind === "command" ? "runs" : "opens"}
                      </span>
                    )}
                    <code>{label}</code>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<Trash2 size={14} />}
                    aria-label={`Revoke confirmation for ${label}`}
                    onClick={() => setPending({ scope: "one", key: row.key, label })}
                    data-testid={`imported-confirmation-revoke-${row.key}`}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <ConfirmDialog
        open={pending !== null}
        variant="warn"
        title={
          pending?.scope === "all"
            ? "Revoke all imported workspace confirmations?"
            : "Revoke this confirmation?"
        }
        message={
          pending?.scope === "all"
            ? `All ${count} confirmed imported ${count === 1 ? "item" : "items"} will wait for ` +
              "confirmation again the next time a workspace launches."
            : pending?.scope === "one"
              ? `"${pending.label}" will wait for confirmation again the next time a workspace ` +
                "launches. Every workspace holding the same item is affected."
              : undefined
        }
        confirmLabel={pending?.scope === "all" ? "Revoke All" : "Revoke"}
        onConfirm={revoke}
        onCancel={() => setPending(null)}
        testIdBase="imported-confirmations-dialog"
        data-testid="imported-confirmations-dialog"
      />
    </div>
  );
}
