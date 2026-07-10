import { useState, useEffect, useRef, useCallback } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { Save, Loader2, AlertCircle, Globe, FileEdit, X } from "lucide-react";
import { Button } from "@/components/ui";
import { save } from "@tauri-apps/plugin-dialog";
import { EditorTabMeta, EditorStatus } from "@/types/terminal";
import { useAppStore } from "@/store/appStore";
import { resolveLanguage } from "@/utils/languageMapping";
import { getBasename } from "@/utils/formatters";
import { getAvailableLanguages } from "@/utils/monacoLanguages";
import { getMonacoTheme } from "@/utils/monacoCustomLanguages";
import { getCurrentTheme, onThemeChange } from "@/themes";
import {
  localReadFile,
  localWriteFile,
  sftpReadFileContent,
  sftpWriteFileContent,
} from "@/services/api";
import { UnsavedChangesDialog } from "@/components/ConnectionEditor/UnsavedChangesDialog";
import "./FileEditor.css";

// Use local monaco-editor package instead of CDN (important for Tauri/offline)
loader.config({ monaco });

/**
 * Read current editor status from a Monaco editor instance.
 */
function readEditorStatus(editor: monaco.editor.IStandaloneCodeEditor): EditorStatus {
  const pos = editor.getPosition();
  const model = editor.getModel();
  const options = model?.getOptions();
  return {
    line: pos?.lineNumber ?? 1,
    column: pos?.column ?? 1,
    language: model?.getLanguageId() ?? "plaintext",
    availableLanguages: getAvailableLanguages(),
    eol: model?.getEOL() === "\r\n" ? "CRLF" : "LF",
    tabSize: (options?.tabSize ?? 4) as number,
    insertSpaces: (options?.insertSpaces ?? true) as boolean,
    encoding: "UTF-8",
  };
}

/**
 * Turn a raw save error into a clear, user-facing message. Permission failures
 * (the common case for admin-owned remote files) get a friendly explanation;
 * everything else falls back to the underlying error text.
 */
function formatSaveError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/permission denied|eacces|\bnot permitted\b|access denied/i.test(raw)) {
    return `Permission denied — you don't have write access to this file. (${raw})`;
  }
  return `Save failed: ${raw}`;
}

interface FileEditorProps {
  tabId: string;
  meta: EditorTabMeta;
  isVisible: boolean;
  /** When true, the Monaco model is preserved on unmount (used by zoom overlay instances). */
  keepModel?: boolean;
}

/**
 * Built-in file editor using Monaco Editor.
 * Supports both local and remote (SFTP) files.
 */
