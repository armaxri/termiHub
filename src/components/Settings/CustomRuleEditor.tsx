import { useMemo, useState } from "react";
import { Button, Checkbox, Field, Input } from "@/components/ui";
import { compileRules, findMatches, normalizeHexColor } from "@/services/syntaxHighlighting";
import { resolveActiveRules } from "@/services/syntaxHighlightingConfig";
import { getThemedRuleColor } from "@/services/syntaxHighlightingRules";
import { createCustomRule } from "@/services/customHighlightRules";
import { validateHighlightPattern } from "@/services/regexSafety";
import type { HighlightRule, SyntaxHighlightingConfig } from "@/types/syntaxHighlighting";
import "./CustomRuleEditor.css";

/** Sample terminal output shown in the live preview box. */
const PREVIEW_SAMPLE = [
  "$ cat server.log",
  "[INFO] Server started on port 8080",
  "[ERROR] Connection refused to 10.0.0.1",
  "Processing file /tmp/data.csv ...",
  "Result: 42 items found",
];

interface CustomRuleEditorProps {
  /** The rule being edited, or `undefined` to create a new rule. */
  rule?: HighlightRule;
  /**
   * Current global highlighting config. Its active rules are layered under the
   * draft in the preview so the user sees how the new rule interacts with the
   * ones already on.
   */
  config: SyntaxHighlightingConfig;
  /** Called with the finished rule when the user saves a valid rule. */
  onSave: (rule: HighlightRule) => void;
  /** Called when the user cancels without saving. */
  onCancel: () => void;
}

/** A single rendered segment of a preview line. */
interface Segment {
  text: string;
  style?: React.CSSProperties;
}

/** Builds the rule list used for the preview: the draft on top of active rules. */
function buildPreviewRules(
  draft: HighlightRule,
  config: SyntaxHighlightingConfig
): HighlightRule[] {
  const others = resolveActiveRules({
    builtinRules: config.builtinRules,
    customRules: config.customRules,
  })
    .filter((r) => r.id !== draft.id)
    .map((r) => (r.builtin ? { ...r, style: { ...r.style, color: getThemedRuleColor(r.id) } } : r));
  // The draft is placed first and given the lowest priority number so it wins
  // ties, letting the user see its effect clearly.
  return [{ ...draft, enabled: true, priority: -1 }, ...others];
}

/** Splits a line into styled/unstyled segments from its non-overlapping matches. */
function segmentLine(line: string, matches: ReturnType<typeof findMatches>): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) segments.push({ text: line.slice(cursor, match.start) });
    const style = match.rule.style;
    segments.push({
      text: line.slice(match.start, match.end),
      style: {
        color: match.color,
        fontWeight: style.bold ? "bold" : undefined,
        fontStyle: style.italic ? "italic" : undefined,
        textDecoration: style.underline ? "underline" : undefined,
      },
    });
    cursor = match.end;
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor) });
  return segments;
}

/**
 * Inline editor for a single custom highlight rule: name, regex pattern,
 * case-sensitive / whole-word toggles, color + bold/italic/underline, and a
 * live static preview of sample terminal text with the rule (plus the other
 * active rules) applied.
 *
 * The pattern is validated for regex safety on every edit via
 * {@link validateHighlightPattern}; an invalid or catastrophic-backtracking
 * (ReDoS) pattern surfaces an inline error and blocks Save, so a dangerous
 * pattern can never be persisted or reach the terminal render loop.
 */
