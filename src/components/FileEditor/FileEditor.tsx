import { useState, useEffect, useRef, useCallback, useId, useMemo } from "react";
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
  RotateCcw,
  X,
} from "lucide-react";
import { Button, toast } from "@/components/ui";
import { save } from "@tauri-apps/plugin-dialog";
import { EditorTabMeta, EditorStatus } from "@/types/terminal";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { resolveLanguage } from "@/utils/languageMapping";
import { getBasename } from "@/utils/formatters";
import { suggestedSaveCopyPath } from "@/utils/saveCopyPath";
import { getAvailableLanguages } from "@/utils/monacoLanguages";
import { getMonacoTheme } from "@/utils/monacoCustomLanguages";
import { getCurrentTheme, onThemeChange } from "@/themes";
import {
  localReadFile,
  localWriteFile,
  watchLocalFile,
  unwatchLocalFile,
  sftpReadFileContent,
  sftpWriteFileContent,
  sftpWriteFileContentElevated,
  sftpHasExecCapability,
  sftpCheckWritable,
  sftpDownload,
  sftpRealpath,
  sftpStat,
  sessionReadFile,
  sessionStat,
  sessionWriteFile,
  sessionCheckWritable,
  sessionHasExecCapability,
  sessionWriteFileElevated,
  sessionDownload,
  sessionRealpath,
  storeCredential,
  resolveCredential,
  removeCredential,
  TransferTerminalError,
  type ElevatedWriteResult,
} from "@/services/api";
import type { Writability } from "@/types/connection";
import { onLocalFileChanged } from "@/services/events";
import { UnsavedChangesDialog } from "@/components/ConnectionEditor/UnsavedChangesDialog";
import { SudoPromptDialog, type SudoAuthorizeOptions } from "./SudoPromptDialog";
import { SaveCopyDialog } from "./SaveCopyDialog";
import { frontendLog } from "@/utils/frontendLog";
import "./FileEditor.css";

/** Maximum number of sudo-password attempts before falling back to the error banner. */
const MAX_SUDO_ATTEMPTS = 3;

/**
 * Poll interval for remote (SFTP / session) editor tabs' external-change
 * detection (#1627). Remote transports cannot use OS file-watching (which backs
 * the local path in #1620), so the open file is re-`stat`ed on this interval and
 * its `modified`/`size` compared to spot an out-of-band change.
 *
 * Chosen to stay lightweight: a stat is a single metadata round-trip, polling is
 * confined to the *focused, visible* editor tab (paused when the window is not
 * focused — see the poll effect), and only the currently-open file is watched.
 * At 4s that is 0.25 req/s per open remote editor — negligible next to
 * interactive SFTP browsing — while still reflecting a teammate's edit within a
 * few seconds. Kept a single constant so a future setting could gate/tune it
 * (the owner reserves whether remote polling should be opt-in — see #1627).
 */
export const REMOTE_POLL_INTERVAL_MS = 4000;

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
 * The SFTP-advanced file operations available to a remote editor tab, bound to
 * whichever remote transport backs it (#2420).
 *
 * Two transports can back a remote tab (see {@link EditorTabMeta}): the legacy
 * `sftpSessionId` (`sftp_*` commands) and the protocol-agnostic session layer
 * (`session_*` twins). The advanced affordances — writability probe, exec
 * capability, elevated/sudo write, realpath (home), download, save-a-copy — exist
 * only for an **SFTP-backed** connection: the session-path twins resolve via the
 * backend's `SftpFileBrowser` and error for a byte-based backend (Docker / FTP /
 * remote-agent). This handle exposes exactly those ops with the transport already
 * bound, so the editor's affordance code is transport-agnostic; it is `null` for
 * local tabs, scratch buffers, and byte-based session backends (which keep plain
 * read/write only).
 */
interface RemoteAdvancedOps {
  checkWritable: (path: string) => Promise<Writability>;
  realpath: (path: string) => Promise<string>;
  writeElevated: (path: string, content: string, password: string) => Promise<ElevatedWriteResult>;
  writeContent: (path: string, content: string) => Promise<void>;
  download: (remotePath: string, localPath: string) => Promise<number>;
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
  const projectedSettings = useProjectedSettings();
  const fileLanguageMappings = projectedSettings.fileLanguageMappings;
  const pendingCloseRequest = useAppStore((s) => s.pendingCloseRequest);
  const setPendingCloseRequest = useAppStore((s) => s.setPendingCloseRequest);
  const closeTab = useAppStore((s) => s.closeTab);
  const renameTab = useAppStore((s) => s.renameTab);
  // Subscribe to the theme setting so we re-derive the Monaco theme when the
  // user explicitly switches between dark / light / system in the settings.
  const themeSetting = projectedSettings.theme;
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

