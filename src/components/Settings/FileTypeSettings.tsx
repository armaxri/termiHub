import { useState, useCallback, useRef, useMemo, useId } from "react";
import { Plus, Trash2, RotateCcw, Copy, ChevronDown, ChevronRight } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { BUILT_IN_FILENAME_MAPPINGS, BUILT_IN_EXTENSION_MAPPINGS } from "@/utils/languageMapping";
import { getAvailableLanguages } from "@/utils/monacoLanguages";
import { Button, ConfirmDialog, Input, SearchInput, Tooltip, EmptyState } from "@/components/ui";
import { compareNames } from "@/utils/locale";
import { isImeComposing } from "@/utils/imeComposition";
import { itemMatchesQuery } from "@/hooks/useListFilter";
import type { LanguageInfo } from "@/types/terminal";
import { SettingsSectionHeading } from "./SettingsSectionHeading";
import { SettingsHelpTip } from "./SettingsHelpTip";
import { FileTypeLanguagePicker } from "./FileTypeLanguagePicker";
import { FileTypeBuiltInTable, type BuiltInRow } from "./FileTypeBuiltInTable";
import "./FileTypeSettings.css";

const ALL_BUILT_IN_ROWS: BuiltInRow[] = [
  ...Object.entries(BUILT_IN_FILENAME_MAPPINGS).map(([pattern, language]) => ({
    pattern,
    language,
    kind: "filename" as const,
  })),
  ...Object.entries(BUILT_IN_EXTENSION_MAPPINGS).map(([pattern, language]) => ({
    pattern,
    language,
    kind: "extension" as const,
  })),
].sort((a, b) => {
  // Strip leading dot so ".gitignore" sorts near "g", ".zshrc" near "z", etc.
  const keyA = a.pattern.replace(/^\./, "").toLowerCase();
  const keyB = b.pattern.replace(/^\./, "").toLowerCase();
  return compareNames(keyA, keyB);
});

/**
 * Built-in rows whose pattern or language matches `query` (shared substring
 * matcher, case- and diacritic-insensitive). An empty query keeps every row.
 */
export function filterBuiltInRows(rows: readonly BuiltInRow[], query: string): BuiltInRow[] {
  const q = query.trim();
  if (!q) return [...rows];
  return rows.filter((r) => itemMatchesQuery(r, (row) => [row.pattern, row.language], q));
}

/**
 * The languages the picker offers: every language the editor knows, plus any
 * language a built-in mapping uses that is not registered yet, so copying a
 * built-in row into the form always lands on a listed language (#5841).
 */
export function mappingLanguageOptions(available: readonly LanguageInfo[]): LanguageInfo[] {
  const known = new Set(available.map((l) => l.id));
  const extra: LanguageInfo[] = [];
  for (const { language } of ALL_BUILT_IN_ROWS) {
    if (!known.has(language)) {
      known.add(language);
      extra.push({ id: language, name: language });
    }
  }
  return [...available, ...extra].sort((a, b) => compareNames(a.name, b.name));
}

interface FileTypeSettingsProps {
  visibleFields?: Set<string>;
}

/**
 * Settings panel for configuring custom file-type → language mappings.
 * User overrides take precedence over the built-in defaults.
 */
