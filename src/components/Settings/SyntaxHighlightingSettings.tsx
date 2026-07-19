import { AppSettings } from "@/types/connection";
import { Checkbox, Toggle } from "@/components/ui";
import { BUILTIN_RULES, getThemedRuleColor } from "@/services/syntaxHighlightingRules";
import { defaultHighlightingConfig } from "@/services/syntaxHighlightingConfig";
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

interface SyntaxHighlightingSettingsProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  visibleFields?: Set<string>;
}

/**
 * Global settings section for terminal output syntax highlighting.
 *
 * Exposes the master on/off switch plus per-rule enable/disable of the shipped
 * built-in rules (see `services/syntaxHighlightingRules.ts`). Reads and writes
 * the global {@link AppSettings.syntaxHighlighting} config through the same
 * `onChange` the rest of the Settings panel uses, so edits flow through the
 * store's debounced auto-save and live terminals pick them up.
 *
 * The custom-rules editor (#1703) and per-connection override (#1704) are
 * intentionally out of scope here.
 */
export function SyntaxHighlightingSettings({
  settings,
  onChange,
  visibleFields,
}: SyntaxHighlightingSettingsProps) {
  const show = (field: string) => !visibleFields || visibleFields.has(field);
  if (!show("syntaxHighlighting")) return null;

  const config = settings.syntaxHighlighting ?? defaultHighlightingConfig();
  const { enabled } = config;

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
    </div>
  );
}
