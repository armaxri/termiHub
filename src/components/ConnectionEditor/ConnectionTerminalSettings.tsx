import { useState } from "react";
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { TerminalOptions, LineEnding } from "@/types/terminal";
import type { ConnectionHighlightingOverride, HighlightRule } from "@/types/syntaxHighlighting";
import { DEFAULT_LINE_ENDING, LINE_ENDING_OPTIONS, lineEndingLabel } from "@/utils/lineEndings";
import { Button, Checkbox, Input, NumberInput, Select, Toggle } from "@/components/ui";
import { CustomRuleEditor } from "@/components/Settings/CustomRuleEditor";
import {
  addCustomRule,
  moveCustomRule,
  removeCustomRule,
  updateCustomRule,
} from "@/services/customHighlightRules";
import { defaultHighlightingConfig } from "@/services/syntaxHighlightingConfig";
import "./ConnectionAdditionalRules.css";

interface ConnectionTerminalSettingsProps {
  options: TerminalOptions;
  onChange: (options: TerminalOptions) => void;
}

/**
 * Sentinel for the "use global default" option. Radix Select reserves the empty
 * string to clear the selection, so an explicit non-empty value is required and
 * mapped back to `undefined` (inherit the global setting) at the call site.
 */
const GLOBAL_DEFAULT = "__global__";

/**
 * Compute the next {@link TerminalOptions} when the per-connection syntax
 * highlighting override changes (epic #1696, child #1704).
 *
 * Any connection-specific additional rules are preserved across override
 * changes — they can only be edited elsewhere (#1703). Choosing "global" with
 * no additional rules clears the whole `syntaxHighlighting` override back to
 * `undefined` so the connection cleanly inherits the global setting (and does
 * not count as a persisted terminal override).
 */
export function applyHighlightingOverride(
  options: TerminalOptions,
  override: ConnectionHighlightingOverride
): TerminalOptions {
  const additionalRules = options.syntaxHighlighting?.additionalRules ?? [];
  if (override === "global" && additionalRules.length === 0) {
    return { ...options, syntaxHighlighting: undefined };
  }
  return { ...options, syntaxHighlighting: { override, additionalRules } };
}

/**
 * Compute the next {@link TerminalOptions} when the connection's list of
 * additional highlight rules changes (epic #1696, child #1744).
 *
 * The override is preserved; only the rules change. Clearing the last rule
 * while the override is still "global" collapses the whole `syntaxHighlighting`
 * object back to `undefined` (mirroring {@link applyHighlightingOverride}) so a
 * connection with no override and no extra rules does not persist an empty
 * terminal override.
 */
export function applyAdditionalRules(
  options: TerminalOptions,
  additionalRules: HighlightRule[]
): TerminalOptions {
  const override = options.syntaxHighlighting?.override ?? "global";
  if (override === "global" && additionalRules.length === 0) {
    return { ...options, syntaxHighlighting: undefined };
  }
  return { ...options, syntaxHighlighting: { override, additionalRules } };
}

/** Which per-connection additional rule the inline editor is open for, if any. */
type AdditionalRuleEditorState = { mode: "new" } | { mode: "edit"; id: string } | null;

/**
 * Per-connection "additional highlight rules" editor (#1744).
 *
 * Reuses the global {@link CustomRuleEditor} (regex-safety validated) and the
 * pure custom-rule helpers to add / edit / delete / reorder rules stored in
 * `TerminalOptions.syntaxHighlighting.additionalRules`. These rules are
 * appended after the global rules by `resolveHighlightingConfig` — they can add
 * patterns for this connection but never remove global rules.
 */
