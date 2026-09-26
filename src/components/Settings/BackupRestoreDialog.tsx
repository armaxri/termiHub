import { useState, useEffect, useCallback } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import {
  applyBackupRestore,
  isVaultError,
  previewBackupRestore,
  readBackupHeader,
  restartAfterBackupRestore,
} from "@/services/api";
import type {
  BackupHeader,
  BackupRestorePreview,
  BackupRestoreRequest,
  BackupSectionPreview,
} from "@/types/backup";
import type { VaultConflictStrategy } from "@/types/credential";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button, toast } from "@/components/ui";
import { errorMessage } from "@/utils/errorMessage";
import { BackupSectionRow, type SectionChoice } from "./BackupSectionRow";
import { BackupCredentialsRow } from "./BackupCredentialsRow";
import "./CredentialVault.css";
import "./BackupRestore.css";

interface BackupRestoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Whether a previewed section can be restored at all. */
export function isRestorable(section: BackupSectionPreview): boolean {
  return section.status === "ok" || section.status === "migrated";
}

/** The initial choice for each previewed section. */
export function defaultChoices(preview: BackupRestorePreview): Record<string, SectionChoice> {
  const choices: Record<string, SectionChoice> = {};
  for (const s of preview.sections) {
    choices[s.id] = {
      include: isRestorable(s),
      mode: s.supportsMerge ? "merge" : "replace",
      conflicts: "skip",
    };
  }
  return choices;
}

/** Build the restore request from the dialog's choices. */
export function buildRestoreRequest(
  preview: BackupRestorePreview,
  choices: Record<string, SectionChoice>,
  credentials: VaultConflictStrategy | null
): BackupRestoreRequest {
  return {
    sections: preview.sections
      .filter((s) => isRestorable(s) && choices[s.id]?.include)
      .map((s) => ({ id: s.id, mode: choices[s.id].mode, conflicts: choices[s.id].conflicts })),
    credentials,
  };
}

/** File name shown for a picked path, without leaking the full directory. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Restore a backup (PROD-068): pick the file (+ passphrase) → per-section
 * preview → choose parts, merge or replace, and conflict handling → restore.
 * The backend applies the chosen parts all-or-nothing; termiHub then restarts
 * so the restored stores load fresh.
 */
