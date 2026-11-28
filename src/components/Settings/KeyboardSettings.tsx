import { useState, useCallback } from "react";
import { RotateCcw, Download, Upload, FileDown } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import {
  KeyCombo,
  KeyBinding,
  KeybindingOverrideEntry,
  ShortcutCategory,
} from "@/types/keybindings";
import {
  getDefaultBindings,
  getEffectiveCombo,
  formatBindingForDisplay,
  formatActionBindings,
  setOverride,
  setOverrides,
  clearOverrides,
  checkConflict,
  getOverrides,
  unbindAction,
  isUnboundCombo,
  isValidModifierOnlyCombo,
  releaseBindingFrom,
} from "@/services/keybindings";
import {
  MODIFIER_ONLY_RECORDING_INSTRUCTIONS,
  MODIFIER_ONLY_REJECTION_TEXT,
} from "./modifierOnlyRecorder";
import {
  deadKeyRejectionText,
  takesKeyFromTerminalPrograms,
  terminalKeyRejectionText,
} from "./keybindingRecorder";
import { KeybindingRow, type RecordRejection, type RowNotice } from "./KeybindingRow";
import { serializeKeybindings, parseKeybindingEnvelope } from "@/services/keybindingIo";
import { exportCheatSheet } from "@/utils/cheatSheetPdf";
import { Button, Checkbox, ConfirmDialog, Field, Toggle, SearchInput } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import { showUndoToast } from "@/utils/undoableDelete";
import { customBindingCount, restoreKeybindings } from "./restoreKeybindings";
import { useJsonFileExport, useJsonFileImport } from "@/hooks/useJsonFile";
import { useListFilter, type ListFilterFields } from "@/hooks/useListFilter";
import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { isShortcutCategoryVisible } from "@/utils/experimentalTypes";
import "./KeyboardSettings.css";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

import { ICON_SIZE } from "@/components/ui/iconSize";
/**
 * Searchable text of a keybinding: its label, action id, category, and its
 * currently-effective combo string. Module-level so the {@link useListFilter}
 * memo stays stable across renders.
 */
const keybindingFields: ListFilterFields<KeyBinding> = (binding) => {
  const effective = getEffectiveCombo(binding.action);
  const combo = effective ?? binding.winLinuxDefault;
  const comboStr = isUnboundCombo(effective)
    ? "unbound"
    : effective
      ? (formatActionBindings(binding.action) ?? "")
      : combo
        ? formatBindingForDisplay(combo)
        : "";
  return [binding.label, binding.action, binding.category, comboStr];
};

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  general: "General",
  clipboard: "Clipboard",
  terminal: "Terminal",
  navigation: "Navigation / split",
  "tab-groups": "Tab groups",
  "remote-desktop": "Remote desktop",
};

const CATEGORY_ORDER: ShortcutCategory[] = [
  "general",
  "clipboard",
  "terminal",
  "navigation",
  "tab-groups",
  "remote-desktop",
];

/**
 * Spoken instructions while a binding is being recorded. Tab and Shift+Tab on
 * their own are reserved for focus navigation (pressing them leaves recording,
 * so record mode is never a keyboard trap); combined with Ctrl/Alt/Cmd they are
 * recorded like any other key.
 */
const RECORDING_INSTRUCTIONS =
  "Press the new key combination. Escape cancels, Backspace clears, Tab leaves.";

/** Human-readable effective binding of `action` ("unbound" when it has none). */
function describeEffective(action: string): string {
  return formatActionBindings(action) ?? "unbound";
}

interface KeyboardSettingsProps {
  visibleFields?: Set<string>;
}