  // Whether a session-layer-backed remote tab's backend is SFTP-backed and can
  // therefore drive the SFTP-advanced ops (#2420). Determined by the exec-
  // capability probe: `session_has_exec_capability` resolves only for an
  // SFTP-backed session and errors for a byte-based backend (Docker / FTP /
  // remote-agent), so a resolved probe flips this on. Always `false` for the
  // legacy `sftpSessionId` path (which is SFTP-backed by construction and gated
  // directly), for local tabs, and for byte-based session backends.
  const [sessionSftpCapable, setSessionSftpCapable] = useState(false);

  // Authoritative writability of the remote file, from a non-destructive SFTP
  // write-open probe (#1324/#1325): `false` = read-only (server denied the
  // write-open), `true` = writable, `"unknown"` = probe inconclusive. Only
  // `false` surfaces the read-only badge/banner; `true`/`"unknown"` leave the
  // direct-save path untouched. Local files stay `"unknown"` (never probed).
  const [writable, setWritable] = useState<boolean | "unknown">("unknown");
  // Whether the user has dismissed the read-only notice banner. The badge is a
  // persistent state indicator; only the banner is dismissible.
  const [readonlyBannerDismissed, setReadonlyBannerDismissed] = useState(false);

  // Set when the file changed on disk while the buffer had unsaved edits (#1620).
  // This is the genuine-conflict case: we detect it and surface a non-destructive
  // notice, but deliberately do NOT auto-reload (which would clobber the user's
  // edits) — the resolution policy is a deferred decision. The clean case (no
  // unsaved edits) reloads silently instead and never sets this.
  const [diskChangedWhileDirty, setDiskChangedWhileDirty] = useState(false);

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
  // Stable, per-editor-instance key for the local file watch (#1620). Keyed off
  // React's useId rather than the tab id so a second instance for the same tab
  // (e.g. the zoom overlay, `keepModel`) gets its own watch and its own cleanup,
  // and never tears down the other instance's watcher.
  const watchId = useId();
  const fileName = getBasename(effectivePath);
  const detectedLanguage = resolveLanguage(fileName, fileLanguageMappings);
  // Scratch buffers share the synthetic file name, so key the Monaco model on
  // the tab id to avoid two scratch tabs colliding on the same model. Keeping it
  // independent of the file name also preserves the model (and undo history)
  // when the buffer is later renamed via Save As.
  const monacoPath = meta.scratch ? `scratch/${tabId}` : fileName;