function ConnectionAdditionalRules({ options, onChange }: ConnectionTerminalSettingsProps) {
  const globalSettings = useProjectedSettings();
  const [editor, setEditor] = useState<AdditionalRuleEditorState>(null);

  const rules = options.syntaxHighlighting?.additionalRules ?? [];
  const globalConfig = globalSettings.syntaxHighlighting ?? defaultHighlightingConfig();

  const setRules = (next: HighlightRule[]) => onChange(applyAdditionalRules(options, next));

  const handleSave = (rule: HighlightRule) => {
    const exists = rules.some((r) => r.id === rule.id);
    setRules(exists ? updateCustomRule(rules, rule) : addCustomRule(rules, rule));
    setEditor(null);
  };

  const editingRule = editor?.mode === "edit" ? rules.find((r) => r.id === editor.id) : undefined;

  return (
    <div className="settings-form__field">
      <div className="connection-additional-rules__header">
        <span className="settings-form__label">Additional rules for this connection</span>
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus size={14} />}
          onClick={() => setEditor({ mode: "new" })}
          disabled={editor !== null}
          data-testid="connection-additional-rule-add"
        >
          Add Rule
        </Button>
      </div>
      <span className="settings-form__hint">
        Extra highlight rules applied only to this connection, after the global rules. They can add
        patterns but never remove global rules.
      </span>

      {rules.length === 0 && editor?.mode !== "new" ? (
        <span
          className="connection-additional-rules__empty"
          data-testid="connection-additional-rules-empty"
        >
          No connection-specific rules yet. Add one to highlight patterns for this connection only.
        </span>
      ) : null}

      {rules.map((rule, index) => {
        const isEditing = editor?.mode === "edit" && editor.id === rule.id;
        if (isEditing) return null;
        return (
          <div
            className="connection-additional-rule"
            key={rule.id}
            data-testid={`connection-additional-rule-${rule.id}`}
          >
            <Checkbox
              checked={rule.enabled}
              onCheckedChange={(checked) =>
                setRules(updateCustomRule(rules, { ...rule, enabled: checked }))
              }
              disabled={editor !== null}
              aria-label={`Enable ${rule.name}`}
              data-testid={`connection-additional-rule-enabled-${rule.id}`}
            />
            <span
              className="connection-additional-rule__swatch"
              style={{ backgroundColor: rule.style.color }}
              aria-hidden="true"
            />
            <span className="connection-additional-rule__name">{rule.name}</span>
            <code className="connection-additional-rule__pattern">{rule.pattern}</code>
            <div className="connection-additional-rule__actions">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<ChevronUp size={14} />}
                aria-label={`Move ${rule.name} up`}
                disabled={editor !== null || index === 0}
                onClick={() => setRules(moveCustomRule(rules, index, index - 1))}
                data-testid={`connection-additional-rule-up-${rule.id}`}
              />
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<ChevronDown size={14} />}
                aria-label={`Move ${rule.name} down`}
                disabled={editor !== null || index === rules.length - 1}
                onClick={() => setRules(moveCustomRule(rules, index, index + 1))}
                data-testid={`connection-additional-rule-down-${rule.id}`}
              />
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Pencil size={14} />}
                aria-label={`Edit ${rule.name}`}
                disabled={editor !== null}
                onClick={() => setEditor({ mode: "edit", id: rule.id })}
                data-testid={`connection-additional-rule-edit-${rule.id}`}
              />
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Trash2 size={14} />}
                aria-label={`Delete ${rule.name}`}
                disabled={editor !== null}
                onClick={() => setRules(removeCustomRule(rules, rule.id))}
                data-testid={`connection-additional-rule-delete-${rule.id}`}
              />
            </div>
          </div>
        );
      })}

      {editor !== null ? (
        <CustomRuleEditor
          rule={editingRule}
          config={globalConfig}
          onSave={handleSave}
          onCancel={() => setEditor(null)}
        />
      ) : null}
    </div>
  );
}

