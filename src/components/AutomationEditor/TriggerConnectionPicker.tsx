import { useId } from "react";
import { DeletedConnections } from "@/components/Automations/DeletedConnections";
import { Checkbox, EmptyState } from "@/components/ui";
import { t } from "@/i18n/catalog";
import type { SavedConnection } from "@/types/connection";

interface TriggerConnectionPickerProps {
  /** The prompt shown above the list (e.g. "Fire when connecting to:"). */
  label: string;
  /** Saved connections offered for binding. */
  connections: SavedConnection[];
  /** Connection ids currently bound. */
  selected: string[];
  /** Called with the new bound id list. */
  onChange: (connectionIds: string[]) => void;
  /** `data-testid` prefix of each checkbox (suffixed with the connection id). */
  testIdPrefix: string;
}

/**
 * The saved-connection checklist a connection-bound trigger
 * (on-connect, on-disconnect, on-output-match) binds to. A bound connection that
 * was deleted is named and can be removed, and a trigger with none left says
 * that it starts nothing (A-025).
 */
export function TriggerConnectionPicker({
  label,
  connections,
  selected,
  onChange,
  testIdPrefix,
}: TriggerConnectionPickerProps) {
  const labelId = useId();
  const toggle = (connectionId: string, checked: boolean) => {
    onChange(checked ? [...selected, connectionId] : selected.filter((id) => id !== connectionId));
  };

  const deleted = selected.filter((id) => !connections.some((c) => c.id === id));
  const noneLeft = deleted.length === selected.length;

  return (
    <>
      <span id={labelId} className="automation-triggers__detail-label">
        {label}
      </span>
      {connections.length === 0 && deleted.length === 0 ? (
        <EmptyState title={t("workflow.trigger.connections.empty")} />
      ) : (
        <div className="automation-triggers__connections" role="group" aria-labelledby={labelId}>
          <DeletedConnections
            ids={deleted}
            onRemove={(id) => toggle(id, false)}
            testIdPrefix={testIdPrefix}
          />
          {connections.map((conn) => (
            <label className="automation-triggers__connection" key={conn.id}>
              <Checkbox
                checked={selected.includes(conn.id)}
                onCheckedChange={(v) => toggle(conn.id, v)}
                aria-label={conn.name}
                data-testid={`${testIdPrefix}-${conn.id}`}
              />
              <span>{conn.name}</span>
            </label>
          ))}
        </div>
      )}
      {(connections.length > 0 || deleted.length > 0) && noneLeft && (
        <span
          className={
            deleted.length > 0
              ? "automation-triggers__hint automation-triggers__hint--warning"
              : "automation-triggers__hint"
          }
          data-testid={`${testIdPrefix}-none`}
        >
          Choose at least one connection, or this never starts it.
        </span>
      )}
    </>
  );
}
