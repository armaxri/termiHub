import { useState, useCallback } from "react";
import { Plus, Trash2, RotateCcw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { BUILT_IN_FILENAME_MAPPINGS, BUILT_IN_EXTENSION_MAPPINGS } from "@/utils/languageMapping";

/** Combined view of a built-in mapping row (shown in the reference table). */
interface BuiltInRow {
  pattern: string;
  language: string;
  kind: "filename" | "extension";
}

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
];

interface FileTypeSettingsProps {
  visibleFields?: Set<string>;
}

/**
 * Settings panel for configuring custom file-type → language mappings.
 * User overrides take precedence over the built-in defaults.
 */
export function FileTypeSettings({ visibleFields }: FileTypeSettingsProps) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const userMappings = settings.fileLanguageMappings ?? {};

  const [newPattern, setNewPattern] = useState("");
  const [newLanguage, setNewLanguage] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const show = (field: string) => !visibleFields || visibleFields.has(field);

  const handleAdd = useCallback(() => {
    const pattern = newPattern.trim();
    const language = newLanguage.trim();

    if (!pattern) {
      setAddError("Pattern is required.");
      return;
    }
    if (!language) {
      setAddError("Language ID is required.");
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
  }, [newPattern, newLanguage, userMappings, settings, updateSettings]);

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

  const handleResetAll = useCallback(() => {
    updateSettings({ ...settings, fileLanguageMappings: undefined });
  }, [settings, updateSettings]);

  const userEntries = Object.entries(userMappings);

  return (
    <div className="settings-panel__category" data-testid="settings-editor">
      {show("fileLanguageMappings") && (
        <>
          <h3 className="settings-panel__category-title">Editor</h3>

          {/* User overrides section */}
          <div className="settings-panel__section">
            <div className="settings-panel__section-header">
              <h3 className="settings-panel__section-title">Custom File Type Mappings</h3>
              {userEntries.length > 0 && (
                <div className="settings-panel__section-actions">
                  <button
                    className="settings-panel__btn"
                    onClick={handleResetAll}
                    title="Remove all custom mappings"
                  >
                    <RotateCcw size={14} />
                    Reset All
                  </button>
                </div>
              )}
            </div>
            <p className="settings-panel__description">
              Override the built-in language detection. Use exact filenames (e.g.{" "}
              <code>Jenkinsfile</code>) or extensions (e.g. <code>.conf</code>). Values must be
              valid Monaco language IDs (e.g. <code>groovy</code>, <code>ini</code>,{" "}
              <code>shell</code>).
            </p>

            {/* Add new mapping */}
            <div className="settings-panel__create-prompt">
              <input
                className="settings-panel__create-input"
                type="text"
                value={newPattern}
                onChange={(e) => {
                  setNewPattern(e.target.value);
                  setAddError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                }}
                placeholder="Filename or .ext"
                data-testid="file-type-pattern-input"
              />
              <input
                className="settings-panel__create-input"
                type="text"
                value={newLanguage}
                onChange={(e) => {
                  setNewLanguage(e.target.value);
                  setAddError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                }}
                placeholder="Language ID (e.g. groovy)"
                data-testid="file-type-language-input"
              />
              <button
                className="settings-panel__btn settings-panel__btn--primary"
                onClick={handleAdd}
                disabled={!newPattern.trim() || !newLanguage.trim()}
                data-testid="file-type-add-btn"
              >
                <Plus size={14} />
                Add
              </button>
            </div>
            {addError && (
              <p className="settings-panel__file-error" data-testid="file-type-add-error">
                {addError}
              </p>
            )}

            {/* Existing overrides */}
            {userEntries.length === 0 ? (
              <div className="settings-panel__empty">No custom mappings configured.</div>
            ) : (
              <ul className="settings-panel__file-list">
                {userEntries.map(([pattern, language]) => (
                  <li key={pattern} className="settings-panel__file-item">
                    <span className="settings-panel__file-path" style={{ fontFamily: "monospace" }}>
                      {pattern}
                    </span>
                    <span
                      className="settings-panel__file-path settings-panel__file-path--disabled"
                      style={{ fontFamily: "monospace" }}
                    >
                      → {language}
                    </span>
                    <button
                      className="settings-panel__file-remove"
                      onClick={() => handleRemove(pattern)}
                      title={`Remove mapping for ${pattern}`}
                      data-testid={`file-type-remove-${pattern}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Built-in reference table */}
          <div className="settings-panel__section">
            <div className="settings-panel__section-header">
              <h3 className="settings-panel__section-title">Built-in Defaults</h3>
            </div>
            <p className="settings-panel__description">
              These mappings are applied automatically. Add a custom mapping above to override any
              of them.
            </p>
            <ul className="settings-panel__file-list">
              {ALL_BUILT_IN_ROWS.map(({ pattern, language }) => (
                <li key={pattern} className="settings-panel__file-item">
                  <span className="settings-panel__file-path" style={{ fontFamily: "monospace" }}>
                    {pattern}
                  </span>
                  <span
                    className="settings-panel__file-path settings-panel__file-path--disabled"
                    style={{ fontFamily: "monospace" }}
                  >
                    → {language}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
