import { useEffect, useMemo, useState } from "react";
import { Controller } from "react-hook-form";
import { z } from "zod";
import { useZodEditorForm } from "@/hooks/useZodEditorForm";
import { Button, ColorInput, Field, Input, Modal, ModalClose, Select } from "@/components/ui";
import type { SelectOption } from "@/components/ui";
import { BASE_THEME_ORDER, COLOR_TOKEN_GROUPS, previewTheme, resolveBaseTheme } from "@/themes";
import type { ThemeColors, ThemeDefinition } from "@/themes/types";
import { normalizeHexColor } from "@/services/syntaxHighlighting";
import { draftKey as toDraftKey } from "@/utils/draftKey";
import "./ThemeEditor.css";

/**
 * The scalar meta fields of a theme that the form owns. The color grid
 * ({@link ThemeColors}) is deliberately kept out of react-hook-form and held as
 * imperative local state: it is a large, dynamically-keyed value with a live
 * per-token preview side effect that does not benefit from RHF's field model.
 */
type ThemeMeta = Pick<ThemeDefinition, "id" | "name" | "colorScheme" | "baseTheme">;

/** Extract the form-owned meta fields from a full theme definition. */
function metaOf(theme: ThemeDefinition): ThemeMeta {
  return {
    id: theme.id,
    name: theme.name,
    colorScheme: theme.colorScheme,
    baseTheme: theme.baseTheme,
  };
}

/**
 * Client-side validation schema for a theme's scalar meta fields (UX feedback
 * only; the same check the editor previously ran by hand, translated 1:1 into
 * zod): `name` must be non-empty once trimmed. The other meta fields ride along
 * and are preserved on save.
 */
const themeMetaSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    colorScheme: z.enum(["dark", "light"]),
    baseTheme: z.string().optional(),
  })
  .superRefine((meta, ctx) => {
    if (meta.name.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["name"], message: "Name is required." });
    }
  });

interface ThemeEditorProps {
  /** Whether the editor modal is open. */
  open: boolean;
  /**
   * The theme to edit. For a new theme, pass a fresh `createCustomTheme(...)`;
   * to edit an existing one, pass a copy of it. Treated as the initial draft.
   */
  initialTheme: ThemeDefinition;
  /** Called with the finished theme when the user saves a valid theme. */
  onSave: (theme: ThemeDefinition) => void;
  /** Called when the user cancels or dismisses without saving. */
  onCancel: () => void;
}

/**
 * Resolve a token value to a `#RRGGBB` string the native color input accepts.
 * Non-hex values (e.g. `rgba(...)`) fall back to black for the swatch while the
 * true value stays visible/editable in the adjacent hex text field.
 */
function toSwatch(value: string): string {
  return normalizeHexColor(value) ?? "#000000";
}

/**
 * Modal editor for a single custom color theme. Presents the theme name, a base
 * theme selector, and every editable color token grouped by section with a
 * swatch + hex field + per-token reset. Edits are applied live to the whole app
 * via {@link previewTheme}; the parent restores the persisted theme on cancel.
 *
 * The scalar meta fields (name, base theme) are backed by react-hook-form + zod
 * (see {@link themeMetaSchema}); the name is required and gates Save. The color
 * grid and its live-preview side effect stay imperative local state.
 */
