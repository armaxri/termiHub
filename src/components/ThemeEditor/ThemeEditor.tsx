import { useEffect, useMemo, useState } from "react";
import { Button, Field, Input, Modal, Select } from "@/components/ui";
import type { SelectOption } from "@/components/ui";
import { BASE_THEME_ORDER, COLOR_TOKEN_GROUPS, previewTheme, resolveBaseTheme } from "@/themes";
import type { ThemeColors, ThemeDefinition } from "@/themes/types";
import { normalizeHexColor } from "@/services/syntaxHighlighting";
import "./ThemeEditor.css";

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
 */
export function ThemeEditor({ open, initialTheme, onSave, onCancel }: ThemeEditorProps) {
  const [draft, setDraft] = useState<ThemeDefinition>(initialTheme);

  // Built lazily (not at module load) so partially-mocked `@/themes` in other
  // components' tests never executes this at import time.
  const baseOptions: SelectOption[] = useMemo(
    () => BASE_THEME_ORDER.map((t) => ({ value: t.id, label: t.name })),
    []
  );

  // Reset the draft whenever a different theme is opened for editing.
  useEffect(() => {
    setDraft(initialTheme);
  }, [initialTheme]);

  // Apply the working draft live while the editor is open.
  useEffect(() => {
    if (open) previewTheme(draft);
  }, [open, draft]);

  const baseColors = useMemo(() => resolveBaseTheme(draft.baseTheme).colors, [draft.baseTheme]);

  const nameError = draft.name.trim() === "" ? "Name is required." : undefined;
  const canSave = !nameError;

  const setColor = (key: keyof ThemeColors, value: string) =>
    setDraft((d) => ({ ...d, colors: { ...d.colors, [key]: value } }));

  const resetColor = (key: keyof ThemeColors) => setColor(key, baseColors[key]);

  const handleBaseChange = (baseId: string) => {
    const base = resolveBaseTheme(baseId);
    setDraft((d) => ({
      ...d,
      baseTheme: base.id,
      colorScheme: base.colorScheme,
      colors: { ...base.colors },
    }));
  };

  const handleSave = () => {
    if (!canSave) return;
    onSave({ ...draft, name: draft.name.trim() });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title="Theme Editor"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} data-testid="theme-editor-cancel">
            Cancel
          </Button>
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
        <Field label="Name" htmlFor="theme-editor-name" error={nameError}>
          <Input
            id="theme-editor-name"
            value={draft.name}
            placeholder="My Custom Theme"
            error={!!nameError}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            data-testid="theme-editor-name"
          />
        </Field>

        <Field label="Based on" htmlFor="theme-editor-base">
          <Select
            value={draft.baseTheme ?? "dark"}
            onChange={handleBaseChange}
            options={baseOptions}
            data-testid="theme-editor-base"
          />
        </Field>

        <div className="theme-editor__groups">
          {COLOR_TOKEN_GROUPS.map((group) => (
            <section key={group.label} className="theme-editor__group">
              <h4 className="theme-editor__group-title">{group.label}</h4>
              {group.tokens.map((token) => {
                const value = draft.colors[token.key];
                const isOverridden = value !== baseColors[token.key];
                return (
                  <div key={token.key} className="theme-editor__row">
                    <span className="theme-editor__row-label">{token.label}</span>
                    <input
                      type="color"
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
