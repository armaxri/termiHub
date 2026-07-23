import { Zap, Play, Keyboard } from "lucide-react";
import { Input, Checkbox, Field } from "@/components/ui";
import type { WorkflowTrigger, WorkflowTriggerKind } from "@/types/workflow";
import type { SavedConnection } from "@/types/connection";

interface WorkflowTriggersEditorProps {
  triggers: WorkflowTrigger[];
  connections: SavedConnection[];
  onChange: (triggers: WorkflowTrigger[]) => void;
}

/** Find a trigger of the given kind in the working list. */
function find<K extends WorkflowTriggerKind>(
  triggers: WorkflowTrigger[],
  kind: K
): Extract<WorkflowTrigger, { kind: K }> | undefined {
  return triggers.find((t): t is Extract<WorkflowTrigger, { kind: K }> => t.kind === kind);
}

/** Replace (or remove, when `next` is undefined) the trigger of one kind. */
function replace(
  triggers: WorkflowTrigger[],
  kind: WorkflowTriggerKind,
  next: WorkflowTrigger | undefined
): WorkflowTrigger[] {
  const without = triggers.filter((t) => t.kind !== kind);
  return next ? [...without, next] : without;
}

/**
 * The Triggers section of the workflow editor: chips bind how the workflow
 * launches — `manual` (default), `on-connect` (pick connections), or `hotkey`
 * (a keybinding string). This edits the stored trigger *data* only; the actual
 * trigger dispatch (on-connect firing, hotkey capture) lands in #1855.
 */
export function WorkflowTriggersEditor({
  triggers,
  connections,
  onChange,
}: WorkflowTriggersEditorProps) {
  const manual = find(triggers, "manual");
  const onConnect = find(triggers, "on-connect");
  const hotkey = find(triggers, "hotkey");

  const toggleManual = () =>
    onChange(replace(triggers, "manual", manual ? undefined : { kind: "manual" }));

  const toggleOnConnect = () =>
    onChange(
      replace(
        triggers,
        "on-connect",
        onConnect ? undefined : { kind: "on-connect", connectionIds: [] }
      )
    );

  const toggleHotkey = () =>
    onChange(replace(triggers, "hotkey", hotkey ? undefined : { kind: "hotkey", binding: "" }));

  const toggleConnection = (connectionId: string, checked: boolean) => {
    const current = onConnect?.connectionIds ?? [];
    const ids = checked
      ? [...current, connectionId]
      : current.filter((id) => id !== connectionId);
    onChange(replace(triggers, "on-connect", { kind: "on-connect", connectionIds: ids }));
  };

  return (
    <div className="workflow-triggers" data-testid="workflow-editor-triggers">
      <div className="workflow-triggers__chips">
        <button
          type="button"
          className={`workflow-chip${manual ? " workflow-chip--active" : ""}`}
          aria-pressed={manual !== undefined}
          onClick={toggleManual}
          data-testid="workflow-trigger-manual"
        >
          <Play size={11} aria-hidden="true" /> Manual
        </button>
        <button
          type="button"
          className={`workflow-chip${onConnect ? " workflow-chip--active" : ""}`}
          aria-pressed={onConnect !== undefined}
          onClick={toggleOnConnect}
          data-testid="workflow-trigger-on-connect"
        >
          <Zap size={11} aria-hidden="true" /> On connect
        </button>
        <button
          type="button"
          className={`workflow-chip${hotkey ? " workflow-chip--active" : ""}`}
          aria-pressed={hotkey !== undefined}
          onClick={toggleHotkey}
          data-testid="workflow-trigger-hotkey"
        >
          <Keyboard size={11} aria-hidden="true" /> Hotkey
        </button>
      </div>

      {onConnect ? (
        <div className="workflow-triggers__detail" data-testid="workflow-trigger-on-connect-detail">
          <span className="workflow-triggers__detail-label">Fire when connecting to:</span>
          {connections.length === 0 ? (
            <span className="workflow-triggers__empty">No saved connections.</span>
          ) : (
            <div className="workflow-triggers__connections">
              {connections.map((conn) => {
                const checked = onConnect.connectionIds.includes(conn.id);
                return (
                  <label className="workflow-triggers__connection" key={conn.id}>
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => toggleConnection(conn.id, v)}
                      aria-label={conn.name}
                      data-testid={`workflow-trigger-connection-${conn.id}`}
                    />
                    <span>{conn.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {hotkey ? (
        <div className="workflow-triggers__detail" data-testid="workflow-trigger-hotkey-detail">
          <Field label="Keybinding" htmlFor="workflow-trigger-hotkey-binding">
            <Input
              id="workflow-trigger-hotkey-binding"
              value={hotkey.binding}
              placeholder="e.g. Ctrl+Alt+H"
              onChange={(e) =>
                onChange(
                  replace(triggers, "hotkey", { kind: "hotkey", binding: e.target.value })
                )
              }
              data-testid="workflow-trigger-hotkey-binding"
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}
