import { useState, useCallback, useMemo } from "react";
import { FileCode, Trash2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "@/store/appStore";
import { registerCustomGrammars } from "@/utils/monacoCustomLanguages";
import type { CustomLanguageGrammar } from "@/types/connection";

interface CustomGrammarsSettingsProps {
  visibleFields?: Set<string>;
}

/** Sanitize a raw string into a valid Monaco language ID. */
function toLanguageId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9+\-_.]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Extract name and a suggested ID from a parsed TextMate grammar object. */
function extractGrammarMeta(obj: Record<string, unknown>): { name: string; suggestedId: string } {
  const rawName = typeof obj.name === "string" ? obj.name : "";
  const name = rawName || "Custom Language";
  return { name, suggestedId: toLanguageId(rawName || "custom-language") };
}

interface ImportDraft {
  grammar: Record<string, unknown>;
  name: string;
  id: string;
  error: string | null;
}

/**
 * Settings panel for importing and managing custom TextMate grammar files.
 *
 * Supports `.tmLanguage.json` files (JSON-format TextMate grammars). The grammar
 * content is stored in `AppSettings.customLanguageGrammars` so it works without
 * the original file being present after import.
 */
export function CustomGrammarsSettings({ visibleFields }: CustomGrammarsSettingsProps) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const show = (field: string) => !visibleFields || visibleFields.has(field);

  const existing = useMemo(
    () => settings.customLanguageGrammars ?? [],
    [settings.customLanguageGrammars]
  );
  const existingIds = useMemo(() => new Set(existing.map((g) => g.id)), [existing]);

  const handleImport = useCallback(async () => {
    setImportError(null);
    let filePath: string | null = null;
    try {
      filePath = await open({
        multiple: false,
        title: "Import TextMate Grammar",
        filters: [{ name: "TextMate Grammar", extensions: ["json"] }],
      });
    } catch {
      return; // dialog cancelled
    }
    if (!filePath) return;

    let text: string;
    try {
      text = await readTextFile(filePath);
    } catch (e) {
      setImportError(`Could not read file: ${String(e)}`);
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      setImportError("File is not valid JSON. Only .tmLanguage.json (JSON format) is supported.");
      return;
    }

    if (typeof parsed.scopeName !== "string" || !parsed.scopeName) {
      setImportError(
        'File does not look like a TextMate grammar — missing required "scopeName" field.'
      );
      return;
    }

    const { name, suggestedId } = extractGrammarMeta(parsed);
    // Ensure the suggested ID does not collide with an existing one.
    let id = suggestedId;
    if (existingIds.has(id)) {
      let i = 2;
      while (existingIds.has(`${suggestedId}-${i}`)) i++;
      id = `${suggestedId}-${i}`;
    }

    setDraft({ grammar: parsed, name, id, error: null });
  }, [existingIds]);

  const handleDraftConfirm = useCallback(() => {
    if (!draft) return;

    const { id, name, grammar } = draft;

    if (!id.trim()) {
      setDraft((d) => d && { ...d, error: "Language ID is required." });
      return;
    }
    if (!/^[a-zA-Z0-9._\-+]+$/.test(id)) {
      setDraft(
        (d) =>
          d && {
            ...d,
            error: "ID may only contain letters, digits, dots, dashes, underscores, and +.",
          }
      );
      return;
    }
    if (existingIds.has(id)) {
      setDraft((d) => d && { ...d, error: `A grammar with ID "${id}" already exists.` });
      return;
    }

    const entry: CustomLanguageGrammar = { id: id.trim(), name: name.trim() || id.trim(), grammar };
    const updated = [...existing, entry];
    updateSettings({ ...settings, customLanguageGrammars: updated });
    void registerCustomGrammars([entry]);
    setDraft(null);
  }, [draft, existing, existingIds, settings, updateSettings]);

  const handleDraftCancel = useCallback(() => setDraft(null), []);

  const handleRemove = useCallback(
    (id: string) => {
      const updated = existing.filter((g) => g.id !== id);
      updateSettings({
        ...settings,
        customLanguageGrammars: updated.length > 0 ? updated : undefined,
      });
    },
    [existing, settings, updateSettings]
  );

  return (
    <div className="settings-panel__category" data-testid="custom-grammars-settings">
      {show("customLanguageGrammars") && (
        <>
          <h3 className="settings-panel__category-title">Custom Language Grammars</h3>

          <div className="settings-panel__section">
            <div className="settings-panel__section-header">
              <h3 className="settings-panel__section-title">Imported Grammars</h3>
              {!draft && (
                <div className="settings-panel__section-actions">
                  <button
                    className="settings-panel__btn settings-panel__btn--primary"
                    onClick={() => void handleImport()}
                    data-testid="custom-grammar-import-btn"
                  >
                    <FileCode size={14} />
                    Import Grammar File
                  </button>
                </div>
              )}
            </div>
            <p className="settings-panel__description">
              Import <code>.tmLanguage.json</code> files (JSON-format TextMate grammars) to add
              syntax highlighting for your own languages. The grammar content is stored in settings
              — the original file is not needed after import. Use the language ID in File Type
              Mappings to associate file extensions with the grammar.
            </p>

            {importError && (
              <p className="settings-panel__file-error" data-testid="custom-grammar-import-error">
                {importError}
              </p>
            )}

            {/* Draft confirmation form */}
            {draft && (
              <div className="settings-panel__section" data-testid="custom-grammar-draft">
                <p className="settings-panel__description">
                  Review and confirm the language ID and name before saving.
                </p>
                <div className="settings-panel__create-prompt">
                  <input
                    className="settings-panel__create-input"
                    type="text"
                    value={draft.id}
                    onChange={(e) =>
                      setDraft((d) => d && { ...d, id: e.target.value, error: null })
                    }
                    placeholder="Language ID (e.g. my-lang)"
                    data-testid="custom-grammar-id-input"
                  />
                  <input
                    className="settings-panel__create-input"
                    type="text"
                    value={draft.name}
                    onChange={(e) =>
                      setDraft((d) => d && { ...d, name: e.target.value, error: null })
                    }
                    placeholder="Display name"
                    data-testid="custom-grammar-name-input"
                  />
                  <button
                    className="settings-panel__btn settings-panel__btn--primary"
                    onClick={handleDraftConfirm}
                    disabled={!draft.id.trim()}
                    data-testid="custom-grammar-confirm-btn"
                  >
                    Save
                  </button>
                  <button
                    className="settings-panel__btn"
                    onClick={handleDraftCancel}
                    data-testid="custom-grammar-cancel-btn"
                  >
                    Cancel
                  </button>
                </div>
                {draft.error && (
                  <p
                    className="settings-panel__file-error"
                    data-testid="custom-grammar-draft-error"
                  >
                    {draft.error}
                  </p>
                )}
              </div>
            )}

            {existing.length === 0 && !draft ? (
              <div className="settings-panel__empty">No custom grammars imported.</div>
            ) : (
              <ul className="settings-panel__file-list">
                {existing.map((g) => (
                  <li key={g.id} className="settings-panel__file-item">
                    <span className="settings-panel__file-path" style={{ fontFamily: "monospace" }}>
                      {g.id}
                    </span>
                    <span
                      className="settings-panel__file-path settings-panel__file-path--disabled"
                      style={{ fontFamily: "monospace" }}
                    >
                      {g.name}
                    </span>
                    <button
                      className="settings-panel__file-remove"
                      onClick={() => handleRemove(g.id)}
                      title={`Remove grammar "${g.name}"`}
                      data-testid={`custom-grammar-remove-${g.id}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
