import { useMemo } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button, Checkbox, ColorInput, Field, Input } from "@/components/ui";
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

/**
 * Client-side validation schema for a custom highlight rule (UX feedback only;
 * the same checks the editor previously ran by hand, translated 1:1 into zod):
 *
 * - `name` must be non-empty once trimmed.
 * - `style.color` must resolve to a `#RRGGBB` color.
 * - `pattern` must pass the regex-safety gate — validation depends on the
 *   sibling `wholeWord` / `caseSensitive` flags, so it lives in a cross-field
 *   `superRefine` and re-runs whenever any of the three change.
 *
 * The schema mirrors the full {@link HighlightRule} shape so the resolver's
 * value type matches the form's; only `name`, `pattern` and `style.color` are
 * actually validated — the remaining fields (`id`, `enabled`, `priority`,
 * `builtin`, the extra style flags) ride along and are preserved on save.
 */
const customRuleSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    pattern: z.string(),
    style: z.object({
      color: z.string(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
    }),
    caseSensitive: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
    enabled: z.boolean(),
    priority: z.number(),
    builtin: z.boolean(),
  })
  .superRefine((rule, ctx) => {
    if (rule.name.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["name"], message: "Name is required." });
    }
    if (normalizeHexColor(rule.style.color) === null) {
      ctx.addIssue({ code: "custom", path: ["style", "color"], message: "Use a #RRGGBB color." });
    }
    const patternValidation = validateHighlightPattern(rule.pattern, {
      wholeWord: rule.wholeWord,
      caseSensitive: rule.caseSensitive,
    });
    if (!patternValidation.valid) {
      ctx.addIssue({ code: "custom", path: ["pattern"], message: patternValidation.reason });
    }
  });

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
 * Backed by react-hook-form + zod (see {@link customRuleSchema}) — the pattern
 * is validated for regex safety on every edit; an invalid or catastrophic-
 * backtracking (ReDoS) pattern surfaces an inline error and blocks Save, so a
 * dangerous pattern can never be persisted or reach the terminal render loop.
 */