export function FileTypeSettings({ visibleFields }: FileTypeSettingsProps) {
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);

  const userMappings = useMemo(
    () => settings.fileLanguageMappings ?? {},
    [settings.fileLanguageMappings]
  );

  const [newPattern, setNewPattern] = useState("");
  const [newLanguage, setNewLanguage] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const languageInputRef = useRef<HTMLButtonElement>(null);
  const languages = useMemo(() => mappingLanguageOptions(getAvailableLanguages()), []);
  const languageIds = useMemo(() => new Set(languages.map((l) => l.id)), [languages]);
  // Built-in mappings stay folded away until asked for (#5841): the page's task
  // is adding a mapping, and the full table is ~100 rows.
  const [builtInsOpen, setBuiltInsOpen] = useState(false);
  const [builtInQuery, setBuiltInQuery] = useState("");
  const builtInListId = useId();
  const addErrorId = useId();
  const visibleBuiltIns = useMemo(
    () => filterBuiltInRows(ALL_BUILT_IN_ROWS, builtInQuery),
    [builtInQuery]
  );

  const show = (field: string) => !visibleFields || visibleFields.has(field);

  const handleAdd = useCallback(() => {
    const pattern = newPattern.trim();
    const language = newLanguage.trim();

    if (!pattern) {
      setAddError("Pattern is required.");
      return;
    }
    if (!language) {
      setAddError("Choose a language.");
      return;
    }
    if (!languageIds.has(language)) {
      setAddError(`"${language}" is not a known language. Choose one from the list.`);
      return;
    }
    if (!/^[a-zA-Z0-9._\-+]+$/.test(pattern)) {
      setAddError("Pattern may only contain letters, digits, dots, dashes, underscores, and +.");
      return;
    }

    const updated = { ...userMappings, [pattern]: language };
    updateSettings({ ...settings, fileLanguageMappings: updated });
    setNewPattern("");
    setNewLanguage("");
    setAddError(null);
  }, [newPattern, newLanguage, languageIds, userMappings, settings, updateSettings]);

  const handleRemove = useCallback(
    (pattern: string) => {
      const updated = { ...userMappings };
      delete updated[pattern];
      updateSettings({
        ...settings,
        fileLanguageMappings: Object.keys(updated).length > 0 ? updated : undefined,
      });
    },
    [userMappings, settings, updateSettings]
  );

  // Reset all removes every custom mapping, so it asks first (#5375).
  const [confirmingReset, setConfirmingReset] = useState(false);
  const handleResetAll = useCallback(() => {
    setConfirmingReset(false);
    updateSettings({ ...settings, fileLanguageMappings: undefined });
  }, [settings, updateSettings]);

  /** Pre-fill the add form with a built-in row so the user can override it. */
  const handlePrefillOverride = useCallback((pattern: string, language: string) => {
    setNewPattern(pattern);
    setNewLanguage(language);
    setAddError(null);
    languageInputRef.current?.focus();
  }, []);

  const userEntries = Object.entries(userMappings);

  return (
    <div className="settings-panel__category" data-testid="settings-editor">
      {show("fileLanguageMappings") && (
        <>
          <SettingsSectionHeading>Editor</SettingsSectionHeading>

          {/* User overrides section */}
          <div className="settings-panel__section">
            <div className="settings-panel__section-header">
              <SettingsSectionHeading>Custom file type mappings</SettingsSectionHeading>
              {userEntries.length > 0 && (
                <div className="settings-panel__section-actions">
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<RotateCcw size={14} />}
                    onClick={() => setConfirmingReset(true)}
                    title="Remove all custom mappings"
                    data-testid="file-type-reset-all"
                  >
                    Reset all
                  </Button>
                </div>
              )}
            </div>
            <p className="settings-panel__description">
              Choose the language a file opens in. Your mappings win over the built-in ones.{" "}
              <SettingsHelpTip name="Custom file type mappings" data-testid="file-type-help">
                Use an exact filename such as <code>Jenkinsfile</code> or an extension such as{" "}
                <code>.conf</code>. Letters, digits, dots, dashes, underscores and + only.
              </SettingsHelpTip>
            </p>

            {/* Add new mapping */}
            <div className="settings-panel__create-prompt">
              <Input
                className="settings-panel__create-input"
                value={newPattern}
                onChange={(e) => {
                  setNewPattern(e.target.value);
                  setAddError(null);
                }}
                onKeyDown={(e) => {
                  if (isImeComposing(e)) return;
                  if (e.key === "Enter") handleAdd();
                }}
                placeholder="Filename or .ext"
                data-testid="file-type-pattern-input"
              />
              <FileTypeLanguagePicker
                ref={languageInputRef}
                value={newLanguage}
                languages={languages}
                onChange={(id) => {
                  setNewLanguage(id);
                  setAddError(null);
                }}
                aria-invalid={addError ? true : undefined}
                aria-describedby={addError ? addErrorId : undefined}
              />
              <Button
                variant="primary"
                size="sm"
                icon={<Plus size={14} />}
                onClick={handleAdd}
                disabled={!newPattern.trim() || !newLanguage.trim()}
                data-testid="file-type-add-btn"
              >
                Add
              </Button>
            </div>
            {addError && (
              <p
                id={addErrorId}
                className="settings-panel__file-error"
                role="alert"
                data-testid="file-type-add-error"
              >
                {addError}
              </p>
            )}

            {/* Existing overrides */}
            {userEntries.length === 0 ? (
              <EmptyState variant="panel" title="No custom mappings configured." />
            ) : (
              <ul className="settings-panel__file-list">
                {userEntries.map(([pattern, language]) => (
                  <li
                    key={pattern}
                    className="settings-panel__file-item file-type-settings__custom-row"
                    data-testid={`file-type-custom-row-${pattern}`}
                  >
                    <span className="settings-panel__file-path" style={{ fontFamily: "monospace" }}>
                      {pattern}
                    </span>
                    <span
                      className="settings-panel__file-path file-type-settings__custom-language"
                      style={{ fontFamily: "monospace" }}
                      data-testid={`file-type-custom-language-${pattern}`}
                    >
                      → {language}
                    </span>
                    {!languageIds.has(language) && (
                      <span
                        className="settings-panel__badge file-type-settings__badge"
                        data-testid={`file-type-unknown-language-${pattern}`}
                      >
                        unknown language
                      </span>
                    )}
                    <Tooltip content={`Remove mapping for ${pattern}`}>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon={<Trash2 size={14} />}
                        onClick={() => handleRemove(pattern)}
                        aria-label={`Remove mapping for ${pattern}`}
                        data-testid={`file-type-remove-${pattern}`}
                      />
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Built-in reference table, folded away by default (#5841). */}
          <div className="settings-panel__section" data-testid="file-type-builtin-section">
            <div className="settings-panel__section-header">
              <SettingsSectionHeading>Built-in mappings</SettingsSectionHeading>
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={builtInsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              aria-expanded={builtInsOpen}
              aria-controls={builtInListId}
              onClick={() => setBuiltInsOpen((v) => !v)}
              data-testid="file-type-builtin-disclosure"
            >
              {builtInsOpen
                ? "Hide built-in mappings"
                : `Show built-in mappings (${ALL_BUILT_IN_ROWS.length})`}
            </Button>
            {builtInsOpen && (
              <div id={builtInListId} className="file-type-settings__builtins">
                <p className="settings-panel__description">
                  These apply automatically. Click{" "}
                  <Copy size={11} style={{ display: "inline", verticalAlign: "middle" }} /> to copy
                  one into the form above and change it.
                </p>
                <SearchInput
                  size="sm"
                  className="file-type-settings__builtin-filter"
                  placeholder="Filter by file or language"
                  aria-label="Filter built-in mappings"
                  value={builtInQuery}
                  onValueChange={setBuiltInQuery}
                  clearLabel="Clear built-in mapping filter"
                  data-testid="file-type-builtin-filter"
                />
                {visibleBuiltIns.length === 0 ? (
                  <EmptyState
                    variant="panel"
                    title="No built-in mapping matches this filter."
                    data-testid="file-type-builtin-no-match"
                  />
                ) : (
                  <FileTypeBuiltInTable
                    rows={visibleBuiltIns}
                    userMappings={userMappings}
                    onCopy={handlePrefillOverride}
                  />
                )}
              </div>
            )}
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmingReset}
        title="Reset all file type mappings?"
        variant="danger"
        message={`${userEntries.length} custom mapping${userEntries.length === 1 ? "" : "s"} will be removed. Files then open with the built-in language detection.`}
        confirmLabel="Reset all"
        confirmVariant="danger"
        testIdBase="confirm-file-type-reset"
        data-testid="confirm-file-type-reset-dialog"
        onConfirm={handleResetAll}
        onCancel={() => setConfirmingReset(false)}
      />
    </div>
  );
}