  // The SFTP-advanced ops for this tab, bound to its remote transport, or null
  // when none apply (#2420). The legacy `sftpSessionId` path is SFTP-backed by
  // construction, so its ops are available immediately; the session path is
  // offered these ops only once the capability probe has confirmed the backend is
  // SFTP-backed (`sessionSftpCapable`) — a byte-based backend (Docker / FTP /
  // remote-agent) keeps plain read/write only and this stays null, as do local
  // tabs and scratch buffers. See {@link RemoteAdvancedOps}.
  const advancedOps = useMemo<RemoteAdvancedOps | null>(() => {
    if (!meta.isRemote || meta.scratch) return null;
    const sftpId = meta.sftpSessionId;
    if (sftpId) {
      return {
        checkWritable: (path) => sftpCheckWritable(sftpId, path),
        realpath: (path) => sftpRealpath(sftpId, path),
        writeElevated: (path, fileContent, password) =>
          sftpWriteFileContentElevated(sftpId, path, fileContent, password),
        writeContent: (path, fileContent) => sftpWriteFileContent(sftpId, path, fileContent),
        download: (remotePath, localPath) => sftpDownload(sftpId, remotePath, localPath),
      };
    }
    const sessionId = meta.sessionBrowser?.sessionId;
    if (sessionId && sessionSftpCapable) {
      return {
        checkWritable: (path) => sessionCheckWritable(sessionId, path),
        realpath: (path) => sessionRealpath(sessionId, path),
        writeElevated: (path, fileContent, password) =>
          sessionWriteFileElevated(sessionId, path, fileContent, password),
        writeContent: (path, fileContent) => sessionWriteFileContent(sessionId, path, fileContent),
        download: (remotePath, localPath) => sessionDownload(sessionId, remotePath, localPath),
      };
    }
    return null;
  }, [meta.isRemote, meta.scratch, meta.sftpSessionId, meta.sessionBrowser, sessionSftpCapable]);

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
  // SFTP-only) and, for a session-layer tab, whether its backend is SFTP-backed
  // at all (#2420). Determines whether privilege-elevated writes will be offered.
  //
  // For the legacy `sftpSessionId` path the connection is SFTP-backed by
  // construction, so this only measures exec capability. For the session path the
  // same probe doubles as the SFTP-capability signal: `session_has_exec_capability`
  // resolves (with the exec boolean) only for an SFTP-backed session and rejects
  // for a byte-based backend, so a resolve flips `sessionSftpCapable` on (unlocking
  // the advanced affordances) and a reject leaves the tab on the byte-based
  // read/write path with no advanced ops.
  useEffect(() => {
    let cancelled = false;
    setExecCapable(false);
    setSessionSftpCapable(false);
    if (!meta.isRemote || meta.scratch) return;

    const sftpId = meta.sftpSessionId;
    if (sftpId) {
      sftpHasExecCapability(sftpId)
        .then((capable) => {
          if (cancelled) return;
          setExecCapable(capable);
          frontendLog("file_editor", `exec capability for sftp session ${sftpId}: ${capable}`);
        })
        .catch((err) => {
          if (cancelled) return;
          setExecCapable(false);
          frontendLog(
            "file_editor",
            `exec capability probe failed for sftp session ${sftpId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        });
      return () => {
        cancelled = true;
      };
    }

    const sessionId = meta.sessionBrowser?.sessionId;
    if (!sessionId) return;
    sessionHasExecCapability(sessionId)
      .then((capable) => {
        if (cancelled) return;
        // Resolved → the session is SFTP-backed; the boolean is its exec capability.
        setSessionSftpCapable(true);
        setExecCapable(capable);
        frontendLog(
          "file_editor",
          `session ${sessionId} is SFTP-backed; exec capability: ${capable}`
        );
      })
      .catch((err) => {
        if (cancelled) return;
        // Rejected → not SFTP-backed (byte-based backend); keep read/write only.
        setSessionSftpCapable(false);
        setExecCapable(false);
        frontendLog(
          "file_editor",
          `session ${sessionId} is not SFTP-backed; advanced editor ops disabled: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    return () => {
      cancelled = true;
    };
  }, [meta.isRemote, meta.scratch, meta.sftpSessionId, meta.sessionBrowser]);

  // Resolve the connecting user's remote home directory so the "Save a copy…"
  // dialog can default to a likely-writable destination there (#1535). Uses the
  // tab's SFTP-advanced transport (sftp or session, #2420); passing "." to
  // realpath yields the session's home. Best-effort: a failure just leaves home
  // null and the dialog falls back to a same-directory sibling.
  useEffect(() => {
    let cancelled = false;
    if (!advancedOps) {
      setRemoteHome(null);
      return;
    }
    advancedOps
      .realpath(".")
      .then((home) => {
        if (cancelled) return;
        setRemoteHome(home);
        frontendLog("file_editor", `resolved remote home: ${home}`);
      })
      .catch((err) => {
        if (cancelled) return;
        setRemoteHome(null);
        frontendLog(
          "file_editor",
          `remote home resolution failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    return () => {
      cancelled = true;
    };
  }, [advancedOps]);

  // Probe the connecting user's actual write access to this remote file, in
  // parallel with the content read (it never blocks the load; a failure just
  // degrades to "unknown" so no badge is shown). Only a definitive read-only
  // result surfaces the badge/banner — detection only, no elevated save. (#1325)
  useEffect(() => {
    let cancelled = false;
    setReadonlyBannerDismissed(false);
    if (!advancedOps) {
      setWritable("unknown");
      return;
    }
    const filePath = meta.filePath;
    advancedOps
      .checkWritable(filePath)
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
  }, [advancedOps, meta.filePath]);

  // An unsaved scratch buffer has no on-disk copy, so it is always considered
  // dirty (closing it would lose the captured content) until saved via Save As.
  const isDirty =
    content !== null && savedContent !== null && (isUnsavedScratch || content !== savedContent);

  // Whether the primary toolbar action should be "Edit with sudo" instead of
  // "Save": a remote file the probe reported read-only, on an exec-capable
  // (shell) connection, before the session has been elevated. Once elevated the
  // normal Save button returns (it routes through the sudo path).
  const offerEditWithSudo = !!advancedOps && writable === false && execCapable && !elevated;
  // Whether a failed direct save can be retried with sudo (a shell exists).
  const canRetryWithSudo = !!advancedOps && execCapable && !elevated;
  // SFTP-only read-only file (#1330): read-only on a connection with no exec
  // channel, so no sudo path exists. The direct Save stays disabled; the user is
  // offered "Save a copy" (to a writable remote path) or a local download.
  const sftpOnlyReadonly = !!advancedOps && writable === false && !execCapable;

  // Sync dirty state to the store (drives the tab dirty dot and close prompt).
  useEffect(() => {
    if (content === null || savedContent === null) return;
    setEditorDirty(tabId, isDirty);
  }, [isDirty, content, savedContent, tabId, setEditorDirty]);

  // Once the buffer is clean again (saved, or edits reverted), a pending
  // disk-changed conflict notice no longer applies (#1620).
  useEffect(() => {
    if (!isDirty && diskChangedWhileDirty) setDiskChangedWhileDirty(false);
  }, [isDirty, diskChangedWhileDirty]);

  // Adopt `disk` as the new buffer-and-saved content, discarding any local
  // edits. Monaco is uncontrolled, so update its model directly (preserving
  // cursor/scroll) when mounted; otherwise updating state is enough and the
  // load path renders from it. Setting savedContent === the new content leaves
  // the buffer clean (content === savedContent). (#1620)
  const applyDiskContent = useCallback((disk: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (editor && model) {
      const view = editor.saveViewState();
      setSavedContent(disk);
      // Fires onChange -> setContent(disk); the buffer stays clean.
      model.setValue(disk);
      if (view) editor.restoreViewState(view);
    } else {
      setContent(disk);
      setSavedContent(disk);
    }
  }, []);

  // Read the current on-disk contents of the open file via whichever transport
  // backs the tab (local / SFTP / session layer). Used by both the external-
  // change reload paths and the "Reload from disk" button so local (#1620) and
  // remote (#1627) files share one read path.
  const readEffectiveContent = useCallback(async (): Promise<string> => {
    if (meta.isRemote && meta.sftpSessionId) {
      return await sftpReadFileContent(meta.sftpSessionId, effectivePath);
    }
    if (meta.isRemote && meta.sessionBrowser) {
      return await sessionReadFileContent(meta.sessionBrowser.sessionId, effectivePath);
    }
    return await localReadFile(effectivePath);
  }, [meta.isRemote, meta.sftpSessionId, meta.sessionBrowser, effectivePath]);

  // Reflect the current on-disk contents when the open file changed underneath
  // us — driven by the OS watcher for local files (#1620) and by the re-stat
  // poll for remote files (#1627). Both feed the same clean-reload / conflict
  // decision below.
  const reloadFromDisk = useCallback(async () => {
    // A scratch buffer that was never saved has no on-disk counterpart.
    if (isUnsavedScratch) return;
    let disk: string;
    try {
      disk = await readEffectiveContent();
    } catch (err) {
      frontendLog(
        "file_editor",
        `external-change reload read failed for tab ${tabId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }
    // Nothing new relative to what we last loaded/saved. This also silently
    // absorbs the watcher event fired by our own save (disk === savedContent
    // afterwards), so saving never triggers a spurious reload.
    if (disk === savedContent) return;

    const hasUnsavedEdits = content !== null && content !== savedContent;
    if (hasUnsavedEdits) {
      // Genuine conflict: the file changed on disk while the buffer has local
      // edits. Detection only — do NOT clobber either side. The user resolves
      // it from the banner (Reload from disk / Keep my changes, #1620); until
      // then edits are kept and disk is untouched. Re-surfaces on each new
      // external change (savedContent is left untouched by "Keep my changes").
      frontendLog(
        "file_editor",
        `external change detected for tab ${tabId} with unsaved edits — surfacing conflict banner`
      );
      setDiskChangedWhileDirty(true);
      return;
    }

    // Happy path: the buffer is clean, so reflect the new content silently.
    applyDiskContent(disk);
    frontendLog("file_editor", `reloaded tab ${tabId} from external on-disk change`);
  }, [isUnsavedScratch, readEffectiveContent, savedContent, content, tabId, applyDiskContent]);

  // Banner action "Reload from disk" (#1620, #1627): discard the unsaved buffer
  // edits and load the on-disk version (local or remote). Reuses the clean-case
  // read path; the only difference is it proceeds despite a dirty buffer. Once
  // applied, the buffer matches disk (clean), which also clears the conflict
  // banner.
  const handleReloadFromDisk = useCallback(async () => {
    if (isUnsavedScratch) return;
    let disk: string;
    try {
      disk = await readEffectiveContent();
    } catch (err) {
      frontendLog(
        "file_editor",
        `conflict reload-from-disk read failed for tab ${tabId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }
    applyDiskContent(disk);
    setDiskChangedWhileDirty(false);
    frontendLog("file_editor", `reloaded tab ${tabId} from disk, discarding unsaved edits`);
  }, [isUnsavedScratch, readEffectiveContent, tabId, applyDiskContent]);

  // Banner action "Keep my changes" (#1620): dismiss the conflict banner and
  // ignore the on-disk change. Clears the pending-conflict state so a later
  // save is not blocked, but deliberately does NOT touch savedContent — the
  // buffer stays dirty (the user still has unsaved edits) and a subsequent
  // save overwrites disk with their version, which is the existing behaviour.
  // If the file changes on disk again, the watcher re-surfaces the banner.
  const handleKeepMyChanges = useCallback(() => {
    setDiskChangedWhileDirty(false);
    frontendLog("file_editor", `kept unsaved edits for tab ${tabId}, ignoring on-disk change`);
  }, [tabId]);

  // Keep a stable ref so the (path-scoped) watch effect's event handler always
  // calls the latest reload logic without re-subscribing on every keystroke.
  const reloadFromDiskRef = useRef(reloadFromDisk);
  reloadFromDiskRef.current = reloadFromDisk;

  // Last-seen remote stat (mtime + size) for the external-change poll (#1627),
  // keyed to the file identity so it survives visibility toggles (returning to a
  // tab detects a change that landed while it was hidden) but resets when the
  // tab points at a different file.
  const remoteBaselineRef = useRef<{
    key: string;
    value: { modified: string; size: number } | null;
  }>({ key: "", value: null });

  // Watch the open local file for external on-disk changes and reflect them
  // (#1620). Remote (SFTP / session) files use their own transports and are not
  // watched here; an unsaved scratch buffer has no on-disk file yet.
  useEffect(() => {
    if (meta.isRemote || isUnsavedScratch) return;
    const filePath = effectivePath;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const start = async () => {
      try {
        await watchLocalFile(watchId, filePath);
      } catch (err) {
        frontendLog(
          "file_editor",
          `failed to start local file watch for tab ${tabId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      const off = await onLocalFileChanged((changedWatchId) => {
        if (changedWatchId !== watchId) return;
        // Coalesce bursts on the frontend too — belt-and-braces over the
        // backend debounce.
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          void reloadFromDiskRef.current();
        }, 150);
      });
      // The effect may have been torn down while awaiting; drop the listener.
      if (disposed) {
        off();
      } else {
        unlisten = off;
      }
    };
    void start();

    return () => {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      unlisten?.();
      void unwatchLocalFile(watchId).catch(() => {
        // best-effort teardown
      });
    };
  }, [meta.isRemote, isUnsavedScratch, effectivePath, watchId, tabId]);

  // Poll a remote (SFTP / session) file for external on-disk changes (#1627).
  // Remote transports can't OS-watch, so we re-`stat` the open file on an
  // interval and compare mtime/size to the last-seen baseline; a change routes
  // through the same reload/conflict path (#1620) the local watcher uses. Kept
  // lightweight: only the focused, *visible* tab polls, it pauses while the
  // window is not focused, and a stat is a single metadata round-trip. A
  // detected change re-reads the full file (via `reloadFromDisk`) only then.
  useEffect(() => {
    if (!meta.isRemote || isUnsavedScratch || !isVisible) return;
    const sftpSessionId = meta.sftpSessionId;
    const sessionId = meta.sessionBrowser?.sessionId;
    if (!sftpSessionId && !sessionId) return;
    const filePath = effectivePath;

    // Reset the baseline when the tab now points at a different remote file;
    // preserve it across visibility toggles (same identity) so a change that
    // landed while the tab was hidden is caught on the next visible poll.
    const identityKey = `${sftpSessionId ?? ""}|${sessionId ?? ""}|${filePath}`;
    if (remoteBaselineRef.current.key !== identityKey) {
      remoteBaselineRef.current = { key: identityKey, value: null };
    }

    let disposed = false;

    const statFile = async (): Promise<{ modified: string; size: number } | null> => {
      try {
        const entry = sftpSessionId
          ? await sftpStat(sftpSessionId, filePath)
          : await sessionStat(sessionId!, filePath);
        return { modified: entry.modified, size: entry.size };
      } catch (err) {
        frontendLog(
          "file_editor",
          `remote stat poll failed for tab ${tabId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return null;
      }
    };

    const tick = async () => {
      if (disposed) return;
      // Pause while the window is not focused — no point polling a remote file
      // the user isn't looking at. (jsdom / older envs may lack hasFocus.)
      if (typeof document !== "undefined" && typeof document.hasFocus === "function") {
        if (!document.hasFocus()) return;
      }
      const current = await statFile();
      if (disposed || !current) return;
      const baseline = remoteBaselineRef.current.value;
      // Seed the baseline on the first successful stat; only later changes fire.
      if (baseline === null) {
        remoteBaselineRef.current = { key: identityKey, value: current };
        return;
      }
      if (current.modified !== baseline.modified || current.size !== baseline.size) {
        remoteBaselineRef.current = { key: identityKey, value: current };
        frontendLog(
          "file_editor",
          `remote external change detected for tab ${tabId} (mtime/size changed)`
        );
        void reloadFromDiskRef.current();
      }
    };

    // Seed immediately so the first real detection latency is one interval, then
    // poll, and re-check the moment the window regains focus.
    void tick();
    const interval = setInterval(() => {
      void tick();
    }, REMOTE_POLL_INTERVAL_MS);
    const onFocus = () => {
      void tick();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      disposed = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [
    meta.isRemote,
    meta.sftpSessionId,
    meta.sessionBrowser,
    isUnsavedScratch,
    isVisible,
    effectivePath,
    tabId,
  ]);

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
      if (!advancedOps) return "error";
      frontendLog(
        "file_editor",
        `elevated save attempt for ${meta.filePath} on ${hostLabel ?? "unknown host"}`
      );
      let result: ElevatedWriteResult;
      try {
        result = await advancedOps.writeElevated(meta.filePath, bufferContent, password);
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
    [advancedOps, meta.filePath, hostLabel]
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
      if (content === null || !advancedOps) return;
      setSaveCopyBusy(true);
      const toastId = toast.loading(`Saving a copy to ${destPath}…`);
      try {
        await advancedOps.writeContent(destPath, content);
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
    [content, advancedOps, meta.filePath]
  );

  // Download the read-only remote file to a user-chosen local path (#1330). The
  // terminal success/error toast is owned by the transfer-progress event path
  // (useTransferEvents); here we only show the pending toast and surface an
  // early failure that never produced a transfer event.
  const handleDownloadCopy = useCallback(async () => {
    if (!advancedOps) return;
    const localPath = await save({ title: "Download a copy…", defaultPath: fileName });
    if (!localPath) return;
    const toastId = toast.loading(`Downloading ${fileName}…`);
    try {
      await advancedOps.download(meta.filePath, localPath);
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
  }, [advancedOps, meta.filePath, fileName]);

  const handleSave = useCallback(async () => {
    if (content === null || saving) return;

    // Read-only remote file that has a shell, or an already-elevated session:
    // route through the sudo path instead of the direct write. Applies to both
    // SFTP-advanced transports (legacy sftp and SFTP-backed session, #2420).
    if (advancedOps && (elevated || (writable === false && execCapable))) {
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
    advancedOps,
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
      {diskChangedWhileDirty && (
        <div
          className="file-editor__disk-changed-banner"
          role="status"
          data-testid="file-editor-disk-changed-banner"
        >
          <AlertCircle size={14} />
          <span className="file-editor__disk-changed-banner-text">
            This file changed on disk while you have unsaved changes. Your edits are kept and
            nothing was overwritten.
          </span>
          <Button
            variant="secondary"
            size="sm"
            icon={<RotateCcw size={14} />}
            onClick={handleReloadFromDisk}
            title="Discard your unsaved edits and load the version on disk"
            data-testid="file-editor-disk-changed-reload"
          >
            Reload from disk
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<FileEdit size={14} />}
            onClick={handleKeepMyChanges}
            title="Keep your unsaved edits; ignore the on-disk change until you next save"
            data-testid="file-editor-disk-changed-keep"
          >
            Keep my changes
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<X size={14} />}
            onClick={handleKeepMyChanges}
            title="Dismiss"
            aria-label="Dismiss on-disk change notice"
            data-testid="file-editor-disk-changed-dismiss"
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