export function CustomRuleEditor({ rule, config, onSave, onCancel }: CustomRuleEditorProps) {
  const isNew = rule === undefined;

  // Seed a fresh rule for the create case once, so the generated id is stable
  // across re-renders and the preview/save keep the same identity.
  const initialRule = useMemo(() => rule ?? createCustomRule(), [rule]);

  const { control, getValues } = useForm<HighlightRule>({
    defaultValues: initialRule,
    resolver: zodResolver(customRuleSchema),
    mode: "onChange",
  });

  // Live form values. `useWatch` can lag the seeded defaults by a render, and it
  // only surfaces registered fields, so merge it over the initial rule to keep a
  // complete draft for the preview and validity checks.
  const watched = useWatch({ control });
  const draft: HighlightRule = {
    ...initialRule,
    ...watched,
    style: { ...initialRule.style, ...watched?.style },
  };

  // Deterministic, synchronous validity derived straight from the schema — the
  // same approach ConnectionSettingsForm uses — rather than react-hook-form's
  // async error proxy, so errors and the Save gate update on the same render as
  // the edit (and stay testable without awaiting).
  const validity = useMemo(() => {
    const errors: Record<string, string> = {};
    const result = customRuleSchema.safeParse(draft);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const key = issue.path.join(".");
        if (!(key in errors)) errors[key] = issue.message;
      }
    }
    return { valid: result.success, errors };
    // `draft` is rebuilt every render from the watched values; keying on its
    // serialization avoids recomputing when nothing actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(draft)]);

  const nameError = validity.errors["name"];
  const patternError = validity.errors["pattern"];
  const colorError = validity.errors["style.color"];
  const canSave = validity.valid;

  const previewLines = useMemo(() => {
    const compiled = compileRules(buildPreviewRules(draft, config));
    return PREVIEW_SAMPLE.map((line) => segmentLine(line, findMatches(line, compiled)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(draft), config]);

  const handleSave = () => {
    if (!canSave) return;
    const current = getValues();
    onSave({
      ...current,
      name: current.name.trim(),
      style: {
        ...current.style,
        color: normalizeHexColor(current.style.color) ?? current.style.color,
      },
    });
  };

  const colorSwatch = normalizeHexColor(draft.style.color) ?? "#000000";

  return (
    <div className="custom-rule-editor" data-testid="custom-rule-editor">
      <div className="custom-rule-editor__title">{isNew ? "New Custom Rule" : "Edit Rule"}</div>

      <Controller
        name="name"
        control={control}
        render={({ field }) => (
          <Field label="Name" htmlFor="custom-rule-name" error={nameError}>
            <Input
              id="custom-rule-name"
              value={field.value ?? ""}
              placeholder="e.g. TODO markers"
              error={!!nameError}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
              data-testid="custom-rule-name"
            />
          </Field>
        )}
      />

      <Controller
        name="pattern"
        control={control}
        render={({ field }) => (
          <Field label="Pattern (regex)" htmlFor="custom-rule-pattern" error={patternError}>
            <Input
              id="custom-rule-pattern"
              value={field.value ?? ""}
              placeholder="e.g. \\b(TODO|FIXME)\\b"
              error={!!patternError}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
              data-testid="custom-rule-pattern"
            />
          </Field>
        )}
      />

      <div className="custom-rule-editor__row">
        <Controller
          name="caseSensitive"
          control={control}
          render={({ field }) => (
            <label className="custom-rule-editor__check">
              <Checkbox
                checked={field.value ?? true}
                onCheckedChange={(checked) => field.onChange(checked)}
                data-testid="custom-rule-case-sensitive"
              />
              Case sensitive
            </label>
          )}
        />
        <Controller
          name="wholeWord"
          control={control}
          render={({ field }) => (
            <label className="custom-rule-editor__check">
              <Checkbox
                checked={field.value ?? false}
                onCheckedChange={(checked) => field.onChange(checked)}
                data-testid="custom-rule-whole-word"
              />
              Whole word
            </label>
          )}
        />
      </div>

      <div className="custom-rule-editor__style">
        <span className="custom-rule-editor__style-label">Style</span>
        <Controller
          name="style.color"
          control={control}
          render={({ field }) => (
            <div className="custom-rule-editor__row">
              <ColorInput
                value={colorSwatch}
                onChange={(e) => field.onChange(e.target.value)}
                aria-label="Highlight color"
                data-testid="custom-rule-color"
              />
              <Input
                value={field.value ?? ""}
                error={!!colorError}
                spellCheck={false}
                autoComplete="off"
                size="sm"
                className="custom-rule-editor__color-hex"
                onChange={(e) => field.onChange(e.target.value)}
                data-testid="custom-rule-color-hex"
                aria-label="Highlight color hex"
              />
            </div>
          )}
        />
        <div className="custom-rule-editor__row">
          <Controller
            name="style.bold"
            control={control}
            render={({ field }) => (
              <label className="custom-rule-editor__check">
                <Checkbox
                  checked={field.value ?? false}
                  onCheckedChange={(checked) => field.onChange(checked)}
                  data-testid="custom-rule-bold"
                />
                Bold
              </label>
            )}
          />
          <Controller
            name="style.italic"
            control={control}
            render={({ field }) => (
              <label className="custom-rule-editor__check">
                <Checkbox
                  checked={field.value ?? false}
                  onCheckedChange={(checked) => field.onChange(checked)}
                  data-testid="custom-rule-italic"
                />
                Italic
              </label>
            )}
          />
          <Controller
            name="style.underline"
            control={control}
            render={({ field }) => (
              <label className="custom-rule-editor__check">
                <Checkbox
                  checked={field.value ?? false}
                  onCheckedChange={(checked) => field.onChange(checked)}
                  data-testid="custom-rule-underline"
                />
                Underline
              </label>
            )}
          />
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
