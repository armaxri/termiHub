import { useState, useCallback, useEffect, useRef } from "react";
import { RotateCcw, Download } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { KeyCombo, KeyBinding, ShortcutCategory } from "@/types/keybindings";
import {
  getDefaultBindings,
  getEffectiveCombo,
  serializeBinding,
  setOverride,
  clearOverrides,
  checkConflict,
  getOverrides,
} from "@/services/keybindings";
import { exportCheatSheet } from "@/utils/cheatSheetPdf";
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
  const settings = useAppStore((s) => s.settings);

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

  const handleResetOne = useCallback(
    (action: string) => {
      setOverride(action, null);
      persistOverrides();
    },
    [persistOverrides]
  );

  const handleRecordComplete = useCallback(
    (action: string, combo: KeyCombo | null) => {
      setRecordingAction(null);
      setConflictWarning(null);

      if (combo === null) {
        // Backspace pressed — unbind
        setOverride(action, { key: "", ctrl: false });
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
        return (
          b.label.toLowerCase().includes(q) ||
          b.action.toLowerCase().includes(q) ||
          b.category.toLowerCase().includes(q) ||
          serializeBinding(getEffectiveCombo(b.action) ?? b.winLinuxDefault)
            .toLowerCase()
            .includes(q)
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
                />
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="keyboard-settings__actions">
        <button
          className="keyboard-settings__reset-all"
          onClick={handleResetAll}
          data-testid="keyboard-settings-reset-all"
        >
          <RotateCcw size={14} />
          Reset All to Defaults
        </button>
        <button
          className="keyboard-settings__export-pdf"
          onClick={() => void exportCheatSheet()}
          data-testid="keyboard-settings-export-pdf"
          title="Save a one-page HTML cheat sheet of all shortcuts"
        >
          <Download size={14} />
          Save HTML Cheat Sheet
        </button>
      </div>
    </div>
  );
}

interface KeybindingRowProps {
  binding: KeyBinding;
  isRecording: boolean;
  onStartRecording: () => void;
  onRecordComplete: (combo: KeyCombo | null) => void;
  onCancel: () => void;
  onReset: () => void;
}

function KeybindingRow({
  binding,
  isRecording,
  onStartRecording,
  onRecordComplete,
  onCancel,
  onReset,
}: KeybindingRowProps) {
  const combo = getEffectiveCombo(binding.action);
  const displayStr = combo ? serializeBinding(combo) : "(unbound)";
  const cellRef = useRef<HTMLTableCellElement>(null);

  useEffect(() => {
    if (!isRecording) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        onCancel();
        return;
      }
      if (e.key === "Backspace") {
        onRecordComplete(null);
        return;
      }

      // Ignore lone modifier keys
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

      const newCombo: KeyCombo = {
        key: e.key,
        ctrl: e.ctrlKey || undefined,
        shift: e.shiftKey || undefined,
        alt: e.altKey || undefined,
        meta: e.metaKey || undefined,
      };

      onRecordComplete(newCombo);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isRecording, onRecordComplete, onCancel]);

  return (
    <tr data-testid={`keybinding-row-${binding.action}`}>
      <td className="keyboard-settings__action-cell">{binding.label}</td>
      <td
        ref={cellRef}
        className={`keyboard-settings__binding-cell ${isRecording ? "keyboard-settings__binding-cell--recording" : ""}`}
        onClick={!isRecording ? onStartRecording : undefined}
        data-testid={`keybinding-binding-${binding.action}`}
      >
        {isRecording ? "Press a key combination..." : displayStr}
      </td>
      <td className="keyboard-settings__reset-cell">
        <button
          className="keyboard-settings__reset-btn"
          onClick={onReset}
          title="Reset to default"
          data-testid={`keybinding-reset-${binding.action}`}
        >
          <RotateCcw size={12} />
        </button>
      </td>
    </tr>
  );
}