export function ThemeEditor({ open, initialTheme, onSave, onCancel }: ThemeEditorProps) {
  // The shared RHF + zod scaffold (UISF2-003): `meta` is a complete, stable
  // snapshot of the form-owned fields.
  const {
    form: { control, getValues, reset, setValue },
    draft: meta,
    errors,
    canSave,
  } = useZodEditorForm<ThemeMeta>({ schema: themeMetaSchema, defaultValues: metaOf(initialTheme) });

  // The color grid is held imperatively (see {@link ThemeMeta}).
  const [colors, setColors] = useState<ThemeColors>(initialTheme.colors);

  // Built lazily (not at module load) so partially-mocked `@/themes` in other
  // components' tests never executes this at import time.
  const baseOptions: SelectOption[] = useMemo(
    () => BASE_THEME_ORDER.map((t) => ({ value: t.id, label: t.name })),
    []
  );

  // Reset both halves of the draft whenever a different theme is opened.
  useEffect(() => {
    reset(metaOf(initialTheme));
    setColors(initialTheme.colors);
  }, [initialTheme, reset]);

  const draft: ThemeDefinition = useMemo(() => ({ ...meta, colors }), [meta, colors]);

  // Apply the working draft live while the editor is open.
  useEffect(() => {
    if (open) previewTheme(draft);
  }, [open, draft]);

  const baseColors = useMemo(() => resolveBaseTheme(meta.baseTheme).colors, [meta.baseTheme]);

  // Any difference from the opened theme (a colour pick, a rename, a new base)
  // arms the Modal's dismiss guard (UX2-004).
  const isDirty =
    toDraftKey(draft) !== toDraftKey({ ...metaOf(initialTheme), colors: initialTheme.colors });

  const nameError = errors["name"];

  const setColor = (key: keyof ThemeColors, value: string) =>
    setColors((c) => ({ ...c, [key]: value }));

  const resetColor = (key: keyof ThemeColors) => setColor(key, baseColors[key]);

  const handleBaseChange = (baseId: string) => {
    const base = resolveBaseTheme(baseId);
    setValue("baseTheme", base.id);
    setValue("colorScheme", base.colorScheme);
    setColors({ ...base.colors });
  };

  const handleSave = () => {
    if (!canSave) return;
    const current = getValues();
    onSave({ ...current, name: current.name.trim(), colors });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      dirty={isDirty}
      title="Theme Editor"
      data-testid="theme-editor-dialog"
      footer={
        <>
          {/* Routed through the Modal so unsaved picks ask first (UX2-004). */}
          <ModalClose>
            <Button variant="ghost" data-testid="theme-editor-cancel">
              Cancel
            </Button>
          </ModalClose>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!canSave}
            data-testid="theme-editor-save"
          >
            Save Theme
          </Button>
        </>
      }
    >
      <div className="theme-editor" data-testid="theme-editor">
        <Controller
          name="name"
          control={control}
          render={({ field }) => (
            <Field label="Name" htmlFor="theme-editor-name" error={nameError}>
              <Input
                id="theme-editor-name"
                value={field.value ?? ""}
                placeholder="My Custom Theme"
                error={!!nameError}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
                data-testid="theme-editor-name"
              />
            </Field>
          )}
        />

        <Controller
          name="baseTheme"
          control={control}
          render={({ field }) => (
            <Field label="Based on" htmlFor="theme-editor-base">
              <Select
                value={field.value ?? "dark"}
                onChange={handleBaseChange}
                options={baseOptions}
                data-testid="theme-editor-base"
              />
            </Field>
          )}
        />

        <div className="theme-editor__groups">
          {COLOR_TOKEN_GROUPS.map((group) => (
            <section key={group.label} className="theme-editor__group">
              <h4 className="theme-editor__group-title">{group.label}</h4>
              {group.tokens.map((token) => {
                const value = colors[token.key];
                const isOverridden = value !== baseColors[token.key];
                return (
                  <div key={token.key} className="theme-editor__row">
                    <span className="theme-editor__row-label">{token.label}</span>
                    <ColorInput
                      className="theme-editor__swatch"
                      value={toSwatch(value)}
                      onChange={(e) => setColor(token.key, e.target.value)}
                      aria-label={`${group.label} ${token.label} color`}
                      data-testid={`theme-editor-swatch-${token.key}`}
                    />
                    <Input
                      value={value}
                      spellCheck={false}
                      autoComplete="off"
                      size="sm"
                      className="theme-editor__hex"
                      onChange={(e) => setColor(token.key, e.target.value)}
                      aria-label={`${group.label} ${token.label} hex`}
                      data-testid={`theme-editor-hex-${token.key}`}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => resetColor(token.key)}
                      disabled={!isOverridden}
                      data-testid={`theme-editor-reset-${token.key}`}
                    >
                      Reset
                    </Button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}
