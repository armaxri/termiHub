import { Fragment, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { KeyBinding, KeyCombo } from "@/types/keybindings";
import {
  formatActionBindings,
  formatBindingForDisplay,
  getActionScope,
  getDefaultCombo,
  getEffectiveCombo,
  isActionCustomized,
  isUnboundCombo,
} from "@/services/keybindings";
import { Button, Tooltip } from "@/components/ui";
import { recordModifierOnlyChord, type ModifierOnlyRejection } from "./modifierOnlyRecorder";
import { recordedKeyFromEvent } from "./keybindingRecorder";
import { SettingDefaultMarker } from "./SettingDefaultMarker";

/** Why a recording was refused: a modifier-only rule (#4524) or a dead key (#5842). */
export type RecordRejection = ModifierOnlyRejection | "dead-key";

/** A message shown under one row after recording it (#5842). */
export interface RowNotice {
  text: string;
  /** Set when the new shortcut is taken: the row offers Cancel · Reassign. */
  conflict?: { combo: KeyCombo | KeyCombo[]; other: KeyBinding };
}

export interface KeybindingRowProps {
  binding: KeyBinding;
  isRecording: boolean;
  /** What the last recording of this row ran into, if anything. */
  notice: RowNotice | null;
  onStartRecording: () => void;
  onRecordComplete: (combo: KeyCombo | KeyCombo[] | null) => void;
  onRecordRejected: (reason: RecordRejection) => void;
  onCancel: () => void;
  onReset: () => void;
  onUnbind: () => void;
  /** Take the conflicting shortcut from the other action and give it to this one. */
  onReassign: () => void;
  /** Close the notice and keep every binding as it was. */
  onDismissNotice: () => void;
}

/**
 * How long the recorder waits after a single combo before finalizing it, giving
 * the user a window to press a second combo and record a chord instead. A chord
 * finalizes immediately on its second combo, so this delay only affects the
 * common single-combo case. Mirrors the engine's chord timeout in spirit.
 */
const RECORD_CHORD_WINDOW_MS = 800;

/** The engine matches chords of exactly two combos, so cap a recorded chord there. */
const MAX_CHORD_LENGTH = 2;

/** Callbacks of the key-combo recorder. */
interface ComboRecorderCallbacks {
  onPreview: (preview: string) => void;
  onComplete: (combo: KeyCombo | KeyCombo[] | null) => void;
  onReject: (reason: RecordRejection) => void;
  /** `refocus` is false when Tab left recording and the browser moves focus. */
  onCancel: (refocus: boolean) => void;
}

/**
 * Record a key combo or a two-combo chord from window keydowns. Escape cancels,
 * Backspace drops the last combo (or clears the binding), a bare Tab leaves
 * recording so it is never a keyboard trap. Returns the cleanup.
 */
function recordComboChord(cb: ComboRecorderCallbacks): () => void {
  const combos: KeyCombo[] = [];
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  const clearFinishTimer = () => {
    if (finishTimer !== null) clearTimeout(finishTimer);
    finishTimer = null;
  };
  const finish = () => {
    clearFinishTimer();
    if (combos.length === 0) return;
    // A single combo persists as a bare KeyCombo (matching the default shape);
    // a chord persists as the KeyCombo[] the engine's chord matcher consumes.
    cb.onComplete(combos.length === 1 ? combos[0] : [...combos]);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      clearFinishTimer();
      cb.onCancel(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      clearFinishTimer();
      cb.onCancel(true);
      return;
    }
    if (e.key === "Backspace") {
      clearFinishTimer();
      if (combos.length > 0) {
        // Undo the last captured combo instead of unbinding mid-chord.
        combos.pop();
        cb.onPreview(formatBindingForDisplay(combos));
        return;
      }
      cb.onComplete(null);
      return;
    }
    const recorded = recordedKeyFromEvent(e);
    if (recorded.kind === "ignore") return;
    if (recorded.kind === "dead-key") {
      clearFinishTimer();
      cb.onReject("dead-key");
      return;
    }
    combos.push(recorded.combo);
    cb.onPreview(formatBindingForDisplay(combos));
    if (combos.length >= MAX_CHORD_LENGTH) {
      finish();
      return;
    }
    // First combo: wait briefly for a possible second combo (chord).
    clearFinishTimer();
    finishTimer = setTimeout(finish, RECORD_CHORD_WINDOW_MS);
  };

  window.addEventListener("keydown", handleKeyDown, true);
  return () => {
    clearFinishTimer();
    window.removeEventListener("keydown", handleKeyDown, true);
  };
}

/** Text on the binding button while recording. */
function recordingLabel(modifierOnly: boolean, preview: string): string {
  if (modifierOnly) {
    return preview
      ? `${preview} … (release to set)`
      : "Hold 2+ modifier keys, then release… (Esc cancels)";
  }
  return preview
    ? `${preview} … (press another key to chord)`
    : "Press a key combination… (Esc cancels, Backspace clears)";
}

/**
 * One row of Settings ▸ Keyboard shortcuts (#5842): the action, its binding as
 * a visible "Change" control that records a new chord, Clear (with Undo) and
 * the shared Default marker that turns into "Reset to default" once changed.
 * A refused or conflicting recording explains itself in a line under the row.
 */
export function KeybindingRow({
  binding,
  isRecording,
  notice,
  onStartRecording,
  onRecordComplete,
  onRecordRejected,
  onCancel,
  onReset,
  onUnbind,
  onReassign,
  onDismissNotice,
}: KeybindingRowProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Live preview of the combos captured so far while recording.
  const [recordingPreview, setRecordingPreview] = useState("");

  // Keep the latest callbacks in refs so the keydown listener stays stable across
  // re-renders — a re-armed listener mid-chord would drop the captured combos.
  const callbacks = useRef({ onRecordComplete, onRecordRejected, onCancel });
  useEffect(() => {
    callbacks.current = { onRecordComplete, onRecordRejected, onCancel };
  });
  const modifierOnly = binding.modifierOnly === true;

  // Keep focus on the binding button while recording: a mouse click does not
  // focus a button in WebKit, and the result is announced relative to it.
  useEffect(() => {
    if (isRecording) buttonRef.current?.focus();
  }, [isRecording]);

  useEffect(() => {
    if (!isRecording) return;
    const refocus = () => buttonRef.current?.focus();
    setRecordingPreview("");
    const shared = {
      onPreview: setRecordingPreview,
      onCancel: (focus: boolean) => {
        callbacks.current.onCancel();
        if (focus) refocus();
      },
    };
    if (modifierOnly) {
      return recordModifierOnlyChord({
        ...shared,
        onComplete: (combo) => {
          callbacks.current.onRecordComplete(combo);
          refocus();
        },
        onReject: (reason) => {
          callbacks.current.onRecordRejected(reason);
          refocus();
        },
      });
    }
    return recordComboChord({
      ...shared,
      onComplete: (combo) => {
        callbacks.current.onRecordComplete(combo);
        refocus();
      },
      onReject: (reason) => {
        callbacks.current.onRecordRejected(reason);
        refocus();
      },
    });
  }, [isRecording, modifierOnly]);

  const combo = getEffectiveCombo(binding.action);
  const isUnbound = !combo || isUnboundCombo(combo);
  const isCustomized = isActionCustomized(binding.action);
  // Alternate defaults are listed too, e.g. "Cmd+P / Cmd+Shift+P" (#5084).
  const displayStr = formatActionBindings(binding.action) ?? "(unbound)";
  const defaultCombo = getDefaultCombo(binding.action);
  const defaultText =
    defaultCombo && !isUnboundCombo(defaultCombo)
      ? formatBindingForDisplay(defaultCombo)
      : undefined;
  const yieldsToTerminal = getActionScope(binding.action) === "yields-to-terminal";

  /**
   * Enter / Space enter record mode explicitly. Handled on keydown (and the
   * default prevented) so the activating key is never mistaken for the first
   * key of the new binding, and Space's keyup-click cannot double-trigger.
   */
  const handleButtonKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isRecording) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onStartRecording();
    }
  };

  /** Clear the binding; its button then unmounts, so hand focus to the binding. */
  const handleUnbind = () => {
    onUnbind();
    buttonRef.current?.focus();
  };

  const handleCancel = () => {
    onCancel();
    buttonRef.current?.focus();
  };

  const accessibleName = isRecording
    ? `Recording shortcut for ${binding.label}`
    : `Change shortcut for ${binding.label}, currently ${isUnbound ? "unbound" : displayStr}`;

  return (
    <Fragment>
      <tr data-testid={`keybinding-row-${binding.action}`}>
        <td className="keyboard-settings__action-cell">
          <span data-testid={`keybinding-label-${binding.action}`}>{binding.label}</span>
          {yieldsToTerminal && (
            <small
              className="keyboard-settings__scope-note"
              data-testid={`keybinding-scope-note-${binding.action}`}
            >
              Not in a focused terminal: the program there keeps the key
            </small>
          )}
        </td>
        <td className="keyboard-settings__binding-cell">
          <Button
            ref={buttonRef}
            variant="ghost"
            size="sm"
            fullWidth
            className={[
              "keyboard-settings__binding-btn",
              isRecording ? "keyboard-settings__binding-btn--recording" : "",
              !isRecording && isUnbound ? "keyboard-settings__binding-btn--unbound" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={!isRecording ? onStartRecording : undefined}
            onKeyDown={handleButtonKeyDown}
            aria-label={accessibleName}
            data-testid={`keybinding-binding-${binding.action}`}
            data-unbound={!isRecording && isUnbound ? "true" : undefined}
          >
            <span
              className="keyboard-settings__binding-keys"
              data-testid={`keybinding-keys-${binding.action}`}
            >
              {isRecording ? recordingLabel(modifierOnly, recordingPreview) : displayStr}
            </span>
            {!isRecording && (
              <span
                className="keyboard-settings__binding-change"
                aria-hidden="true"
                data-testid={`keybinding-change-${binding.action}`}
              >
                Change
              </span>
            )}
          </Button>
        </td>
        <td className="keyboard-settings__row-actions">
          {isRecording ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCancel}
              aria-label={`Cancel recording for ${binding.label}`}
              data-testid={`keybinding-cancel-${binding.action}`}
            >
              Cancel
            </Button>
          ) : (
            <>
              {!isUnbound && !modifierOnly && (
                <Tooltip content="Clear shortcut">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<X size={12} />}
                    onClick={handleUnbind}
                    aria-label={`Clear shortcut for ${binding.label}`}
                    data-testid={`keybinding-unbind-${binding.action}`}
                  />
                </Tooltip>
              )}
              <SettingDefaultMarker
                isDefault={!isCustomized}
                onReset={onReset}
                name={binding.label}
                defaultText={defaultText}
                testIds={{
                  default: `keybinding-default-${binding.action}`,
                  reset: `keybinding-reset-${binding.action}`,
                }}
              />
            </>
          )}
        </td>
      </tr>
      {notice && (
        <tr className="keyboard-settings__notice-row">
          <td colSpan={3}>
            <div
              className="keyboard-settings__conflict"
              role="alert"
              data-testid="keyboard-settings-conflict"
            >
              <span>{notice.text}</span>
              <span className="keyboard-settings__conflict-actions">
                {notice.conflict ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={onDismissNotice}
                      data-testid="keybinding-conflict-cancel"
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={onReassign}
                      data-testid="keybinding-conflict-reassign"
                    >
                      Reassign
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onDismissNotice}
                    data-testid="keybinding-notice-close"
                  >
                    Close
                  </Button>
                )}
              </span>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
