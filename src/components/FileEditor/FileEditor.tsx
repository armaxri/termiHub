import { useState, useEffect, useRef, useCallback } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { Save, Loader2, AlertCircle, Globe } from "lucide-react";
import { EditorTabMeta, EditorStatus, LanguageInfo } from "@/types/terminal";
import { useAppStore } from "@/store/appStore";
import {
  localReadFile,
  localWriteFile,
  sftpReadFileContent,
  sftpWriteFileContent,
} from "@/services/api";
import "./FileEditor.css";

// Use local monaco-editor package instead of CDN (important for Tauri/offline)
loader.config({ monaco });

/** Cached list of Monaco languages (populated on first call). */
let cachedLanguages: LanguageInfo[] | null = null;

function getAvailableLanguages(): LanguageInfo[] {
  if (!cachedLanguages) {
    cachedLanguages = monaco.languages
      .getLanguages()
      .map((lang) => ({
        id: lang.id,
        name: lang.aliases?.[0] ?? lang.id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return cachedLanguages;
}

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

interface FileEditorProps {
  tabId: string;
  meta: EditorTabMeta;
  isVisible: boolean;
}

/**
 * Built-in file editor using Monaco Editor.
 * Supports both local and remote (SFTP) files.
 */
export function FileEditor({ tabId, meta, isVisible }: FileEditorProps) {
  const setEditorDirty = useAppStore((s) => s.setEditorDirty);
  const setEditorStatus = useAppStore((s) => s.setEditorStatus);
  const setEditorActions = useAppStore((s) => s.setEditorActions);

  const [content, setContent] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const saveRef = useRef<() => void>(() => {});
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  const fileName = meta.filePath.split("/").pop() ?? meta.filePath;

  // Load file content on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

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
  }, [meta.filePath, meta.isRemote, meta.sftpSessionId]);

  // Track dirty state
  useEffect(() => {
    if (content === null || savedContent === null) return;
    const isDirty = content !== savedContent;
    setEditorDirty(tabId, isDirty);
  }, [content, savedContent, tabId, setEditorDirty]);

  const handleSave = useCallback(async () => {
    if (content === null || saving) return;
    setSaving(true);
    try {
      if (meta.isRemote && meta.sftpSessionId) {
        await sftpWriteFileContent(meta.sftpSessionId, meta.filePath, content);
      } else {
        await localWriteFile(meta.filePath, content);
      }
      setSavedContent(content);
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  }, [content, saving, meta.filePath, meta.isRemote, meta.sftpSessionId]);

  // Keep saveRef up to date for Monaco keybinding
  saveRef.current = handleSave;

  const handleEditorMount = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor) => {
      editorRef.current = editor;

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

  const isDirty = content !== null && savedContent !== null && content !== savedContent;

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
        <div className="file-editor__error">
          <AlertCircle size={20} />
          <span>Failed to load file: {error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`file-editor ${!isVisible ? "file-editor--hidden" : ""}`}>
      <div className="file-editor__toolbar">
        <div className="file-editor__path">
          {meta.isRemote && (
            <span className="file-editor__remote-badge">
              <Globe size={12} />
              Remote
            </span>
          )}
          <span className="file-editor__filepath" title={meta.filePath}>
            {meta.filePath}
          </span>
        </div>
        <button
          className="file-editor__save-btn"
          onClick={handleSave}
          disabled={!isDirty || saving}
          title="Save (Ctrl+S)"
          data-testid="file-editor-save"
        >
          <Save size={14} />
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      <div className="file-editor__editor-container">
        <Editor
          defaultValue={content ?? ""}
          path={fileName}
          theme="vs-dark"
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
