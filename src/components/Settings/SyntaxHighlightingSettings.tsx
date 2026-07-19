import { useState } from "react";
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react";
import { AppSettings } from "@/types/connection";
import type { HighlightRule } from "@/types/syntaxHighlighting";
import { Button, Checkbox, Toggle } from "@/components/ui";
import { BUILTIN_RULES, getThemedRuleColor } from "@/services/syntaxHighlightingRules";
import { defaultHighlightingConfig } from "@/services/syntaxHighlightingConfig";
import { normalizeHexColor } from "@/services/syntaxHighlighting";
import {
  addCustomRule,
  moveCustomRule,
  removeCustomRule,
  updateCustomRule,
} from "@/services/customHighlightRules";
import { CustomRuleEditor } from "./CustomRuleEditor";
import { SettingsField } from "./SettingsField";
import "./SyntaxHighlightingSettings.css";

/**
 * Short, representative sample text per built-in rule id. Rendered in the rule's
 * own color so the user can preview what each rule recolors without opening a
 * terminal. Keyed by the stable rule id from {@link BUILTIN_RULES}.
 */
const RULE_EXAMPLES: Record<string, string> = {
  "error-keywords": "ERROR: connection refused",
  "warning-keywords": "WARNING: deprecated flag",
  "success-keywords": "build SUCCESS",
  urls: "https://example.com/path",
  "file-paths": "/var/log/syslog",
  "ip-addresses": "192.168.1.42",
  numbers: "count = 1024",
  "quoted-strings": '"hello world"',
  "email-addresses": "user@example.com",
  "mac-addresses": "01:23:45:67:89:ab",
  "dates-times": "2026-07-19T12:00:00",
  uuids: "550e8400-e29b-41d4-a716-446655440000",
  "hex-values": "0xdeadbeef",
};

/** Which custom rule the inline editor is open for, if any. */
type EditorState = { mode: "new" } | { mode: "edit"; id: string } | null;

interface SyntaxHighlightingSettingsProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  visibleFields?: Set<string>;
}

/**
 * Global settings section for terminal output syntax highlighting.
 *
 * Exposes the master on/off switch, per-rule enable/disable of the shipped
 * built-in rules (see `services/syntaxHighlightingRules.ts`), and full
 * management (add / edit / delete / reorder) of user-defined custom rules via
 * the inline {@link CustomRuleEditor}. Reads and writes the global
 * {@link AppSettings.syntaxHighlighting} config through the same `onChange` the
 * rest of the Settings panel uses, so edits flow through the store's debounced
 * auto-save and live terminals pick them up.
 *
 * Custom patterns are validated for regex safety in the editor before they can
 * be saved, so a catastrophic-backtracking (ReDoS) pattern never reaches the
 * persisted config or the terminal render loop.
 */