export function BackupRestoreDialog({ open, onOpenChange }: BackupRestoreDialogProps) {
  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [header, setHeader] = useState<BackupHeader | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [preview, setPreview] = useState<BackupRestorePreview | null>(null);
  const [choices, setChoices] = useState<Record<string, SectionChoice>>({});
  const [restoreCredentials, setRestoreCredentials] = useState(false);
  const [credentialStrategy, setCredentialStrategy] = useState<VaultConflictStrategy>("skip");
  const [error, setError] = useState("");

  // Drop the file contents and passphrase whenever the dialog opens or closes.
  useEffect(() => {
    setFileName("");
    setFileContent("");
    setHeader(null);
    setPassphrase("");
    setPreview(null);
    setChoices({});
    setRestoreCredentials(false);
    setCredentialStrategy("skip");
    setError("");
  }, [open]);

  const handleChooseFile = useCallback(async () => {
    setError("");
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "termiHub backup", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const text = await readTextFile(selected);
      setHeader(await readBackupHeader(text));
      setFileContent(text);
      setFileName(baseName(selected));
      setPreview(null);
    } catch (err) {
      setHeader(null);
      setFileContent("");
      setError(isVaultError(err) ? err.message : `Could not read the file: ${errorMessage(err)}`);
    }
  }, []);

  const handlePreview = useCallback(async () => {
    const validationError = !header
      ? "Choose a backup file first."
      : header.needsPassphrase && !passphrase
        ? "Enter the passphrase the backup was created with."
        : null;
    if (validationError) {
      setError(validationError);
      throw new Error(validationError);
    }
    setError("");
    try {
      const result = await previewBackupRestore(fileContent, passphrase || null);
      setPreview(result);
      setChoices(defaultChoices(result));
      setRestoreCredentials(result.credentials?.available ?? false);
    } catch (err) {
      setError(isVaultError(err) ? err.message : errorMessage(err));
      throw err;
    }
  }, [header, passphrase, fileContent]);

  const request = preview
    ? buildRestoreRequest(preview, choices, restoreCredentials ? credentialStrategy : null)
    : null;
  const nothingChosen = !request || (request.sections.length === 0 && !request.credentials);
  const replacing = preview?.sections.filter(
    (s) => isRestorable(s) && choices[s.id]?.include && choices[s.id]?.mode === "replace"
  );

  const handleRestore = useCallback(async () => {
    if (!request || nothingChosen) {
      const message = "Choose at least one thing to restore.";
      setError(message);
      throw new Error(message);
    }
    setError("");
    try {
      const result = await applyBackupRestore(fileContent, passphrase || null, request);
      if (result.restartRequired) {
        toast.success("Backup restored — termiHub is restarting to load it.");
        await restartAfterBackupRestore();
      } else {
        toast.success("Credentials restored.");
      }
      onOpenChange(false);
    } catch (err) {
      setError(isVaultError(err) ? err.message : errorMessage(err));
      throw err;
    }
  }, [request, nothingChosen, fileContent, passphrase, onOpenChange]);

  const setChoice = useCallback((id: string, patch: Partial<SectionChoice>) => {
    setChoices((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  const willRestart = (request?.sections.length ?? 0) > 0;
  const footer = (
    <>
      <Button variant="secondary" onClick={() => onOpenChange(false)}>
        Cancel
      </Button>
      {preview ? (
        <Button
          variant="primary"
          onClick={handleRestore}
          errorToast={false}
          disabled={nothingChosen}
          pendingLabel="Restoring…"
          data-testid="backup-restore-submit"
        >
          {willRestart ? "Restore and restart" : "Restore"}
        </Button>
      ) : (
        <Button
          type="submit"
          form="backup-restore-form"
          variant="primary"
          onClick={handlePreview}
          errorToast={false}
          disabled={!header}
          pendingLabel="Reading backup…"
          data-testid="backup-restore-preview"
        >
          Preview
        </Button>
      )}
    </>
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={<span data-testid="backup-restore-title">Restore Backup</span>}
      footer={footer}
    >
      {!preview ? (
        <form id="backup-restore-form" className="credential-vault__form">
          <p className="credential-vault__note">
            Nothing is changed until you review the backup and confirm the restore.
          </p>
          <div className="credential-vault__file-row">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleChooseFile()}
              data-testid="backup-restore-choose-file"
            >
              Choose file…
            </Button>
            <span data-testid="backup-restore-file-name">{fileName || "No file selected"}</span>
          </div>
          {header && (
            <p className="credential-vault__note" data-testid="backup-restore-header">
              Created {new Date(header.createdAt).toLocaleString()}
              {header.appVersion ? ` by termiHub ${header.appVersion}` : ""}
              {header.encrypted ? " · encrypted" : " · not encrypted"}
            </p>
          )}
          {header?.needsPassphrase && (
            <PasswordInput
              className="ui-input"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Backup passphrase"
              aria-label="Backup passphrase"
              data-testid="backup-restore-passphrase"
            />
          )}
        </form>
      ) : (
        <div className="credential-vault__form" data-testid="backup-restore-preview-panel">
          <ul className="backup-restore__list">
            {preview.sections.map((s) => (
              <BackupSectionRow
                key={s.id}
                section={s}
                choice={choices[s.id]}
                restorable={isRestorable(s)}
                onChange={(patch) => setChoice(s.id, patch)}
              />
            ))}
            {preview.credentials && (
              <BackupCredentialsRow
                credentials={preview.credentials}
                include={restoreCredentials}
                strategy={credentialStrategy}
                onIncludeChange={setRestoreCredentials}
                onStrategyChange={setCredentialStrategy}
              />
            )}
          </ul>
          {replacing && replacing.length > 0 && (
            <p className="credential-vault__warning" data-testid="backup-restore-replace-warning">
              Replace overwrites your current {replacing.map((s) => s.label).join(", ")}: anything
              not in the backup is removed. This cannot be undone.
            </p>
          )}
          {willRestart && (
            <p className="credential-vault__note">
              termiHub restarts to finish the restore. Save any open work first.
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="credential-vault__error" role="alert" data-testid="backup-restore-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
