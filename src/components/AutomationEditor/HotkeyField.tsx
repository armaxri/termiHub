import { useState } from "react";
import type React from "react";
import { Field, Input } from "@/components/ui";
import { isPlainFunctionKey, recordedKeyFromEvent } from "@/components/Settings/keybindingRecorder";
import {
  DEFAULT_BINDINGS,
  checkConflict,
  eventMatchesCombo,
  formatBindingForDisplay,
  getActionScope,
  isShellReservedKey,
  isUnboundCombo,
  parseBinding,
  serializeCombo,
} from "@/services/keybindings";
import type { Automation } from "@/types/generated/Automation";
import type { KeyCombo } from "@/types/keybindings";

/** Props of {@link HotkeyField}. */
export interface HotkeyFieldProps {
  index: number;
  binding: string;
  error?: string;
  /** The other automations, whose hotkeys may be the same. */
  automations: readonly Automation[];
  onChange: (binding: string) => void;
}

/** The one combination a stored hotkey means, or `null`. */
function comboOf(binding: string): KeyCombo | null {
  if (binding.trim() === "") return null;
  const parsed = parseBinding(binding.trim());
  if (isUnboundCombo(parsed)) return null;
  return (Array.isArray(parsed) ? parsed[0] : parsed) ?? null;
}

/** Two bindings are the same keys, however they are written. */
function sameKeys(a: KeyCombo, b: KeyCombo): boolean {
  const key = (c: KeyCombo) =>
    [c.ctrl, c.shift, c.alt, c.meta].map(Boolean).join() + c.key.toLowerCase();
  return key(a) === key(b);
}

/** Who else answers to the keys, so that this automation does not start, or `null` (A-027). */
export function hotkeyConflict(
  binding: string,
  automations: readonly Automation[]
): { keys: string; user: string } | null {
  const combo = comboOf(binding);
  if (!combo) return null;
  const keys = formatBindingForDisplay(combo);
  const action = checkConflict(combo);
  const scope = action === null ? null : getActionScope(action);
  // Those two only answer inside their own view.
  if (action !== null && scope !== "remote-desktop" && scope !== "file-browser") {
    return { keys, user: DEFAULT_BINDINGS.find((b) => b.action === action)?.label ?? action };
  }
  const other = automations.find((a) =>
    a.triggers.some((trigger) => {
      const taken = trigger.kind === "hotkey" ? comboOf(trigger.binding) : null;
      return taken !== null && sameKeys(taken, combo);
    })
  );
  return other ? { keys, user: other.name } : null;
}

/** Why the pressed keys cannot be a hotkey, or `null`. */
function refusal(combo: KeyCombo): string | null {
  if (isPlainFunctionKey(combo)) return "That key stays with terminal programs. Add Ctrl or Alt.";
  if (!combo.ctrl && !combo.alt && !combo.meta) return "Add Ctrl, Alt or Cmd to the key.";
  return null;
}

/**
 * The keys of a hotkey trigger, taken from what is pressed (A-027). Tab still
 * moves on and Escape still closes; Backspace clears. It says who else uses them.
 */
export function HotkeyField({ index, binding, error, automations, onChange }: HotkeyFieldProps) {
  const [note, setNote] = useState<string | null>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const modified = e.ctrlKey || e.altKey || e.metaKey;
    if (!modified && (e.key === "Tab" || e.key === "Escape" || e.key === "Enter")) return;
    const pressed = recordedKeyFromEvent(e.nativeEvent);
    if (pressed.kind === "ignore") return;
    e.preventDefault();
    e.stopPropagation();
    if (!modified && (e.key === "Backspace" || e.key === "Delete")) {
      setNote(null);
      onChange("");
      return;
    }
    if (pressed.kind === "dead-key") {
      setNote("That key starts an accent on your keyboard layout. Pick another one.");
      return;
    }
    const refused = refusal(pressed.combo);
    const written = serializeCombo(pressed.combo);
    if (refused) {
      setNote(refused);
    } else if (!eventMatchesCombo(e.nativeEvent, parseBinding(written) as KeyCombo)) {
      setNote("That key cannot be a hotkey. Pick another one.");
    } else {
      setNote(
        isShellReservedKey(e.nativeEvent)
          ? `${formatBindingForDisplay(pressed.combo)} stays with the shell while a terminal has the focus.`
          : null
      );
      onChange(written);
    }
  };

  const conflict = hotkeyConflict(binding, automations);
  const warning =
    note ??
    (conflict
      ? `${conflict.keys} is used by “${conflict.user}”, so it will not start this.`
      : null);
  return (
    <Field
      label="Hotkey (press the keys)"
      htmlFor={`automation-trigger-binding-${index}`}
      error={error}
      hint={warning ?? undefined}
      hintVariant="warning"
    >
      <Input
        id={`automation-trigger-binding-${index}`}
        value={binding}
        error={Boolean(error)}
        placeholder="e.g. Ctrl+Alt+H"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={handleKeyDown}
        onChange={(e) => {
          setNote(null);
          onChange(e.target.value);
        }}
        data-testid={`automation-trigger-binding-${index}`}
      />
    </Field>
  );
}