export function SyntaxHighlightingSettings({
  settings,
  onChange,
  visibleFields,
}: SyntaxHighlightingSettingsProps) {
  const [editor, setEditor] = useState<EditorState>(null);

  const show = (field: string) => !visibleFields || visibleFields.has(field);
  if (!show("syntaxHighlighting")) return null;

  const config = settings.syntaxHighlighting ?? defaultHighlightingConfig();
  const { enabled } = config;
  const customRules = config.customRules;

  const setMaster = (checked: boolean) =>
    onChange({ ...settings, syntaxHighlighting: { ...config, enabled: checked } });

  const setRule = (ruleId: string, checked: boolean) =>
    onChange({
      ...settings,
      syntaxHighlighting: {
        ...config,
        builtinRules: { ...config.builtinRules, [ruleId]: checked },
      },
    });

  const setCustomRules = (rules: HighlightRule[]) =>
    onChange({ ...settings, syntaxHighlighting: { ...config, customRules: rules } });

  const handleSave = (rule: HighlightRule) => {
    const exists = customRules.some((r) => r.id === rule.id);
    setCustomRules(exists ? updateCustomRule(customRules, rule) : addCustomRule(customRules, rule));
    setEditor(null);
  };

  const editingRule =
    editor?.mode === "edit" ? customRules.find((r) => r.id === editor.id) : undefined;

  return (
    <div className="settings-panel__category">
      <h3 className="settings-panel__category-title">Syntax Highlighting</h3>
      <SettingsField
        label="Enable Syntax Highlighting"
        hint="Colorize recognizable patterns (errors, URLs, paths, IPs, …) in plain terminal output. Colors the remote server already set via ANSI are never overridden."
      >
        <Toggle
          checked={enabled}
          onCheckedChange={setMaster}
          data-testid="settings-syntax-highlighting-enabled"
        />
      </SettingsField>

      <div className={`syntax-rules${enabled ? "" : " syntax-rules--dimmed"}`}>
        <span className="syntax-rules__heading">Built-in rules</span>
        {BUILTIN_RULES.map((rule) => {
          const ruleEnabled = config.builtinRules[rule.id] ?? rule.enabled;
          const color = getThemedRuleColor(rule.id);
          return (
            <div className="syntax-rule" key={rule.id}>
              <Checkbox
                checked={ruleEnabled}
                onCheckedChange={(checked) => setRule(rule.id, checked)}
                disabled={!enabled}
                aria-label={rule.name}
                data-testid={`syntax-rule-${rule.id}`}
              />
              <span
                className="syntax-rule__swatch"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              <span className="syntax-rule__name">{rule.name}</span>
              <span className="syntax-rule__example" style={{ color }}>
                {RULE_EXAMPLES[rule.id] ?? rule.name}
              </span>
            </div>
          );
        })}
      </div>

      <div className={`syntax-rules${enabled ? "" : " syntax-rules--dimmed"}`}>
        <div className="syntax-rules__header">
          <span className="syntax-rules__heading">Custom rules</span>
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => setEditor({ mode: "new" })}
            disabled={editor !== null}
            data-testid="syntax-custom-rule-add"
          >
            Add Rule
          </Button>
        </div>

        {customRules.length === 0 && editor?.mode !== "new" ? (
          <span className="syntax-custom-rule__empty" data-testid="syntax-custom-rules-empty">
            No custom rules yet. Add one to highlight your own patterns.
          </span>
        ) : null}

        {customRules.map((rule, index) => {
          const color = normalizeHexColor(rule.style.color) ?? rule.style.color;
          const isEditing = editor?.mode === "edit" && editor.id === rule.id;
          if (isEditing) return null;
          return (
            <div
              className="syntax-custom-rule"
              key={rule.id}
              data-testid={`syntax-custom-rule-${rule.id}`}
            >
              <Checkbox
                checked={rule.enabled}
                onCheckedChange={(checked) =>
                  setCustomRules(updateCustomRule(customRules, { ...rule, enabled: checked }))
                }
                disabled={editor !== null}
                aria-label={`Enable ${rule.name}`}
                data-testid={`syntax-custom-rule-enabled-${rule.id}`}
              />
              <span
                className="syntax-rule__swatch"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              <span className="syntax-rule__name">{rule.name}</span>
              <code className="syntax-custom-rule__pattern">{rule.pattern}</code>
              <div className="syntax-custom-rule__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<ChevronUp size={14} />}
                  aria-label={`Move ${rule.name} up`}
                  disabled={editor !== null || index === 0}
                  onClick={() => setCustomRules(moveCustomRule(customRules, index, index - 1))}
                  data-testid={`syntax-custom-rule-up-${rule.id}`}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<ChevronDown size={14} />}
                  aria-label={`Move ${rule.name} down`}
                  disabled={editor !== null || index === customRules.length - 1}
                  onClick={() => setCustomRules(moveCustomRule(customRules, index, index + 1))}
                  data-testid={`syntax-custom-rule-down-${rule.id}`}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<Pencil size={14} />}
                  aria-label={`Edit ${rule.name}`}
                  disabled={editor !== null}
                  onClick={() => setEditor({ mode: "edit", id: rule.id })}
                  data-testid={`syntax-custom-rule-edit-${rule.id}`}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<Trash2 size={14} />}
                  aria-label={`Delete ${rule.name}`}
                  disabled={editor !== null}
                  onClick={() => setCustomRules(removeCustomRule(customRules, rule.id))}
                  data-testid={`syntax-custom-rule-delete-${rule.id}`}
                />
              </div>
            </div>
          );
        })}

        {editor !== null ? (
          <CustomRuleEditor
            rule={editingRule}
            config={config}
            onSave={handleSave}
            onCancel={() => setEditor(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
