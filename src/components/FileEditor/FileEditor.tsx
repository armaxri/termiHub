import { useState, useEffect, useRef, useCallback } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import {
  Save,
  Loader2,
  AlertCircle,
  Globe,
  FileEdit,
  Lock,
  ShieldCheck,
  Copy,
  Download,
  X,
} from "lucide-react";
import { Button, toast } from "@/components/ui";
import { save } from "@tauri-apps/plugin-dialog";
import { EditorTabMeta, EditorStatus } from "@/types/terminal";
import { useAppStore } from "@/store/appStore";
import { resolveLanguage } from "@/utils/languageMapping";
import { getBasename } from "@/utils/formatters";
import { suggestedSaveCopyPath } from "@/utils/saveCopyPath";
import { getAvailableLanguages } from "@/utils/monacoLanguages";
import { getMonacoTheme } from "@/utils/monacoCustomLanguages";
import { getCurrentTheme, onThemeChange } from "@/themes";
import {
  localReadFile,
  localWriteFile,
  sftpReadFileContent,
  sftpWriteFileContent,
  sftpWriteFileContentElevated,
  sftpHasExecCapability,
  sftpCheckWritable,
  sftpDownload,
  sftpRealpath,
  sessionReadFile,
  sessionWriteFile,
  storeCredential,
  resolveCredential,
  removeCredential,
  TransferTerminalError,
  type ElevatedWriteResult,
} from "@/services/api";
import { UnsavedChangesDialog } from "@/components/ConnectionEditor/UnsavedChangesDialog";
import { SudoPromptDialog, type SudoAuthorizeOptions } from "./SudoPromptDialog";
import { SaveCopyDialog } from "./SaveCopyDialog";
import { frontendLog } from "@/utils/frontendLog";
import "./FileEditor.css";

/** Maximum number of sudo-password attempts before falling back to the error banner. */
const MAX_SUDO_ATTEMPTS = 3;

// Use local monaco-editor package instead of CDN (important for Tauri/offline)
loader.config({ monaco });

/**
 * Read a file's text through the session layer (#1557).
 *
 * `session_read_file` is byte-oriented — it backs binary transfers too — so the
 * editor decodes here. The SFTP path (`sftp_read_file_content`) decodes backend
 * side and hands back a string already, which is why only this side needs it.
 */
