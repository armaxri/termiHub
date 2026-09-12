import { useState, useCallback, useEffect, useRef } from "react";
import { RotateCcw, Download, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { KeyCombo, KeyBinding, ShortcutCategory } from "@/types/keybindings";
import {
  getDefaultBindings,
  getEffectiveCombo,
  serializeCombo,
  serializeBinding,
  setOverride,
  clearOverrides,
  checkConflict,
  getOverrides,
  unbindAction,
  isUnboundCombo,
} from "@/services/keybindings";
import { exportCheatSheet } from "@/utils/cheatSheetPdf";
import { Button, Toggle, Tooltip } from "@/components/ui";
import "./KeyboardSettings.css";

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  general: "General",
  clipboard: "Clipboard",
  terminal: "Terminal",
  navigation: "Navigation / Split",
  "tab-groups": "Tab Groups",
};

const CATEGORY_ORDER: ShortcutCategory[] = [
  "general",
  "clipboard",
  "terminal",
  "navigation",
  "tab-groups",
];

interface KeyboardSettingsProps {
  visibleFields?: Set<string>;
}

export function KeyboardSettings({ visibleFields }: KeyboardSettingsProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [recordingAction, setRecordingAction] = useState<string | null>(null);
  const [conflictWarning, setConflictWarning] = useState<string | null>(null);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const settings = useProjectedSettings();

  // Force re-render when overrides change
  const [, forceRender] = useState(0);

  const bindings = getDefaultBindings();

  const persistOverrides = useCallback(() => {
    const overrideEntries = getOverrides();
    const newSettings = {
      ...settings,
      keybindingOverrides: overrideEntries.length > 0 ? overrideEntries : undefined,
    };
    updateSettings(newSettings);
    forceRender((n) => n + 1);
  }, [settings, updateSettings]);

  const handleResetAll = useCallback(() => {
    clearOverrides();
    persistOverrides();
  }, [persistOverrides]);

  const passthroughEnabled = settings.terminalKeyPassthrough !== false;
  const handleTogglePassthrough = useCallback(() => {
    updateSettings({
      ...settings,
      terminalKeyPassthrough: !passthroughEnabled,
    });
  }, [settings, passthroughEnabled, updateSettings]);

  const editorDelegationEnabled = settings.editorShortcutDelegation !== false;
  const handleToggleEditorDelegation = useCallback(() => {
    updateSettings({
      ...settings,
      editorShortcutDelegation: !editorDelegationEnabled,
    });
  }, [settings, editorDelegationEnabled, updateSettings]);

  const handleResetOne = useCallback(
    (action: string) => {
      setOverride(action, null);
      persistOverrides();
    },
    [persistOverrides]
  );

  const handleUnbindOne = useCallback(
    (action: string) => {
      unbindAction(action);
      persistOverrides();
    },
    [persistOverrides]
  );

  const handleRecordComplete = useCallback(
    (action: string, combo: KeyCombo | KeyCombo[] | null) => {
      setRecordingAction(null);
      setConflictWarning(null);

      if (combo === null) {
        // Backspace pressed — unbind
        unbindAction(action);
        persistOverrides();
        return;
      }

      const conflict = checkConflict(combo, action);
      if (conflict) {
        const conflictBinding = bindings.find((b) => b.action === conflict);
        setConflictWarning(
          `"${serializeBinding(combo)}" is already used by "${conflictBinding?.label ?? conflict}"`
        );
        return;
      }

      setOverride(action, combo);
      persistOverrides();
    },
    [persistOverrides, bindings]
  );

  const show = !visibleFields || visibleFields.has("keybindings");
  if (!show) return null;

  const filteredBindings = searchQuery.trim()
    ? bindings.filter((b) => {
        const q = searchQuery.toLowerCase();
        const effective = getEffectiveCombo(b.action);
        const combo = effective ?? b.winLinuxDefault;
        const comboStr = isUnboundCombo(effective)
          ? "unbound"
          : combo
            ? serializeBinding(combo)
            : "";
        return (
          b.label.toLowerCase().includes(q) ||
          b.action.toLowerCase().includes(q) ||
          b.category.toLowerCase().includes(q) ||
          comboStr.toLowerCase().includes(q)
        );
      })
    : bindings;

  const groupedBindings = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    bindings: filteredBindings.filter((b) => b.category === cat),
  })).filter((g) => g.bindings.length > 0);

  return (
    <div className="settings-panel__category">
      <h3 className="settings-panel__category-title">Keyboard Shortcuts</h3>

      <div className="keyboard-settings__search">
        <input
          type="text"
          placeholder="Search shortcuts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="keyboard-settings__search-input"
          data-testid="keyboard-settings-search"
        />
      </div>

      <div
        className="keyboard-settings__passthrough"
        data-testid="keyboard-settings-passthrough-label"
      >
        <Toggle
          aria-label="Pass through shell keys when terminal is focused"
          checked={passthroughEnabled}
          onCheckedChange={handleTogglePassthrough}
          data-testid="keyboard-settings-passthrough"
        />
        <span>
          Pass through shell keys when terminal is focused
          <small>
            Common shell, tmux, vim, and SSH keys (Ctrl+letter, Ctrl+\, Alt+letter) are sent to the
            terminal instead of triggering an app shortcut while a terminal pane has focus.
          </small>
        </span>
      </div>

      <div
        className="keyboard-settings__passthrough"
        data-testid="keyboard-settings-editor-delegation-label"
      >
        <Toggle
          aria-label="Let editor tabs handle their own editing shortcuts"
          checked={editorDelegationEnabled}
          onCheckedChange={handleToggleEditorDelegation}
          data-testid="keyboard-settings-editor-delegation"
        />
        <span>
          Let editor tabs handle their own editing shortcuts
          <small>
            When on, shortcuts like Find (Cmd/Ctrl+F), Replace, and Select All go to the focused
            editor or input instead of the global app while an editor tab is active.
          </small>
        </span>
      </div>

      {conflictWarning && (
        <div className="keyboard-settings__conflict" data-testid="keyboard-settings-conflict">
          {conflictWarning}
        </div>
      )}

      {groupedBindings.map((group) => (
        <div key={group.category} className="keyboard-settings__group">
          <h4 className="keyboard-settings__group-title">{group.label}</h4>
          <table className="keyboard-settings__table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Binding</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {group.bindings.map((binding) => (
                <KeybindingRow
                  key={binding.action}
                  binding={binding}
                  isRecording={recordingAction === binding.action}
                  onStartRecording={() => {
                    setRecordingAction(binding.action);
                    setConflictWarning(null);
                  }}
                  onRecordComplete={(combo) => handleRecordComplete(binding.action, combo)}
                  onCancel={() => {
                    setRecordingAction(null);
                    setConflictWarning(null);
                  }}
                  onReset={() => handleResetOne(binding.action)}
                  onUnbind={() => handleUnbindOne(binding.action)}
                />
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="keyboard-settings__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<RotateCcw size={14} />}
          onClick={handleResetAll}
          data-testid="keyboard-settings-reset-all"
          title="Restore the built-in defaults, which are chosen to avoid common shell, tmux, vim, and SSH conflicts on Windows and Linux."
        >
          Reset to Safer Defaults
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={14} />}
          onClick={() => void exportCheatSheet()}
          data-testid="keyboard-settings-export-pdf"
          title="Save a one-page HTML cheat sheet of all shortcuts"
        >
          Save HTML Cheat Sheet
        </Button>
      </div>
    </div>
  );
}

interface KeybindingRowProps {
  binding: KeyBinding;
  isRecording: boolean;
  onStartRecording: () => void;
  onRecordComplete: (combo: KeyCombo | KeyCombo[] | null) => void;
  onCancel: () => void;
  onReset: () => void;
  onUnbind: () => void;
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

function KeybindingRow({
  binding,
  isRecording,
  onStartRecording,
  onRecordComplete,
  onCancel,
  onReset,
  onUnbind,
}: KeybindingRowProps) {
  const combo = getEffectiveCombo(binding.action);
  const isUnbound = !combo || isUnboundCombo(combo);
  const displayStr = combo && !isUnboundCombo(combo) ? serializeBinding(combo) : "(unbound)";
  const cellRef = useRef<HTMLTableCellElement>(null);

  // Live preview of the combos captured so far while recording (e.g. "Cmd+K"
  // after the first key of a chord). Empty until the first non-modifier keypress.
  const [recordingPreview, setRecordingPreview] = useState("");

  // Keep the latest callbacks in refs so the keydown listener stays stable across
  // re-renders — otherwise a new `onRecordComplete` identity each render would
  // tear down and re-arm the listener mid-chord, dropping the accumulated combos.
  const onRecordCompleteRef = useRef(onRecordComplete);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onRecordCompleteRef.current = onRecordComplete;
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    if (!isRecording) return;

    // Combos accumulated so far this recording session, and the pending "single
    // combo?" finalize timer.
    const combos: KeyCombo[] = [];
    let finishTimer: ReturnType<typeof setTimeout> | null = null;

    const clearFinishTimer = () => {
      if (finishTimer !== null) {
        clearTimeout(finishTimer);
        finishTimer = null;
      }
    };

    const finish = () => {
      clearFinishTimer();
      if (combos.length === 0) return;
      // A single combo persists as a bare KeyCombo (matching the default shape);
      // a chord persists as the KeyCombo[] the engine's chord matcher consumes.
      onRecordCompleteRef.current(combos.length === 1 ? combos[0] : [...combos]);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        clearFinishTimer();
        onCancelRef.current();
        return;
      }
      if (e.key === "Backspace") {
        clearFinishTimer();
        if (combos.length > 0) {
          // Undo the last captured combo instead of unbinding mid-chord.
          combos.pop();
          setRecordingPreview(combos.map(serializeCombo).join(" "));
          return;
        }
        onRecordCompleteRef.current(null);
        return;
      }

      // Ignore lone modifier keys
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

      combos.push({
        key: e.key,
        ctrl: e.ctrlKey || undefined,
        shift: e.shiftKey || undefined,
        alt: e.altKey || undefined,
        meta: e.metaKey || undefined,
      });
      setRecordingPreview(combos.map(serializeCombo).join(" "));

      if (combos.length >= MAX_CHORD_LENGTH) {
        // A full chord — finalize immediately, no need to wait.
        finish();
        return;
      }

      // First combo: wait briefly for a possible second combo (chord) before
      // committing this as a single-combo binding.
      clearFinishTimer();
      finishTimer = setTimeout(finish, RECORD_CHORD_WINDOW_MS);
    };

    setRecordingPreview("");
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      clearFinishTimer();
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isRecording]);

  return (
    <tr data-testid={`keybinding-row-${binding.action}`}>
      <td className="keyboard-settings__action-cell">{binding.label}</td>
      <td
        ref={cellRef}
        className={[
          "keyboard-settings__binding-cell",
          isRecording ? "keyboard-settings__binding-cell--recording" : "",
          !isRecording && isUnbound ? "keyboard-settings__binding-cell--unbound" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={!isRecording ? onStartRecording : undefined}
        data-testid={`keybinding-binding-${binding.action}`}
        data-unbound={!isRecording && isUnbound ? "true" : undefined}
      >
        {isRecording
          ? recordingPreview
            ? `${recordingPreview} … (press another key to chord)`
            : "Press a key combination... (Backspace to unbind)"
          : displayStr}
      </td>
      <td className="keyboard-settings__row-actions">
        {!isUnbound && (
          <Tooltip content="Unbind (clear shortcut)">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<X size={12} />}
              onClick={onUnbind}
              aria-label={`Unbind ${binding.label}`}
              data-testid={`keybinding-unbind-${binding.action}`}
            />
          </Tooltip>
        )}
        <Tooltip content="Reset to default">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<RotateCcw size={12} />}
            onClick={onReset}
            aria-label={`Reset ${binding.label} to default`}
            data-testid={`keybinding-reset-${binding.action}`}
          />
        </Tooltip>
      </td>
    </tr>
  );
}
