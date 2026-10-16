import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, FileSearch, FolderOpen } from "lucide-react";
import { Button, EmptyState, Modal, Select, Spinner, toast } from "@/components/ui";
import type {
  ConnectionFolder,
  HostKeyImportResult,
  MobaxtermHostKey,
  MobaxtermSession,
  SavedConnection,
} from "@/types/connection";
import {
  discoverMobaxtermConfigs,
  importMobaxtermHostKeys,
  previewMobaxtermImport,
} from "@/services/api";
import { open as openFileDialog } from "@/services/nativeDialog";
import { withLoggedFallback } from "@/utils/loggedFallback";
import { buildMobaxtermImportPlan, isImportable } from "@/services/mobaxtermImport";
import {
  importFolderOptions,
  resolveImportFolderId,
  ROOT_FOLDER_VALUE,
} from "@/services/sshConfigImport";
import { MobaxtermHostKeyList } from "./MobaxtermHostKeyList";
import { MobaxtermSessionList } from "./MobaxtermSessionList";
import "../Sidebar/BulkSshImportDialog.css";
import "./MobaxtermImportDialog.css";

interface MobaxtermImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Folders offered as import targets (root is always added first). */
  folders: ConnectionFolder[];
  /** Existing connections, used for per-folder name-collision handling. */
  existingConnections: SavedConnection[];
  /** Persist the new folders (parents first), then the connections. */
  onImport: (folders: ConnectionFolder[], connections: SavedConnection[]) => Promise<void>;
}

type LoadState =
  | { status: "discovering" }
  | { status: "no-source" }
  | { status: "loading"; path: string }
  | {
      status: "ready";
      path: string;
      sessions: MobaxtermSession[];
      hostKeys: MobaxtermHostKey[];
      notes: string[];
    }
  | { status: "error"; path: string; message: string };

/** The file kinds MobaXterm stores sessions in. */
const MOBAXTERM_FILTERS = [{ name: "MobaXterm sessions", extensions: ["ini", "mxtsessions"] }];

/** A readable message from a rejected backend call. */
function describeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

/** Surface the outcome of the host-key import (#4852). */
function reportHostKeys(result: HostKeyImportResult) {
  const n = result.imported;
  if (n > 0) toast.success(`Trusted ${n} SSH host ${n === 1 ? "key" : "keys"} from MobaXterm.`);
  if (result.skipped.length > 0) {
    toast.error(`${result.skipped.length} host keys were not imported.`, {
      description: result.skipped.join("\n"),
    });
  }
}

/**
 * Import saved sessions from MobaXterm (#4850). On open it looks for a local
 * MobaXterm configuration (Windows: installed edition / Documents) and previews
 * the first one found; on every OS the user can pick a `MobaXterm.ini` or
 * `.mxtsessions` file instead. The preview lists each session with its type,
 * target and folder — importable ones selectable (all selected by default),
 * the rest with the reason they are skipped. Importing recreates MobaXterm's
 * folder tree under the chosen target folder; names collide-resolve within
 * each folder like the `~/.ssh/config` import. Passwords are never imported.
 * MobaXterm's accepted SSH host keys (#4852) are listed too and trusted only
 * when the user opts in; conflicting or invalid keys are shown and skipped.
 */
