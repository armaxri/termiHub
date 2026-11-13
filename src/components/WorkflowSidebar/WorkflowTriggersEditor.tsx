import type { ComponentType, ReactNode } from "react";
import { Zap, Play, Keyboard, Unplug, ScanText, Check } from "lucide-react";
import { Chip, Input, Field } from "@/components/ui";
import type { WorkflowTrigger, WorkflowTriggerKind } from "@/types/workflow";
import type { SavedConnection } from "@/types/connection";
import { TriggerConnectionPicker } from "./TriggerConnectionPicker";
import { OnDisconnectTriggerDetail } from "./OnDisconnectTriggerDetail";
import { OnOutputMatchTriggerDetail } from "./OnOutputMatchTriggerDetail";
import { triggerKindLabel } from "./workflowStepMeta";

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
 * A trigger chip's icon: a check mark while it is on, its kind icon while off.
 * Several triggers can be on at once, so the chips read as a checklist rather
 * than tabs of a segmented control (#5637).
 */
function chipIcon(on: boolean, Icon: ComponentType<{ size?: number | string }>): ReactNode {
  return on ? <Check size={11} aria-hidden="true" /> : <Icon size={11} aria-hidden="true" />;
}

/**
 * The Triggers section of the workflow editor: chips bind how the workflow
 * launches — `manual` (default), `on-connect` (pick connections), `hotkey`
 * (a keybinding string), `on-disconnect` and `on-output-match` (#3791). This
 * edits the stored trigger *data* only; dispatch lives in the workflowTriggers /
 * workflowOutputTriggers services.
 */
export function WorkflowTriggersEditor({
  triggers,
  connections,
  onChange,
}: WorkflowTriggersEditorProps) {
  const manual = find(triggers, "manual");
  const onConnect = find(triggers, "on-connect");
  const hotkey = find(triggers, "hotkey");
  const onDisconnect = find(triggers, "on-disconnect");
  const onOutputMatch = find(triggers, "on-output-match");

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

  const toggleOnDisconnect = () =>
    onChange(
      replace(
        triggers,
        "on-disconnect",
        onDisconnect ? undefined : { kind: "on-disconnect", connectionIds: [] }
      )
    );

  const toggleOnOutputMatch = () =>
    onChange(
      replace(
        triggers,
        "on-output-match",
        onOutputMatch ? undefined : { kind: "on-output-match", connectionIds: [], pattern: "" }
      )
    );

  return (
    <div className="workflow-triggers" data-testid="workflow-editor-triggers">
      <div className="workflow-triggers__chips" data-testid="workflow-editor-triggers-chips">
        <Chip
          label={triggerKindLabel("manual")}
          icon={chipIcon(manual !== undefined, Play)}
          pressed={manual !== undefined}
          onPressedChange={toggleManual}
          data-testid="workflow-trigger-manual"
        />
        <Chip
          label={triggerKindLabel("on-connect")}
          icon={chipIcon(onConnect !== undefined, Zap)}
          pressed={onConnect !== undefined}
          onPressedChange={toggleOnConnect}
          data-testid="workflow-trigger-on-connect"
        />
        <Chip
          label={triggerKindLabel("hotkey")}
          icon={chipIcon(hotkey !== undefined, Keyboard)}
          pressed={hotkey !== undefined}
          onPressedChange={toggleHotkey}
          data-testid="workflow-trigger-hotkey"
        />
        <Chip
          label={triggerKindLabel("on-disconnect")}
          icon={chipIcon(onDisconnect !== undefined, Unplug)}
          pressed={onDisconnect !== undefined}
          onPressedChange={toggleOnDisconnect}
          data-testid="workflow-trigger-on-disconnect"
        />
        <Chip
          label={triggerKindLabel("on-output-match")}
          icon={chipIcon(onOutputMatch !== undefined, ScanText)}
          pressed={onOutputMatch !== undefined}
          onPressedChange={toggleOnOutputMatch}
          data-testid="workflow-trigger-on-output-match"
        />
      </div>

      {onConnect ? (
        <div className="workflow-triggers__detail" data-testid="workflow-trigger-on-connect-detail">
          <TriggerConnectionPicker
            label="Fire when connecting to:"
            connections={connections}
            selected={onConnect.connectionIds}
            onChange={(connectionIds) =>
              onChange(replace(triggers, "on-connect", { kind: "on-connect", connectionIds }))
            }
            testIdPrefix="workflow-trigger-connection"
          />
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
                onChange(replace(triggers, "hotkey", { kind: "hotkey", binding: e.target.value }))
              }
              data-testid="workflow-trigger-hotkey-binding"
            />
          </Field>
        </div>
      ) : null}

      {onDisconnect ? (
        <OnDisconnectTriggerDetail
          trigger={onDisconnect}
          connections={connections}
          onChange={(next) => onChange(replace(triggers, "on-disconnect", next))}
        />
      ) : null}

      {onOutputMatch ? (
        <OnOutputMatchTriggerDetail
          trigger={onOutputMatch}
          connections={connections}
          onChange={(next) => onChange(replace(triggers, "on-output-match", next))}
        />
      ) : null}
    </div>
  );
}
