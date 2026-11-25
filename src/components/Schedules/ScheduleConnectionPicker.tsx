import { Checkbox, EmptyState } from "@/components/ui";
import { DeletedConnections } from "@/components/Automations/DeletedConnections";
import { t } from "@/i18n/catalog";
import type { SavedConnection } from "@/types/connection";

/** Props of {@link ScheduleConnectionPicker}. */
export interface ScheduleConnectionPickerProps {
  connections: readonly SavedConnection[];
  /** The chosen ids, deleted connections included. */
  selected: readonly string[];
  onChange: (connectionIds: string[]) => void;
  /** Injected by the field: marks the group invalid. */
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}

/** The saved connections a schedule runs on, with the deleted ones named (#6024). */
export function ScheduleConnectionPicker({
  connections,
  selected,
  onChange,
  ...aria
}: ScheduleConnectionPickerProps) {
  const known = new Set(connections.map((c) => c.id));
  const deleted = selected.filter((id) => !known.has(id));
  if (connections.length === 0 && deleted.length === 0) {
    return <EmptyState title={t("workflow.trigger.connections.empty")} />;
  }
  return (
    <div
      id="schedule-editor-connections"
      className="schedule-editor__connections"
      role="group"
      tabIndex={-1}
      aria-label="Connections"
      aria-describedby={aria["aria-describedby"]}
      data-invalid={aria["aria-invalid"]}
      aria-invalid={aria["aria-invalid"]}
      data-testid="schedule-editor-connections"
    >
      <DeletedConnections
        ids={deleted}
        onRemove={(id) => onChange(selected.filter((x) => x !== id))}
        testIdPrefix="schedule-editor-connection"
      />
      {connections.map((conn) => (
        <label className="schedule-editor__connection" key={conn.id}>
          <Checkbox
            checked={selected.includes(conn.id)}
            onCheckedChange={(checked) =>
              onChange(checked ? [...selected, conn.id] : selected.filter((id) => id !== conn.id))
            }
            aria-label={conn.name}
            data-testid={`schedule-editor-connection-${conn.id}`}
          />
          <span>{conn.name}</span>
        </label>
      ))}
    </div>
  );
}