export function MobaxtermImportDialog({
  open,
  onOpenChange,
  folders,
  existingConnections,
  onImport,
}: MobaxtermImportDialogProps) {
  const [state, setState] = useState<LoadState>({ status: "discovering" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [folderId, setFolderId] = useState<string>(ROOT_FOLDER_VALUE);
  // Host keys are trust anchors: never imported without this explicit opt-in.
  const [importHostKeys, setImportHostKeys] = useState(false);

  const folderOptions = useMemo(() => importFolderOptions(folders), [folders]);

  const loadPreview = useCallback(async (path: string, isCancelled: () => boolean) => {
    setState({ status: "loading", path });
    try {
      const preview = await previewMobaxtermImport(path);
      if (isCancelled()) return;
      const sessions = preview.sessions ?? [];
      setSelected(new Set(sessions.filter(isImportable).map((s) => s.key)));
      setImportHostKeys(false);
      setState({
        status: "ready",
        path,
        sessions,
        hostKeys: preview.hostKeys ?? [],
        notes: preview.notes ?? [],
      });
    } catch (err) {
      if (!isCancelled()) setState({ status: "error", path, message: describeError(err) });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    setState({ status: "discovering" });
    setSelected(new Set());
    setFolderId(ROOT_FOLDER_VALUE);
    void withLoggedFallback(
      discoverMobaxtermConfigs(),
      [],
      "mobaxterm_import",
      "look for a MobaXterm configuration"
    ).then((found) => {
      if (cancelled) return;
      const first = found?.[0];
      if (first) void loadPreview(first.path, isCancelled);
      else setState({ status: "no-source" });
    });
    return () => {
      cancelled = true;
    };
  }, [open, loadPreview]);

  const handleChooseFile = async () => {
    const picked = await openFileDialog({ multiple: false, filters: MOBAXTERM_FILTERS });
    if (typeof picked !== "string") return;
    await loadPreview(picked, () => false);
  };

  const sessions = state.status === "ready" ? state.sessions : [];
  const importable = sessions.filter(isImportable);
  const skipped = sessions.filter((s) => !isImportable(s));
  const hostKeys = state.status === "ready" ? state.hostKeys : [];
  const newHostKeys = hostKeys.filter((k) => k.status === "new" && k.fingerprint);
  const trustCount = importHostKeys ? newHostKeys.length : 0;

  const toggleOne = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === importable.length ? new Set() : new Set(importable.map((s) => s.key))
    );
  };

  const sourcePath = "path" in state ? state.path : null;

  const handleImport = async () => {
    const chosen = importable.filter((s) => selected.has(s.key));
    if (chosen.length === 0 && trustCount === 0) return;
    if (chosen.length > 0) {
      const plan = buildMobaxtermImportPlan(
        chosen,
        resolveImportFolderId(folderId),
        folders,
        existingConnections
      );
      await onImport(plan.folders, plan.connections);
    }
    if (trustCount > 0 && sourcePath) {
      const selections = newHostKeys.map((k) => ({ id: k.id, fingerprint: k.fingerprint ?? "" }));
      try {
        reportHostKeys(await importMobaxtermHostKeys(sourcePath, selections));
      } catch (err) {
        toast.error("Could not import the MobaXterm host keys.", {
          description: describeError(err),
        });
      }
    }
    onOpenChange(false);
  };

  const canImport = state.status === "ready" && (selected.size > 0 || trustCount > 0);
  const submitLabel = !canImport
    ? "Import"
    : selected.size > 0
      ? `Import ${selected.size}`
      : "Import host keys";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Import from MobaXterm"
      description="Bring your saved MobaXterm sessions into termiHub, folders included. Passwords are not imported."
      size="lg"
      data-testid="mobaxterm-import-dialog"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="mobaxterm-import-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={!canImport}
            data-testid="mobaxterm-import-submit"
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="mobaxterm-import">
        {state.status !== "discovering" && (
          <div className="mobaxterm-import__source" data-testid="mobaxterm-import-source">
            <span className="mobaxterm-import__source-text">
              <span className="mobaxterm-import__source-label">
                {sourcePath ? "Reading sessions from" : "No MobaXterm configuration was found"}
              </span>
              <span className="mobaxterm-import__source-path" title={sourcePath ?? undefined}>
                {sourcePath ?? "Choose a MobaXterm.ini or an exported .mxtsessions file."}
              </span>
            </span>
            <Button
              variant="secondary"
              size="sm"
              icon={<FolderOpen size={14} aria-hidden />}
              onClick={handleChooseFile}
              data-testid="mobaxterm-import-choose-file"
            >
              {sourcePath ? "Choose another file…" : "Choose file…"}
            </Button>
          </div>
        )}

        {(state.status === "discovering" || state.status === "loading") && (
          <p className="ssh-config-import__status" data-testid="mobaxterm-import-loading">
            <Spinner size="sm" label={null} />{" "}
            {state.status === "discovering"
              ? "Looking for MobaXterm…"
              : "Reading MobaXterm sessions…"}
          </p>
        )}

        {state.status === "error" && (
          <EmptyState
            variant="panel"
            icon={<AlertTriangle size={20} aria-hidden />}
            title="Could not read that file."
            description={state.message}
            role="alert"
            data-testid="mobaxterm-import-error"
          />
        )}

        {state.status === "ready" && sessions.length === 0 && hostKeys.length === 0 && (
          <EmptyState
            variant="panel"
            icon={<FileSearch size={20} aria-hidden />}
            title="No saved MobaXterm sessions were found in this file."
            data-testid="mobaxterm-import-empty"
          />
        )}

        {state.status === "ready" && state.notes.length > 0 && (
          <ul className="mobaxterm-import__file-notes" data-testid="mobaxterm-import-file-notes">
            {state.notes.map((note) => (
              <li key={note} className="mobaxterm-import__note">
                <AlertTriangle size={12} aria-hidden />
                {note}
              </li>
            ))}
          </ul>
        )}

        {state.status === "ready" && sessions.length > 0 && (
          <>
            {importable.length > 0 && (
              <div className="bulk-ssh-import__folder">
                <label className="bulk-ssh-import__folder-label" htmlFor="mobaxterm-import-folder">
                  Import into
                </label>
                <Select
                  value={folderId}
                  onChange={setFolderId}
                  options={folderOptions}
                  aria-label="Target folder"
                  data-testid="mobaxterm-import-folder"
                />
              </div>
            )}
            <MobaxtermSessionList
              importable={importable}
              skipped={skipped}
              selected={selected}
              onToggle={toggleOne}
              onToggleAll={toggleAll}
            />
          </>
        )}

        {state.status === "ready" && (
          <MobaxtermHostKeyList
            hostKeys={hostKeys}
            importNew={importHostKeys}
            onImportNewChange={setImportHostKeys}
          />
        )}
      </div>
    </Modal>
  );
}
