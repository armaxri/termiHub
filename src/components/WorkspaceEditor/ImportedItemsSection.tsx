import { useEffect, useMemo, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Button, toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import {
  describeImportedConnection,
  importedCommandKey,
  importedConnectionKey,
  isImportConfirmed,
  withImportConfirmed,
} from "@/services/workspaceImportTrust";
import { getWorkspaceLeaves } from "@/utils/workspaceLayout";
import type { WorkspaceTabGroupDef } from "@/types/workspace";
import "./ImportedItemsSection.css";

interface ImportedItemsSectionProps {
  /** The workspace's tab groups as currently edited. */
  tabGroupDefs: WorkspaceTabGroupDef[];
}

interface ImportedItem {
  id: string;
  kind: "command" | "connection";
  tabLabel: string;
  /** What runs or opens, shown verbatim. */
  text: string;
  /** Resolves to the allowlist key for this item. */
  key: () => Promise<string>;
}

function collectItems(groups: WorkspaceTabGroupDef[]): ImportedItem[] {
  const items: ImportedItem[] = [];
  groups.forEach((group, g) => {
    getWorkspaceLeaves(group.layout).forEach((leaf, l) => {
      leaf.tabs.forEach((tab, t) => {
        const tabLabel = `${tab.title ?? "Tab"} (${group.name})`;
        const base = `${g}-${l}-${t}`;
        if (tab.inlineConfigUnconfirmed && tab.inlineConfig) {
          const inline = tab.inlineConfig;
          const summary = describeImportedConnection(inline);
          const parts = [summary.type, summary.target].filter(Boolean).join(" ");
          const runs = summary.embeddedCommand ? ` (runs "${summary.embeddedCommand}")` : "";
          items.push({
            id: `${base}-conn`,
            kind: "connection",
            tabLabel,
            text: parts + runs,
            key: () => importedConnectionKey(inline),
          });
        }
        if (tab.pendingInitialCommand) {
          const command = tab.pendingInitialCommand;
          items.push({
            id: `${base}-cmd`,
            kind: "command",
            tabLabel,
            text: command,
            key: () => importedCommandKey(command),
          });
        }
      });
    });
  });
  return items;
}

/**
 * Lists the commands and inline connections an imported workspace carries
 * (#4434) with whether each is confirmed on this machine, and lets the user
 * confirm them here before launching. Confirming records the exact text (or
 * connection config) in the machine-local `workspaceImportAllowlist`; editing
 * it later needs a new confirmation. Renders nothing for a workspace with no
 * imported items, so locally created workspaces are unaffected.
 */
export function ImportedItemsSection({ tabGroupDefs }: ImportedItemsSectionProps) {
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);
  const items = useMemo(() => collectItems(tabGroupDefs), [tabGroupDefs]);
  const [keys, setKeys] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void Promise.all(items.map(async (item) => [item.id, await item.key()] as const)).then(
      (pairs) => {
        if (!cancelled) setKeys(Object.fromEntries(pairs));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [items]);

  if (items.length === 0) return null;

  const confirm = async (item: ImportedItem) => {
    const key = keys[item.id] ?? (await item.key());
    await updateSettings({
      ...settings,
      workspaceImportAllowlist: withImportConfirmed(settings.workspaceImportAllowlist, key),
    });
    toast.success(
      item.kind === "command" ? "Command confirmed on this machine" : "Connection confirmed"
    );
  };

  return (
    <section className="imported-items" data-testid="workspace-imported-items">
      <div className="imported-items__header">
        <span className="workspace-editor__label">Imported commands and connections</span>
        <span className="imported-items__hint">
          This workspace was imported. These do not run or connect until you confirm them on this
          machine. Changing one needs a new confirmation.
        </span>
      </div>
      <ul className="imported-items__list">
        {items.map((item) => {
          const key = keys[item.id];
          const confirmed =
            key !== undefined && isImportConfirmed(settings.workspaceImportAllowlist, key);
          return (
            <li
              key={item.id}
              className="imported-items__row"
              data-testid={`workspace-imported-item-${item.id}`}
            >
              {confirmed ? (
                <ShieldCheck size={14} className="imported-items__icon--ok" aria-hidden />
              ) : (
                <ShieldAlert size={14} className="imported-items__icon--warn" aria-hidden />
              )}
              <div className="imported-items__body">
                <span className="imported-items__tab">
                  {item.tabLabel} · {item.kind === "command" ? "runs" : "opens"}
                </span>
                <code className="imported-items__text">{item.text}</code>
              </div>
              {confirmed ? (
                <span className="imported-items__status">Confirmed on this machine</span>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={key === undefined}
                  onClick={() => confirm(item)}
                  data-testid={`workspace-imported-confirm-${item.id}`}
                >
                  Confirm
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