export function KeyboardSettings({ visibleFields }: KeyboardSettingsProps) {
  const [recordingAction, setRecordingAction] = useState<string | null>(null);
  // A refused or conflicting recording, shown under the recorded row (#5842).
  const [notice, setNotice] = useState<(RowNotice & { action: string }) | null>(null);
  // Text of the polite live region that tells screen-reader users what a
  // rebinding did: recording started, binding set/cleared/reset, or cancelled.
  const [announcement, setAnnouncement] = useState("");
  // The overlay shows only this platform (#4711); the exported cheat sheet can
  // still list every platform for sharing.
  const [cheatSheetAllPlatforms, setCheatSheetAllPlatforms] = useState(false);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const settings = useProjectedSettings();

  // Force re-render when overrides change
  const [, forceRender] = useState(0);

  const bindings = getDefaultBindings();
  // Remote Desktop shortcuts are listed only while VNC/RDP are ungated (#5365).
  const experimental = useExperimentalFeatures();
  const { query, setQuery, filtered: filteredBindings } = useListFilter(bindings, keybindingFields);

  const persistOverrides = useCallback(() => {
    const overrideEntries = getOverrides();
    const newSettings = {
      ...settings,
      keybindingOverrides: overrideEntries.length > 0 ? overrideEntries : undefined,
    };
    updateSettings(newSettings);
    forceRender((n) => n + 1);
  }, [settings, updateSettings]);

  // A reset or import replaces every custom binding, so it asks first when there
  // are any to lose, and offers a 10 s Undo afterwards (#5375).
  const [pendingReplace, setPendingReplace] = useState<PendingReplace | null>(null);

  /** Replace all overrides with `entries`, then offer an Undo that restores them. */
  const replaceOverrides = useCallback(
    (entries: KeybindingOverrideEntry[], message: string) => {
      const snapshot = getOverrides();
      if (entries.length === 0) clearOverrides();
      else setOverrides(entries);
      persistOverrides();
      showUndoToast(message, {
        testId: "keybinding-undo-toast",
        onUndo: () => {
          restoreKeybindings(snapshot);
          forceRender((n) => n + 1);
        },
      });
    },
    [persistOverrides]
  );

  /** Run `replace` at once when nothing custom would be lost, else confirm first. */
  const confirmReplace = useCallback((replace: PendingReplace) => {
    if (getOverrides().length === 0) replace.apply();
    else setPendingReplace(replace);
  }, []);

  const handleResetAll = useCallback(() => {
    confirmReplace({
      title: "Reset to safer defaults?",
      summary: `${customBindingCount(getOverrides().length)} will be replaced with the built-in defaults.`,
      confirmLabel: "Reset",
      apply: () => replaceOverrides([], "Keyboard shortcuts reset to safer defaults"),
    });
  }, [confirmReplace, replaceOverrides]);

  // JSON export/import of the current keybinding overrides (PROD-055), reusing the
  // shared flat-sidebar file dialog flow. A cancelled dialog is a silent no-op.
  const exportKeybindingsToFile = useJsonFileExport("keyboard shortcuts");
  const importKeybindingsFromFile = useJsonFileImport("keyboard shortcuts");

  const handleExportJson = useCallback(() => {
    void exportKeybindingsToFile({
      defaultPath: "termihub-keyboard-shortcuts.json",
      content: () => serializeKeybindings(getOverrides()),
      successMessage: "Exported keyboard shortcuts",
    });
  }, [exportKeybindingsToFile]);

  // The envelope is validated before any override is applied, so a malformed file
  // surfaces an error toast and leaves the existing bindings untouched.
  const handleImportJson = useCallback(() => {
    void importKeybindingsFromFile(async (json) => {
      const entries = parseKeybindingEnvelope(json);
      const imported = `${entries.length} keyboard shortcut${entries.length === 1 ? "" : "s"}`;
      confirmReplace({
        title: "Import shortcuts?",
        summary: `${customBindingCount(getOverrides().length)} will be replaced with the ${imported} from this file.`,
        confirmLabel: "Import",
        apply: () => replaceOverrides(entries, `Imported ${imported}`),
      });
    });
  }, [importKeybindingsFromFile, confirmReplace, replaceOverrides]);

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
    (binding: KeyBinding) => {
      setOverride(binding.action, null);
      persistOverrides();
      setNotice(null);
      setAnnouncement(`${binding.label} shortcut reset to ${describeEffective(binding.action)}.`);
    },
    [persistOverrides]
  );

  // Clearing is one click (or Backspace while recording), so it confirms with a
  // toast that can undo it (#5561, #5842).
  const clearWithUndo = useCallback(
    (binding: KeyBinding) => {
      const snapshot = getOverrides();
      unbindAction(binding.action);
      persistOverrides();
      setNotice(null);
      setAnnouncement(`${binding.label} shortcut cleared.`);
      showUndoToast(`Shortcut for ${binding.label} cleared`, {
        testId: "keybinding-unbind-toast",
        onUndo: () => {
          restoreKeybindings(snapshot);
          forceRender((n) => n + 1);
        },
      });
    },
    [persistOverrides]
  );

  const handleStartRecording = useCallback((binding: KeyBinding) => {
    setRecordingAction(binding.action);
    setNotice(null);
    const instructions = binding.modifierOnly
      ? MODIFIER_ONLY_RECORDING_INSTRUCTIONS
      : RECORDING_INSTRUCTIONS;
    setAnnouncement(`Recording shortcut for ${binding.label}. ${instructions}`);
  }, []);

  /** Show `text` under `binding`'s row; the role="alert" line announces it assertively. */
  const showNotice = useCallback((binding: KeyBinding, notice: RowNotice) => {
    setRecordingAction(null);
    // Clear the polite region so the two do not talk over each other.
    setAnnouncement("");
    setNotice({ action: binding.action, ...notice });
  }, []);

  /** A recording was unusable: keep the old binding and say why. */
  const handleRecordRejected = useCallback(
    (binding: KeyBinding, reason: RecordRejection) => {
      const text =
        reason === "dead-key"
          ? deadKeyRejectionText(binding.label)
          : `${MODIFIER_ONLY_REJECTION_TEXT[reason]} ${binding.label} shortcut unchanged.`;
      showNotice(binding, { text });
    },
    [showNotice]
  );

  const handleCancelRecording = useCallback((binding: KeyBinding) => {
    setRecordingAction(null);
    setNotice(null);
    setAnnouncement(`Recording canceled. ${binding.label} shortcut unchanged.`);
  }, []);

  const handleRecordComplete = useCallback(
    (binding: KeyBinding, combo: KeyCombo | KeyCombo[] | null) => {
      const { action } = binding;
      setRecordingAction(null);
      setNotice(null);

      // Defense in depth: a modifier-only action never accepts an unusable chord
      // (the service would also drop it), so a rebind cannot trap the user.
      if (binding.modifierOnly && !isValidModifierOnlyCombo(combo)) {
        handleRecordRejected(binding, combo === null ? "cannot-clear" : "too-few-modifiers");
        return;
      }

      if (combo === null) {
        clearWithUndo(binding);
        return;
      }

      // Plain function keys stay with terminal programs (#4773).
      if (takesKeyFromTerminalPrograms(action, combo)) {
        showNotice(binding, { text: terminalKeyRejectionText(binding.label, combo) });
        return;
      }

      const conflict = checkConflict(combo, action);
      if (conflict) {
        const other = bindings.find((b) => b.action === conflict);
        const otherLabel = other?.label ?? conflict;
        const text =
          `"${formatBindingForDisplay(combo)}" is already used by "${otherLabel}". ` +
          `Reassign it to ${binding.label} (${otherLabel} loses it), or cancel to keep both ` +
          `shortcuts unchanged.`;
        showNotice(binding, { text, conflict: other ? { combo, other } : undefined });
        return;
      }

      setOverride(action, combo);
      persistOverrides();
      setAnnouncement(`${binding.label} shortcut set to ${formatBindingForDisplay(combo)}.`);
    },
    [persistOverrides, bindings, handleRecordRejected, clearWithUndo, showNotice]
  );

  /** "Reassign": move the conflicting shortcut to `binding`, with an Undo (#5842). */
  const handleReassign = useCallback(
    (binding: KeyBinding, combo: KeyCombo | KeyCombo[], other: KeyBinding) => {
      const snapshot = getOverrides();
      // Release it from every action that holds it (normally just `other`);
      // bounded by the number of actions, so it always terminates.
      let owner = checkConflict(combo, binding.action);
      for (let left = bindings.length; owner && left > 0; left--) {
        releaseBindingFrom(owner, combo);
        owner = checkConflict(combo, binding.action);
      }
      setOverride(binding.action, combo);
      persistOverrides();
      setNotice(null);
      const keys = formatBindingForDisplay(combo);
      setAnnouncement(
        `${binding.label} shortcut set to ${keys}. ${other.label} is now ${describeEffective(other.action)}.`
      );
      showUndoToast(`${keys} moved from ${other.label} to ${binding.label}`, {
        testId: "keybinding-reassign-toast",
        onUndo: () => {
          restoreKeybindings(snapshot);
          forceRender((n) => n + 1);
        },
      });
    },
    [persistOverrides, bindings]
  );

  const show = !visibleFields || visibleFields.has("keybindings");
  if (!show) return null;

  const groupedBindings = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    bindings: filteredBindings.filter((b) => b.category === cat),
  })).filter((g) => g.bindings.length > 0 && isShortcutCategoryVisible(g.category, experimental));

  return (
    <div className="settings-panel__category">
      <SettingsSectionHeading>Keyboard shortcuts</SettingsSectionHeading>

      <div className="keyboard-settings__search">
        <SearchInput
          placeholder="Search shortcuts…"
          value={query}
          onValueChange={setQuery}
          clearLabel="Clear shortcut search"
          data-testid="keyboard-settings-search"
        />
      </div>

      <div className="settings-form">
        <SettingsField
          label="Pass through shell keys when terminal is focused"
          hint={
            "Common shell, tmux, vim, and SSH keys (Ctrl+letter, Ctrl+\\, Alt+letter) are sent to the terminal instead of triggering an app shortcut while a terminal pane has focus."
          }
        >
          <Toggle
            checked={passthroughEnabled}
            onCheckedChange={handleTogglePassthrough}
            data-testid="keyboard-settings-passthrough"
          />
        </SettingsField>
        <SettingsField
          label="Let editor tabs handle their own editing shortcuts"
          hint="When on, shortcuts like Find (Cmd/Ctrl+F), Replace, and Select All go to the focused editor or input instead of the global app while an editor tab is active."
        >
          <Toggle
            checked={editorDelegationEnabled}
            onCheckedChange={handleToggleEditorDelegation}
            data-testid="keyboard-settings-editor-delegation"
          />
        </SettingsField>
      </div>

      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        data-testid="keyboard-settings-announcement"
      >
        {announcement}
      </div>

      {groupedBindings.map((group) => (
        <div key={group.category} className="keyboard-settings__group">
          <h4
            className="keyboard-settings__group-title"
            data-testid={`keyboard-settings-group-title-${group.category}`}
          >
            {group.label}
          </h4>
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
                  notice={notice?.action === binding.action ? notice : null}
                  onStartRecording={() => handleStartRecording(binding)}
                  onRecordComplete={(combo) => handleRecordComplete(binding, combo)}
                  onRecordRejected={(reason) => handleRecordRejected(binding, reason)}
                  onCancel={() => handleCancelRecording(binding)}
                  onReset={() => handleResetOne(binding)}
                  onUnbind={() => clearWithUndo(binding)}
                  onReassign={() =>
                    notice?.conflict &&
                    handleReassign(binding, notice.conflict.combo, notice.conflict.other)
                  }
                  onDismissNotice={() => setNotice(null)}
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
          icon={<RotateCcw size={ICON_SIZE.sm} />}
          onClick={handleResetAll}
          data-testid="keyboard-settings-reset-all"
          title="Restore the built-in defaults, which are chosen to avoid common shell, tmux, vim, and SSH conflicts on Windows and Linux."
        >
          Reset to safer defaults
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={ICON_SIZE.sm} />}
          onClick={() =>
            void exportCheatSheet(cheatSheetAllPlatforms ? "all" : "current", { experimental })
          }
          data-testid="keyboard-settings-export-pdf"
          title="Save a one-page HTML cheat sheet of all shortcuts"
        >
          Save HTML cheat sheet
        </Button>
        <Field
          label="All platforms"
          layout="checkbox"
          htmlFor="keyboard-settings-cheat-sheet-all-platforms"
        >
          <Checkbox
            id="keyboard-settings-cheat-sheet-all-platforms"
            checked={cheatSheetAllPlatforms}
            onCheckedChange={setCheatSheetAllPlatforms}
            data-testid="keyboard-settings-cheat-sheet-all-platforms"
          />
        </Field>
        <Button
          variant="secondary"
          size="sm"
          icon={<FileDown size={ICON_SIZE.sm} />}
          onClick={handleExportJson}
          data-testid="keyboard-settings-export-json"
          title="Export your custom keyboard shortcuts to a JSON file"
        >
          Export shortcuts
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Upload size={ICON_SIZE.sm} />}
          onClick={handleImportJson}
          data-testid="keyboard-settings-import-json"
          title="Import keyboard shortcuts from a JSON file, replacing your custom bindings"
        >
          Import shortcuts
        </Button>
      </div>
      <ConfirmDialog
        open={pendingReplace !== null}
        title={pendingReplace?.title ?? ""}
        variant="danger"
        message={pendingReplace?.summary ?? ""}
        confirmLabel={pendingReplace?.confirmLabel ?? "Confirm"}
        confirmVariant="danger"
        testIdBase="confirm-keybinding-replace"
        data-testid="confirm-keybinding-replace-dialog"
        onConfirm={() => {
          const replace = pendingReplace;
          setPendingReplace(null);
          replace?.apply();
        }}
        onCancel={() => setPendingReplace(null)}
      />
    </div>
  );
}

/** A reset or import of all keybindings awaiting confirmation (#5375). */
interface PendingReplace {
  title: string;
  /** What changes, e.g. "3 custom bindings will be replaced with …". */
  summary: string;
  confirmLabel: string;
  apply: () => void;
}