async function sessionReadFileContent(sessionId: string, path: string): Promise<string> {
  const bytes = await sessionReadFile(sessionId, path);
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Write a file's text through the session layer, mirroring {@link sessionReadFileContent}. */
async function sessionWriteFileContent(
  sessionId: string,
  path: string,
  content: string
): Promise<void> {
  await sessionWriteFile(sessionId, path, Array.from(new TextEncoder().encode(content)));
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
  // Host label (`user@host:port`) of the editor's SFTP session — names the host
  // in the sudo prompt and keys the (optional) credential-store entry. The
  // credential store treats this string as an opaque namespace, and a sudo
  // password belongs to the remote user@host rather than any UI connection id.
  const hostLabel = useAppStore((s) =>
    meta.sftpSessionId ? (s.sftpSessions[meta.sftpSessionId]?.hostLabel ?? null) : null
  );
  // Live credential-store status — the "save in credential store" option only
  // appears when it is unlocked.
  const credentialStoreUnlocked = useAppStore(
    (s) => s.credentialStoreStatus?.status === "unlocked"
  );

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

  // Whether the remote (SFTP) connection can also open an exec channel — i.e.
  // it is a full SSH+shell connection, not an SFTP-only / relayed one. Gates
  // future privilege-elevated ("save with sudo") writes, which need a shell to
  // run `sudo`. `false` for local files and SFTP-only connections.
  const [execCapable, setExecCapable] = useState(false);

  // Authoritative writability of the remote file, from a non-destructive SFTP
  // write-open probe (#1324/#1325): `false` = read-only (server denied the
  // write-open), `true` = writable, `"unknown"` = probe inconclusive. Only
  // `false` surfaces the read-only badge/banner; `true`/`"unknown"` leave the
  // direct-save path untouched. Local files stay `"unknown"` (never probed).
  const [writable, setWritable] = useState<boolean | "unknown">("unknown");
  // Whether the user has dismissed the read-only notice banner. The badge is a
  // persistent state indicator; only the banner is dismissible.
  const [readonlyBannerDismissed, setReadonlyBannerDismissed] = useState(false);

  // Elevated ("sudo") edit mode. Once a save is authorized with sudo, the tab
  // stays in elevated mode for the rest of the session: a persistent `sudo`
  // marker is shown and subsequent saves route through the elevated path.
  const [elevated, setElevated] = useState(false);
  // Sudo prompt dialog state. `sudoAttempt` is 1-based; a rejected password
  // bumps it (up to MAX_SUDO_ATTEMPTS) while the dialog stays open. `sudoBusy`
  // drives the dialog's pending state while the backend verifies.
  const [sudoDialogOpen, setSudoDialogOpen] = useState(false);
  const [sudoAttempt, setSudoAttempt] = useState(1);
  const [sudoBusy, setSudoBusy] = useState(false);

  // SFTP-only read-only fallback (#1330). When the file is read-only and the
  // connection has no exec channel, sudo elevation is impossible; the user may
  // instead save the buffer to a writable remote path (this dialog) or download
  // it locally.
  const [saveCopyDialogOpen, setSaveCopyDialogOpen] = useState(false);
  const [saveCopyBusy, setSaveCopyBusy] = useState(false);
  // Connecting user's resolved remote home directory, used to pre-fill the
  // "Save a copy…" dialog with a likely-writable destination (#1535). Null
  // until resolved (or if resolution fails / the file is local).
  const [remoteHome, setRemoteHome] = useState<string | null>(null);

  const saveRef = useRef<() => void>(() => {});
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // In-memory session password cache ("Remember for this session"). Held in a
  // ref — never React/store state and never {@link EditorTabMeta} — so it is
  // impossible for it to be serialized into persisted tab/workspace state.
  const sudoPasswordRef = useRef<string | null>(null);

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
        } else if (meta.isRemote && meta.sessionBrowser) {
          text = await sessionReadFileContent(meta.sessionBrowser.sessionId, meta.filePath);
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
  }, [
    meta.filePath,
    meta.isRemote,
    meta.sftpSessionId,
    meta.sessionBrowser,
    meta.scratch,
    meta.scratchContent,
  ]);

  // Probe whether the remote connection can run remote commands (shell vs
  // SFTP-only). Determines whether privilege-elevated writes will be offered.
  useEffect(() => {
    let cancelled = false;
    if (!meta.isRemote || !meta.sftpSessionId) {
      setExecCapable(false);
      return;
    }
    const sessionId = meta.sftpSessionId;
    sftpHasExecCapability(sessionId)
      .then((capable) => {
        if (cancelled) return;
        setExecCapable(capable);
        frontendLog("file_editor", `exec capability for sftp session ${sessionId}: ${capable}`);
      })
      .catch((err) => {
        if (cancelled) return;
        setExecCapable(false);
        frontendLog(
          "file_editor",
          `exec capability probe failed for sftp session ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    return () => {
      cancelled = true;
    };
  }, [meta.isRemote, meta.sftpSessionId]);

  // Resolve the connecting user's remote home directory so the "Save a copy…"
  // dialog can default to a likely-writable destination there (#1535). Passing
  // "." to realpath yields the session's home. Best-effort: a failure just
  // leaves home null and the dialog falls back to a same-directory sibling.
  useEffect(() => {
    let cancelled = false;
    if (!meta.isRemote || !meta.sftpSessionId || meta.scratch) {
      setRemoteHome(null);
      return;
    }
    const sessionId = meta.sftpSessionId;
    sftpRealpath(sessionId, ".")
      .then((home) => {
        if (cancelled) return;
        setRemoteHome(home);
        frontendLog("file_editor", `resolved remote home for sftp session ${sessionId}: ${home}`);
      })
      .catch((err) => {
        if (cancelled) return;
        setRemoteHome(null);
        frontendLog(
          "file_editor",
          `remote home resolution failed for sftp session ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    return () => {
      cancelled = true;
    };
  }, [meta.isRemote, meta.sftpSessionId, meta.scratch]);

  // Probe the connecting user's actual write access to this remote file, in
  // parallel with the content read (it never blocks the load; a failure just
  // degrades to "unknown" so no badge is shown). Only a definitive read-only
  // result surfaces the badge/banner — detection only, no elevated save. (#1325)
  useEffect(() => {
    let cancelled = false;
    setReadonlyBannerDismissed(false);
    if (!meta.isRemote || !meta.sftpSessionId || meta.scratch) {
      setWritable("unknown");
      return;
    }
    const sessionId = meta.sftpSessionId;
    const filePath = meta.filePath;
    sftpCheckWritable(sessionId, filePath)
      .then((result) => {
        if (cancelled) return;
        const mapped = result === "readOnly" ? false : result === "writable" ? true : "unknown";
        setWritable(mapped);
        frontendLog("file_editor", `writability for ${filePath}: ${result}`);
      })
      .catch((err) => {
        if (cancelled) return;
        setWritable("unknown");
        frontendLog(
          "file_editor",
          `writability probe failed for ${filePath}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    return () => {
      cancelled = true;
    };
  }, [meta.isRemote, meta.sftpSessionId, meta.filePath, meta.scratch]);

  // An unsaved scratch buffer has no on-disk copy, so it is always considered
  // dirty (closing it would lose the captured content) until saved via Save As.
  const isDirty =
    content !== null && savedContent !== null && (isUnsavedScratch || content !== savedContent);

  // Whether the primary toolbar action should be "Edit with sudo" instead of
  // "Save": a remote file the probe reported read-only, on an exec-capable
  // (shell) connection, before the session has been elevated. Once elevated the
  // normal Save button returns (it routes through the sudo path).
  const offerEditWithSudo =
    meta.isRemote && !!meta.sftpSessionId && writable === false && execCapable && !elevated;
  // Whether a failed direct save can be retried with sudo (a shell exists).
  const canRetryWithSudo = meta.isRemote && !!meta.sftpSessionId && execCapable && !elevated;
  // SFTP-only read-only file (#1330): read-only on a connection with no exec
  // channel, so no sudo path exists. The direct Save stays disabled; the user is
  // offered "Save a copy" (to a writable remote path) or a local download.
  const sftpOnlyReadonly =
    meta.isRemote && !!meta.sftpSessionId && writable === false && !execCapable;

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

  // Apply the effects of a successful elevated write: mark the buffer saved,
  // enter (persistent) elevated mode, optionally cache the password for the
  // session, and confirm with a success toast.
  const applyElevatedSuccess = useCallback(
    (bufferContent: string, password: string, remember: boolean) => {
      setSavedContent(bufferContent);
      setElevated(true);
      if (remember) sudoPasswordRef.current = password;
      frontendLog("file_editor", `elevated save succeeded for ${meta.filePath}`);
      toast.success(`Saved ${getBasename(meta.filePath)} with sudo`);
    },
    [meta.filePath]
  );

  // Attempt a single elevated write with a candidate password. Returns a small
  // discriminated outcome so the two call sites (silent cache/credential path
  // and the interactive dialog) can react. Non-password failures are surfaced
  // in the #969 banner here; the password is never logged.
  const attemptElevatedWrite = useCallback(
    async (password: string, bufferContent: string): Promise<"success" | "wrong" | "error"> => {
      const sessionId = meta.sftpSessionId;
      if (!sessionId) return "error";
      frontendLog(
        "file_editor",
        `elevated save attempt for ${meta.filePath} on ${hostLabel ?? "unknown host"}`
      );
      let result: ElevatedWriteResult;
      try {
        result = await sftpWriteFileContentElevated(
          sessionId,
          meta.filePath,
          bufferContent,
          password
        );
      } catch (err) {
        frontendLog(
          "file_editor",
          `elevated save threw for ${meta.filePath}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        setSaveError(formatSaveError(err));
        return "error";
      }
      if (result.kind === "success") return "success";
      if (result.kind === "incorrectPassword") return "wrong";
      frontendLog("file_editor", `elevated save failed for ${meta.filePath}: ${result.message}`);
      setSaveError(`Save failed: ${result.message}`);
      return "error";
    },
    [meta.sftpSessionId, meta.filePath, hostLabel]
  );

  // Save via the elevated (sudo) path, prompting only when needed. Tries the
  // in-memory session cache first, then an opt-in persisted credential (when the
  // store is unlocked); a hit saves silently, a miss or a stale/rejected
  // password opens the interactive prompt.
  const saveElevated = useCallback(async () => {
    if (content === null || saving) return;
    const bufferContent = content;
    setSaving(true);
    setSaveError(null);
    try {
      let password = sudoPasswordRef.current;
      let fromStore = false;
      if (!password && credentialStoreUnlocked && hostLabel) {
        try {
          password = await resolveCredential(hostLabel, "sudo_password");
          fromStore = password != null;
        } catch {
          password = null;
        }
      }
      if (password) {
        const outcome = await attemptElevatedWrite(password, bufferContent);
        if (outcome === "success") {
          applyElevatedSuccess(bufferContent, password, true);
          return;
        }
        if (outcome === "error") return;
        // Stale cache / rejected stored password — discard it and prompt.
        sudoPasswordRef.current = null;
        if (fromStore && hostLabel) {
          try {
            await removeCredential(hostLabel, "sudo_password");
          } catch {
            // best-effort cleanup
          }
        }
      }
    } finally {
      setSaving(false);
    }
    setSudoAttempt(1);
    setSudoDialogOpen(true);
  }, [
    content,
    saving,
    credentialStoreUnlocked,
    hostLabel,
    attemptElevatedWrite,
    applyElevatedSuccess,
  ]);

  // Handle a password submitted from the sudo prompt: verify it, then persist /
  // cache / re-prompt / give up per the outcome and the 3-attempt limit.
  const handleSudoSubmit = useCallback(
    async (password: string, opts: SudoAuthorizeOptions) => {
      if (content === null) return;
      const bufferContent = content;
      setSudoBusy(true);
      setSaveError(null);
      const outcome = await attemptElevatedWrite(password, bufferContent);
      setSudoBusy(false);

      if (outcome === "success") {
        applyElevatedSuccess(bufferContent, password, opts.rememberForSession);
        if (opts.persistToStore && credentialStoreUnlocked && hostLabel) {
          try {
            await storeCredential(hostLabel, "sudo_password", password);
          } catch (err) {
            frontendLog(
              "file_editor",
              `failed to persist sudo password: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        setSudoDialogOpen(false);
        setSudoAttempt(1);
        return;
      }
      if (outcome === "error") {
        // Non-password failure: dismiss the prompt, keep the buffer, show banner.
        setSudoDialogOpen(false);
        setSudoAttempt(1);
        return;
      }
      // Wrong password: re-prompt until the attempt limit, then fall to #969.
      if (sudoAttempt >= MAX_SUDO_ATTEMPTS) {
        setSudoDialogOpen(false);
        setSudoAttempt(1);
        setSaveError(
          `Incorrect sudo password — ${MAX_SUDO_ATTEMPTS} attempts failed. The file was not saved.`
        );
        return;
      }
      setSudoAttempt((n) => n + 1);
    },
    [
      content,
      attemptElevatedWrite,
      applyElevatedSuccess,
      credentialStoreUnlocked,
      hostLabel,
      sudoAttempt,
    ]
  );

  const handleSudoCancel = useCallback(() => {
    setSudoDialogOpen(false);
    setSudoAttempt(1);
  }, []);

  // Write the current buffer to a user-chosen writable remote path (#1330). The
  // original read-only file is untouched — this creates a separate copy, so the
  // buffer's dirty state is intentionally left as-is.
  const handleSaveCopySubmit = useCallback(
    async (destPath: string) => {
      if (content === null || !meta.sftpSessionId) return;
      setSaveCopyBusy(true);
      const toastId = toast.loading(`Saving a copy to ${destPath}…`);
      try {
        await sftpWriteFileContent(meta.sftpSessionId, destPath, content);
        toast.success(`Saved a copy to ${destPath}`, { id: toastId });
        setSaveCopyDialogOpen(false);
        frontendLog("file_editor", `saved a copy of ${meta.filePath} to ${destPath}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Save a copy failed: ${message}`, { id: toastId });
        frontendLog("file_editor", `save a copy of ${meta.filePath} failed: ${message}`);
      } finally {
        setSaveCopyBusy(false);
      }
    },
    [content, meta.sftpSessionId, meta.filePath]
  );

  // Download the read-only remote file to a user-chosen local path (#1330). The
  // terminal success/error toast is owned by the transfer-progress event path
  // (useTransferEvents); here we only show the pending toast and surface an
  // early failure that never produced a transfer event.
  const handleDownloadCopy = useCallback(async () => {
    if (!meta.sftpSessionId) return;
    const localPath = await save({ title: "Download a copy…", defaultPath: fileName });
    if (!localPath) return;
    const toastId = toast.loading(`Downloading ${fileName}…`);
    try {
      await sftpDownload(meta.sftpSessionId, meta.filePath, localPath);
      toast.dismiss(toastId);
      frontendLog("file_editor", `downloaded ${meta.filePath} to ${localPath}`);
    } catch (err) {
      if (err instanceof TransferTerminalError) {
        // The transfer-progress event path already surfaced this outcome.
        toast.dismiss(toastId);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Download failed: ${message}`, { id: toastId });
      frontendLog("file_editor", `download of ${meta.filePath} failed: ${message}`);
    }
  }, [meta.sftpSessionId, meta.filePath, fileName]);

  const handleSave = useCallback(async () => {
    if (content === null || saving) return;

    // Read-only remote file that has a shell, or an already-elevated session:
    // route through the sudo path instead of the direct SFTP write.
    if (meta.isRemote && meta.sftpSessionId && (elevated || (writable === false && execCapable))) {
      await saveElevated();
      return;
    }

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
      } else if (meta.isRemote && meta.sessionBrowser) {
        await sessionWriteFileContent(meta.sessionBrowser.sessionId, meta.filePath, content);
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
    meta.sessionBrowser,
    tabId,
    renameTab,
    elevated,
    writable,
    execCapable,
    saveElevated,
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
      <div className="file-editor__toolbar" data-exec-capable={execCapable}>
        <div className="file-editor__path">
          {meta.isRemote && (
            <span className="file-editor__remote-badge" data-testid="file-editor-remote-badge">
              <Globe size={12} />
              Remote
            </span>
          )}
          {writable === false && (
            <span
              className="file-editor__remote-badge file-editor__readonly-badge"
              data-testid="file-editor-readonly-badge"
              title={
                meta.permissions
                  ? `Read-only (${meta.permissions})`
                  : "Read-only — you don't have write access to this file"
              }
            >
              <Lock size={12} />
              Read-only
            </span>
          )}
          {elevated && (
            <span
              className="file-editor__remote-badge file-editor__sudo-badge"
              data-testid="file-editor-sudo-badge"
              title="Elevated (sudo) edit mode — saves are written with root privileges"
            >
              <ShieldCheck size={12} />
              sudo
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
        {offerEditWithSudo ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<ShieldCheck size={14} />}
            onClick={handleSave}
            disabled={!isDirty}
            pendingLabel="Saving..."
            errorToast={false}
            title="Save this read-only file with sudo"
            data-testid="file-editor-edit-with-sudo"
          >
            Edit with sudo
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            icon={<Save size={14} />}
            onClick={handleSave}
            disabled={!isDirty || sftpOnlyReadonly}
            pendingLabel="Saving..."
            errorToast={false}
            title={
              sftpOnlyReadonly
                ? "This file is read-only — use “Save a copy…” or Download"
                : isUnsavedScratch
                  ? "Save As... (Ctrl+S)"
                  : "Save (Ctrl+S)"
            }
            data-testid="file-editor-save"
          >
            {isUnsavedScratch ? "Save As..." : "Save"}
          </Button>
        )}
      </div>
      {writable === false && !readonlyBannerDismissed && (
        <div
          className="file-editor__readonly-banner"
          role="status"
          data-testid="file-editor-readonly-banner"
        >
          <Lock size={14} />
          <span className="file-editor__readonly-banner-text">
            {sftpOnlyReadonly
              ? "This file is read-only and sudo elevation isn't available on this connection. Save a copy to a writable path or download the file locally instead."
              : "This file is read-only — you don't have permission to write to it. Saving directly will fail."}
          </span>
          {sftpOnlyReadonly && (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={<Copy size={14} />}
                onClick={() => setSaveCopyDialogOpen(true)}
                title="Write the current contents to a writable remote path"
                data-testid="file-editor-save-copy"
              >
                Save a copy…
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Download size={14} />}
                onClick={handleDownloadCopy}
                title="Download this file to your computer"
                data-testid="file-editor-download"
              >
                Download
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<X size={14} />}
            onClick={() => setReadonlyBannerDismissed(true)}
            title="Dismiss"
            aria-label="Dismiss read-only notice"
            data-testid="file-editor-readonly-banner-dismiss"
          />
        </div>
      )}
      {saveError && (
        <div className="file-editor__save-error" role="alert" data-testid="file-editor-save-error">
          <AlertCircle size={14} />
          <span className="file-editor__save-error-text">{saveError}</span>
          {canRetryWithSudo && (
            <Button
              variant="secondary"
              size="sm"
              icon={<ShieldCheck size={14} />}
              onClick={() => {
                setSaveError(null);
                void saveElevated();
              }}
              title="Retry this save with sudo"
              data-testid="file-editor-save-error-retry-sudo"
            >
              Retry with sudo
            </Button>
          )}
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
      <SudoPromptDialog
        open={sudoDialogOpen}
        hostLabel={hostLabel ?? meta.filePath}
        targetPath={meta.filePath}
        attempt={sudoAttempt}
        maxAttempts={MAX_SUDO_ATTEMPTS}
        credentialStoreUnlocked={credentialStoreUnlocked}
        busy={sudoBusy}
        onSubmit={handleSudoSubmit}
        onCancel={handleSudoCancel}
      />
      <SaveCopyDialog
        open={saveCopyDialogOpen}
        defaultPath={suggestedSaveCopyPath(effectivePath, remoteHome)}
        busy={saveCopyBusy}
        onSubmit={handleSaveCopySubmit}
        onCancel={() => setSaveCopyDialogOpen(false)}
      />
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