export function FileEditor({ tabId, meta, isVisible, keepModel = false }: FileEditorProps) {
  const setEditorDirty = useAppStore((s) => s.setEditorDirty);
  const setEditorStatus = useAppStore((s) => s.setEditorStatus);
  const setEditorActions = useAppStore((s) => s.setEditorActions);
  const fileLanguageMappings = useAppStore((s) => s.settings.fileLanguageMappings);
  const pendingCloseRequest = useAppStore((s) => s.pendingCloseRequest);
  const setPendingCloseRequest = useAppStore((s) => s.setPendingCloseRequest);
  const closeTab = useAppStore((s) => s.closeTab);
  const renameTab = useAppStore((s) => s.renameTab);
  // Subscribe to the theme setting so we re-derive the Monaco theme when the
  // user explicitly switches between dark / light / system in the settings.
  const themeSetting = useAppStore((s) => s.settings.theme);

  const [content, setContent] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Surfaced when a save fails (e.g. permission denied on a remote file). Unlike
  // `error` — which replaces the whole editor for a load failure — this is a
  // dismissible banner shown above the editor so the buffer (and its unsaved
  // changes) stay intact and the user can retry. (#969)
  const [saveError, setSaveError] = useState<string | null>(null);
  // Monaco theme derived from the active termiHub theme.  getCurrentTheme()
  // always returns the resolved theme (dark or light), even when the setting
  // is "system", so this handles all three settings modes correctly.
  const [monacoTheme, setMonacoTheme] = useState(() => getMonacoTheme(getCurrentTheme().id));

  // Path a scratch buffer was saved to via Save As. Once set, the scratch tab
  // behaves like a normal on-disk editor (subsequent saves write here directly).
  const [scratchSavedPath, setScratchSavedPath] = useState<string | null>(null);

  const saveRef = useRef<() => void>(() => {});
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  // A scratch buffer has no on-disk counterpart until the user saves it.
  const isUnsavedScratch = meta.scratch === true && scratchSavedPath === null;
  // The effective path used for display, language detection and saving.
  const effectivePath = scratchSavedPath ?? meta.filePath;
  const fileName = getBasename(effectivePath);
  const detectedLanguage = resolveLanguage(fileName, fileLanguageMappings);
  // Scratch buffers share the synthetic file name, so key the Monaco model on
  // the tab id to avoid two scratch tabs colliding on the same model. Keeping it
  // independent of the file name also preserves the model (and undo history)
  // when the buffer is later renamed via Save As.
  const monacoPath = meta.scratch ? `scratch/${tabId}` : fileName;

  // Re-derive Monaco theme when the settings theme changes (dark / light / system).
  useEffect(() => {
    setMonacoTheme(getMonacoTheme(getCurrentTheme().id));
  }, [themeSetting]);

  // Also update when the OS theme changes while in "system" mode.
  useEffect(() => {
    return onThemeChange(() => {
      setMonacoTheme(getMonacoTheme(getCurrentTheme().id));
    });
  }, []);

  // Load file content on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Scratch buffers are seeded from in-memory content and never read from
    // disk. Content equals savedContent so it is not "modified", but the buffer
    // is still flagged unsaved (see the dirty-tracking effect below) so closing
    // it warns the user.
    if (meta.scratch) {
      const seeded = meta.scratchContent ?? "";
      setContent(seeded);
      setSavedContent(seeded);
      setLoading(false);
      return;
    }

    const loadContent = async () => {
      try {
        let text: string;
        if (meta.isRemote && meta.sftpSessionId) {
          text = await sftpReadFileContent(meta.sftpSessionId, meta.filePath);
        } else {
          text = await localReadFile(meta.filePath);
        }
        if (!cancelled) {
          setContent(text);
          setSavedContent(text);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    };

    loadContent();
    return () => {
      cancelled = true;
    };
  }, [meta.filePath, meta.isRemote, meta.sftpSessionId, meta.scratch, meta.scratchContent]);

  // An unsaved scratch buffer has no on-disk copy, so it is always considered
  // dirty (closing it would lose the captured content) until saved via Save As.
  const isDirty =
    content !== null && savedContent !== null && (isUnsavedScratch || content !== savedContent);

  // Sync dirty state to the store (drives the tab dirty dot and close prompt).
  useEffect(() => {
    if (content === null || savedContent === null) return;
    setEditorDirty(tabId, isDirty);
  }, [isDirty, content, savedContent, tabId, setEditorDirty]);

  // A file that failed to load (e.g. the connection dropped) shows the
  // error-only view, which doesn't render the UnsavedChangesDialog. If such a
  // tab were left marked dirty, TabBar would raise a close prompt that can never
  // be answered, leaving the tab stuck open. It has nothing to save, so clear
  // its dirty flag and resolve any already-pending close request by closing it
  // outright. (#971)
  useEffect(() => {
    if (!error) return;
    setEditorDirty(tabId, false);
    if (pendingCloseRequest?.tabId === tabId) {
      const req = pendingCloseRequest;
      setPendingCloseRequest(null);
      closeTab(req.tabId, req.panelId);
    }
  }, [error, tabId, pendingCloseRequest, setEditorDirty, setPendingCloseRequest, closeTab]);

  const handleSave = useCallback(async () => {
    if (content === null || saving) return;

    // First save of a scratch buffer: ask the user where to write it (Save As).
    // Until a destination is chosen there is nothing to write to disk.
    let targetPath = scratchSavedPath ?? meta.filePath;
    if (isUnsavedScratch) {
      const chosen = await save({ title: "Save terminal content", defaultPath: meta.filePath });
      if (!chosen) return;
      targetPath = chosen;
    }

    setSaving(true);
    setSaveError(null);
    try {
      if (meta.isRemote && meta.sftpSessionId) {
        await sftpWriteFileContent(meta.sftpSessionId, meta.filePath, content);
      } else {
        await localWriteFile(targetPath, content);
      }
      setSavedContent(content);
      if (isUnsavedScratch) {
        // The scratch buffer now lives on disk; behave like a saved file and
        // reflect the chosen file name on the tab.
        setScratchSavedPath(targetPath);
        renameTab(tabId, getBasename(targetPath));
      }
    } catch (err) {
      // Surface the failure: `savedContent` is left untouched, so the buffer
      // stays marked dirty/unsaved and the user can fix permissions and retry.
      console.error("Save failed:", err);
      setSaveError(formatSaveError(err));
    } finally {
      setSaving(false);
    }
  }, [
    content,
    saving,
    isUnsavedScratch,
    scratchSavedPath,
    meta.filePath,
    meta.isRemote,
    meta.sftpSessionId,
    tabId,
    renameTab,
  ]);

  // Keep saveRef up to date for Monaco keybinding
  saveRef.current = handleSave;

  const handleDialogCancel = useCallback(() => {
    setPendingCloseRequest(null);
  }, [setPendingCloseRequest]);

  const handleDialogJustClose = useCallback(() => {
    const req = pendingCloseRequest;
    setPendingCloseRequest(null);
    if (req) closeTab(req.tabId, req.panelId);
  }, [pendingCloseRequest, setPendingCloseRequest, closeTab]);

  const handleDialogSaveAndClose = useCallback(async () => {
    const req = pendingCloseRequest;
    setPendingCloseRequest(null);
    await handleSave();
    if (req) closeTab(req.tabId, req.panelId);
  }, [pendingCloseRequest, setPendingCloseRequest, handleSave, closeTab]);

  const handleEditorMount = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor) => {
      editorRef.current = editor;

      // Tag Monaco's hidden input so the test bridge can target it with pressKey
      // (Ctrl+S, Ctrl+End, …). Monaco renders to a canvas with no addressable
      // input otherwise; this gives the keybinding/cursor path a stable testid.
      editor
        .getDomNode()
        ?.querySelector("textarea.inputarea")
        ?.setAttribute("data-testid", "editor-input");

      editor.addAction({
        id: "termihub-save",
        label: "Save File",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => {
          saveRef.current();
        },
      });

      // Push initial status
      setEditorStatus(readEditorStatus(editor));

      // Update cursor position on change
      editor.onDidChangeCursorPosition(() => {
        setEditorStatus(readEditorStatus(editor));
      });

      // Register actions for status bar interactions
      setEditorActions({
        setIndent: (tabSize: number, insertSpaces: boolean) => {
          const model = editor.getModel();
          if (!model) return;
          model.updateOptions({ tabSize, insertSpaces });
          setEditorStatus(readEditorStatus(editor));
        },
        toggleEol: () => {
          const model = editor.getModel();
          if (!model) return;
          const current = model.getEOL();
          const next =
            current === "\r\n"
              ? monaco.editor.EndOfLineSequence.LF
              : monaco.editor.EndOfLineSequence.CRLF;
          model.setEOL(next);
          setEditorStatus(readEditorStatus(editor));
        },
        setLanguage: (languageId: string) => {
          const model = editor.getModel();
          if (!model) return;
          monaco.editor.setModelLanguage(model, languageId);
          setEditorStatus(readEditorStatus(editor));
        },
      });
    },
    [setEditorStatus, setEditorActions]
  );

  // Push/clear status when visibility changes
  useEffect(() => {
    if (isVisible && editorRef.current) {
      setEditorStatus(readEditorStatus(editorRef.current));
      setEditorActions({
        setIndent: (tabSize: number, insertSpaces: boolean) => {
          const model = editorRef.current?.getModel();
          if (!model) return;
          model.updateOptions({ tabSize, insertSpaces });
          if (editorRef.current) setEditorStatus(readEditorStatus(editorRef.current));
        },
        toggleEol: () => {
          const model = editorRef.current?.getModel();
          if (!model) return;
          const current = model.getEOL();
          const next =
            current === "\r\n"
              ? monaco.editor.EndOfLineSequence.LF
              : monaco.editor.EndOfLineSequence.CRLF;
          model.setEOL(next);
          if (editorRef.current) setEditorStatus(readEditorStatus(editorRef.current));
        },
        setLanguage: (languageId: string) => {
          const model = editorRef.current?.getModel();
          if (!model) return;
          monaco.editor.setModelLanguage(model, languageId);
          if (editorRef.current) setEditorStatus(readEditorStatus(editorRef.current));
        },
      });
    } else if (!isVisible) {
      setEditorStatus(null);
      setEditorActions(null);
    }
  }, [isVisible, setEditorStatus, setEditorActions]);

  // Clear status on unmount
  useEffect(() => {
    return () => {
      setEditorStatus(null);
      setEditorActions(null);
    };
  }, [setEditorStatus, setEditorActions]);

  if (loading) {
    return (
      <div className={`file-editor ${!isVisible ? "file-editor--hidden" : ""}`}>
        <div className="file-editor__loading">
          <Loader2 size={20} className="file-editor__spinner" />
          <span>Loading {fileName}...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`file-editor ${!isVisible ? "file-editor--hidden" : ""}`}>
        <div className="file-editor__error" data-testid="file-editor-error">
          <AlertCircle size={20} />
          <span>Failed to load file: {error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`file-editor ${!isVisible ? "file-editor--hidden" : ""}`}>
      <UnsavedChangesDialog
        open={pendingCloseRequest?.tabId === tabId}
        onCancel={handleDialogCancel}
        onJustClose={handleDialogJustClose}
        onSaveAndClose={handleDialogSaveAndClose}
      />
      <div className="file-editor__toolbar">
        <div className="file-editor__path">
          {meta.isRemote && (
            <span className="file-editor__remote-badge" data-testid="file-editor-remote-badge">
              <Globe size={12} />
              Remote
            </span>
          )}
          {isUnsavedScratch && (
            <span className="file-editor__remote-badge" data-testid="file-editor-scratch-badge">
              <FileEdit size={12} />
              Unsaved
            </span>
          )}
          <span className="file-editor__filepath" title={effectivePath}>
            {effectivePath}
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<Save size={14} />}
          onClick={handleSave}
          disabled={!isDirty}
          pendingLabel="Saving..."
          errorToast={false}
          title={isUnsavedScratch ? "Save As... (Ctrl+S)" : "Save (Ctrl+S)"}
          data-testid="file-editor-save"
        >
          {isUnsavedScratch ? "Save As..." : "Save"}
        </Button>
      </div>
      {saveError && (
        <div className="file-editor__save-error" role="alert" data-testid="file-editor-save-error">
          <AlertCircle size={14} />
          <span className="file-editor__save-error-text">{saveError}</span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<X size={14} />}
            onClick={() => setSaveError(null)}
            title="Dismiss"
            aria-label="Dismiss save error"
            data-testid="file-editor-save-error-dismiss"
          />
        </div>
      )}
      <div className="file-editor__editor-container">
        <Editor
          defaultValue={content ?? ""}
          path={monacoPath}
          language={detectedLanguage}
          theme={monacoTheme}
          keepCurrentModel={keepModel}
          onChange={(value) => setContent(value ?? "")}
          onMount={handleEditorMount}
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            wordWrap: "on",
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    </div>
  );
}