export function ConnectionTerminalSettings({ options, onChange }: ConnectionTerminalSettingsProps) {
  const globalSettings = useProjectedSettings();

  const globalFontFamily =
    globalSettings.fontFamily || "MesloLGS Nerd Font Mono, Cascadia Code, ...";
  const globalFontSize = globalSettings.fontSize ?? 14;
  const globalScrollback = globalSettings.scrollbackBuffer ?? 10000;
  const globalCursorStyle = globalSettings.cursorStyle ?? "block";
  const globalCursorBlink = globalSettings.cursorBlink ?? true;
  const globalHorizontalScrolling = globalSettings.defaultHorizontalScrolling ?? false;
  const globalLineEnding = globalSettings.defaultLineEnding ?? DEFAULT_LINE_ENDING;
  const globalHighlightingEnabled = globalSettings.syntaxHighlighting?.enabled ?? false;
  const highlightingOverride = options.syntaxHighlighting?.override ?? "global";

  return (
    <div className="settings-panel__category">
      <h3 className="settings-panel__category-title">Terminal</h3>

      <label className="settings-form__field">
        <span className="settings-form__label">Font Family</span>
        <Input
          type="text"
          value={options.fontFamily ?? ""}
          onChange={(e) => onChange({ ...options, fontFamily: e.target.value || undefined })}
          placeholder={`Use global default (${globalFontFamily})`}
        />
        <span className="settings-form__hint">Leave empty to use the global setting.</span>
      </label>

      <label className="settings-form__field">
        <span className="settings-form__label">Font Size</span>
        <NumberInput
          min={8}
          max={72}
          value={options.fontSize ?? ""}
          onValueChange={(v) => onChange({ ...options, fontSize: v === "" ? undefined : v })}
          placeholder={`Use global default (${globalFontSize})`}
        />
        <span className="settings-form__hint">Leave empty to use the global setting.</span>
      </label>

      <label className="settings-form__field">
        <span className="settings-form__label">Scrollback Buffer</span>
        <NumberInput
          min={100}
          max={1000000}
          value={options.scrollbackBuffer ?? ""}
          onValueChange={(v) =>
            onChange({ ...options, scrollbackBuffer: v === "" ? undefined : v })
          }
          placeholder={`Use global default (${globalScrollback})`}
        />
        <span className="settings-form__hint">
          Number of lines kept in scrollback (100–1 000 000). Leave empty for global default. Larger
          values consume more memory — roughly 1–2 MB per 10 000 lines of typical output.
        </span>
      </label>

      <label className="settings-form__field">
        <span className="settings-form__label">Cursor Style</span>
        <Select
          value={options.cursorStyle ?? GLOBAL_DEFAULT}
          onChange={(v) =>
            onChange({
              ...options,
              cursorStyle: v === GLOBAL_DEFAULT ? undefined : (v as "block" | "underline" | "bar"),
            })
          }
          options={[
            { value: GLOBAL_DEFAULT, label: `Use global default (${globalCursorStyle})` },
            { value: "block", label: "Block" },
            { value: "underline", label: "Underline" },
            { value: "bar", label: "Bar" },
          ]}
          aria-label="Cursor Style"
        />
      </label>

      <label className="settings-form__field">
        <span className="settings-form__label">Line Ending (Enter &amp; Paste)</span>
        <Select
          value={options.lineEnding ?? GLOBAL_DEFAULT}
          onChange={(v) =>
            onChange({
              ...options,
              lineEnding: v === GLOBAL_DEFAULT ? undefined : (v as LineEnding),
            })
          }
          options={[
            {
              value: GLOBAL_DEFAULT,
              label: `Use global default (${lineEndingLabel(globalLineEnding)})`,
            },
            ...LINE_ENDING_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label })),
          ]}
          aria-label="Line Ending (Enter & Paste)"
        />
        <span className="settings-form__hint">
          Sequence sent on Enter and used to normalize pasted text for this connection.
        </span>
      </label>

      <div className="settings-form__field">
        <span className="settings-form__label">Log Session Output</span>
        <Toggle
          checked={options.logToFile ?? false}
          onCheckedChange={(v) =>
            onChange({
              ...options,
              logToFile: v || undefined,
              // Drop the timestamp sub-option when logging is turned off so the
              // connection does not persist a dangling override.
              logTimestamps: v ? options.logTimestamps : undefined,
            })
          }
          aria-label="Log Session Output"
          data-testid="connection-log-to-file"
        />
        <span className="settings-form__hint">
          Write this connection&rsquo;s session output to a file on connect (
          <code>&lt;connection&gt;-&lt;timestamp&gt;.log</code>). The terminal toolbar can also
          start and stop logging on demand.
        </span>
      </div>

      {options.logToFile ? (
        <div className="settings-form__field">
          <span className="settings-form__label">Timestamp Each Line</span>
          <Toggle
            checked={options.logTimestamps ?? false}
            onCheckedChange={(v) => onChange({ ...options, logTimestamps: v || undefined })}
            aria-label="Timestamp Each Line"
            data-testid="connection-log-timestamps"
          />
          <span className="settings-form__hint">Prefix each logged line with a timestamp.</span>
        </div>
      ) : null}

      <div className="settings-form__field">
        <span className="settings-form__label">Cursor Blink</span>
        <Toggle
          checked={options.cursorBlink ?? globalCursorBlink}
          onCheckedChange={(v) => onChange({ ...options, cursorBlink: v })}
          aria-label="Cursor Blink"
        />
        <span className="settings-form__hint">
          Whether the terminal cursor blinks.
          {options.cursorBlink != null && (
            <button
              type="button"
              className="settings-form__hint-action"
              onClick={() => onChange({ ...options, cursorBlink: undefined })}
            >
              Reset to global default
            </button>
          )}
        </span>
      </div>

      <div className="settings-form__field">
        <span className="settings-form__label">Horizontal Scrolling</span>
        <Toggle
          checked={options.horizontalScrolling ?? globalHorizontalScrolling}
          onCheckedChange={(v) => onChange({ ...options, horizontalScrolling: v })}
          aria-label="Horizontal Scrolling"
        />
        <span className="settings-form__hint">
          Enable horizontal scrolling for this connection.
          {options.horizontalScrolling != null && (
            <button
              type="button"
              className="settings-form__hint-action"
              onClick={() => onChange({ ...options, horizontalScrolling: undefined })}
            >
              Reset to global default
            </button>
          )}
        </span>
      </div>

      <label className="settings-form__field">
        <span className="settings-form__label">Syntax Highlighting</span>
        <Select
          value={highlightingOverride}
          onChange={(v) =>
            onChange(applyHighlightingOverride(options, v as ConnectionHighlightingOverride))
          }
          options={[
            {
              value: "global",
              label: `Use global default (${globalHighlightingEnabled ? "on" : "off"})`,
            },
            { value: "always-on", label: "Always on" },
            { value: "always-off", label: "Always off" },
          ]}
          aria-label="Syntax Highlighting"
          data-testid="connection-syntax-highlighting"
        />
        <span className="settings-form__hint">
          Override terminal output syntax highlighting for this connection. &ldquo;Use global
          default&rdquo; follows the global setting; &ldquo;Always on/off&rdquo; forces it for this
          connection regardless of the global switch.
        </span>
      </label>

      <ConnectionAdditionalRules options={options} onChange={onChange} />
    </div>
  );
}