export function CustomRuleEditor({ rule, config, onSave, onCancel }: CustomRuleEditorProps) {
  const [draft, setDraft] = useState<HighlightRule>(() => rule ?? createCustomRule());
  const isNew = rule === undefined;

  const patternValidation = useMemo(
    () =>
      validateHighlightPattern(draft.pattern, {
        wholeWord: draft.wholeWord,
        caseSensitive: draft.caseSensitive,
      }),
    [draft.pattern, draft.wholeWord, draft.caseSensitive]
  );

  const nameError = draft.name.trim() === "" ? "Name is required." : undefined;
  const colorValid = normalizeHexColor(draft.style.color) !== null;
  const colorError = colorValid ? undefined : "Use a #RRGGBB color.";
  const patternError = patternValidation.valid ? undefined : patternValidation.reason;
  const canSave = !nameError && !colorError && patternValidation.valid;

  const previewLines = useMemo(() => {
    const compiled = compileRules(buildPreviewRules(draft, config));
    return PREVIEW_SAMPLE.map((line) => segmentLine(line, findMatches(line, compiled)));
  }, [draft, config]);

  const setStyle = (patch: Partial<HighlightRule["style"]>) =>
    setDraft((d) => ({ ...d, style: { ...d.style, ...patch } }));

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      ...draft,
      name: draft.name.trim(),
      style: { ...draft.style, color: normalizeHexColor(draft.style.color) ?? draft.style.color },
    });
  };

  const colorSwatch = normalizeHexColor(draft.style.color) ?? "#000000";

  return (
    <div className="custom-rule-editor" data-testid="custom-rule-editor">
      <div className="custom-rule-editor__title">{isNew ? "New Custom Rule" : "Edit Rule"}</div>

      <Field label="Name" htmlFor="custom-rule-name" error={nameError}>
        <Input
          id="custom-rule-name"
          value={draft.name}
          placeholder="e.g. TODO markers"
          error={!!nameError}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          data-testid="custom-rule-name"
        />
      </Field>

      <Field label="Pattern (regex)" htmlFor="custom-rule-pattern" error={patternError}>
        <Input
          id="custom-rule-pattern"
          value={draft.pattern}
          placeholder="e.g. \\b(TODO|FIXME)\\b"
          error={!!patternError}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          onChange={(e) => setDraft((d) => ({ ...d, pattern: e.target.value }))}
          data-testid="custom-rule-pattern"
        />
      </Field>

      <div className="custom-rule-editor__row">
        <label className="custom-rule-editor__check">
          <Checkbox
            checked={draft.caseSensitive ?? true}
            onCheckedChange={(checked) => setDraft((d) => ({ ...d, caseSensitive: checked }))}
            data-testid="custom-rule-case-sensitive"
          />
          Case sensitive
        </label>
        <label className="custom-rule-editor__check">
          <Checkbox
            checked={draft.wholeWord ?? false}
            onCheckedChange={(checked) => setDraft((d) => ({ ...d, wholeWord: checked }))}
            data-testid="custom-rule-whole-word"
          />
          Whole word
        </label>
      </div>

      <div className="custom-rule-editor__style">
        <span className="custom-rule-editor__style-label">Style</span>
        <div className="custom-rule-editor__row">
          <input
            type="color"
            className="custom-rule-editor__color"
            value={colorSwatch}
            onChange={(e) => setStyle({ color: e.target.value })}
            aria-label="Highlight color"
            data-testid="custom-rule-color"
          />
          <Input
            value={draft.style.color}
            error={!!colorError}
            spellCheck={false}
            autoComplete="off"
            size="sm"
            className="custom-rule-editor__color-hex"
            onChange={(e) => setStyle({ color: e.target.value })}
            data-testid="custom-rule-color-hex"
            aria-label="Highlight color hex"
          />
        </div>
        <div className="custom-rule-editor__row">
          <label className="custom-rule-editor__check">
            <Checkbox
              checked={draft.style.bold ?? false}
              onCheckedChange={(checked) => setStyle({ bold: checked })}
              data-testid="custom-rule-bold"
            />
            Bold
          </label>
          <label className="custom-rule-editor__check">
            <Checkbox
              checked={draft.style.italic ?? false}
              onCheckedChange={(checked) => setStyle({ italic: checked })}
              data-testid="custom-rule-italic"
            />
            Italic
          </label>
          <label className="custom-rule-editor__check">
            <Checkbox
              checked={draft.style.underline ?? false}
              onCheckedChange={(checked) => setStyle({ underline: checked })}
              data-testid="custom-rule-underline"
            />
            Underline
          </label>
        </div>
      </div>

      <div className="custom-rule-editor__preview">
        <span className="custom-rule-editor__style-label">Preview</span>
        <pre className="custom-rule-editor__preview-box" data-testid="custom-rule-preview">
          {previewLines.map((segments, i) => (
            <div key={i} className="custom-rule-editor__preview-line">
              {segments.map((seg, j) => (
                <span key={j} style={seg.style}>
                  {seg.text}
                </span>
              ))}
              {"\n"}
            </div>
          ))}
        </pre>
      </div>

      <div className="custom-rule-editor__actions">
        <Button variant="ghost" onClick={onCancel} data-testid="custom-rule-cancel">
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={!canSave}
          data-testid="custom-rule-save"
        >
          {isNew ? "Save Rule" : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
