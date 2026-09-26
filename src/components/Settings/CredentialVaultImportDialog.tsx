import { useState, useEffect, useCallback } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { importCredentialVault, isVaultError, previewCredentialVaultImport } from "@/services/api";
import type {
  VaultConflict,
  VaultConflictStrategy,
  VaultImportPreview,
  VaultImportResult,
} from "@/types/credential";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button, RadioGroup, toast } from "@/components/ui";
import { errorMessage } from "@/utils/errorMessage";
import "./CredentialVault.css";

interface CredentialVaultImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display label of the active store mode, for the dialog copy. */
  modeLabel: string;
}

const CREDENTIAL_TYPE_LABELS: Record<string, string> = {
  password: "Password",
  key_passphrase: "Key passphrase",
  sudo_password: "Sudo password",
};

/** Human label for one conflicting credential. */
function conflictLabel(conflict: VaultConflict): string {
  const owner = conflict.ownerName ?? conflict.connectionId;
  const type = CREDENTIAL_TYPE_LABELS[conflict.credentialType] ?? conflict.credentialType;
  return `${owner} — ${type}`;
}

/** Pluralize "credential". */
function credentials(count: number): string {
  return `${count} credential${count !== 1 ? "s" : ""}`;
}

/** One-line summary of a completed import for the success toast. */
export function importSummary(result: VaultImportResult): string {
  const parts = [`${credentials(result.importedCount)} imported`];
  if (result.overwrittenCount > 0) parts.push(`${result.overwrittenCount} overwritten`);
  if (result.skippedCount > 0) parts.push(`${result.skippedCount} kept as-is`);
  if (result.unchangedCount > 0) parts.push(`${result.unchangedCount} already up to date`);
  return `Credential vault imported: ${parts.join(", ")}.`;
}

/** File name shown for a picked path, without leaking the full directory. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Import an encrypted credential-vault file into the current store (PROD-063).
 *
 * Two steps: pick the file + enter its passphrase → preview (counts and
 * conflicts, nothing written) → choose skip/overwrite → import. The backend
 * applies the import all-or-nothing.
 */
export function CredentialVaultImportDialog({
  open,
  onOpenChange,
  modeLabel,
}: CredentialVaultImportDialogProps) {
  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [preview, setPreview] = useState<VaultImportPreview | null>(null);
  const [strategy, setStrategy] = useState<VaultConflictStrategy>("skip");
  const [error, setError] = useState("");

  // Drop the file contents and passphrase whenever the dialog opens or closes.
  useEffect(() => {
    setFileName("");
    setFileContent("");
    setPassphrase("");
    setPreview(null);
    setStrategy("skip");
    setError("");
  }, [open]);

  const handleChooseFile = useCallback(async () => {
    setError("");
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "termiHub credential vault", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const text = await readTextFile(selected);
      setFileContent(text);
      setFileName(baseName(selected));
      setPreview(null);
    } catch (err) {
      setError(`Could not read the file: ${errorMessage(err)}`);
    }
  }, []);

  const handlePreview = useCallback(async () => {
    const validationError = !fileContent
      ? "Choose a vault export file first."
      : !passphrase
        ? "Enter the passphrase the vault was exported with."
        : null;
    if (validationError) {
      setError(validationError);
      throw new Error(validationError);
    }
    setError("");
    try {
      setPreview(await previewCredentialVaultImport(fileContent, passphrase));
    } catch (err) {
      setError(isVaultError(err) ? err.message : errorMessage(err));
      throw err;
    }
  }, [fileContent, passphrase]);

  const handleImport = useCallback(async () => {
    setError("");
    try {
      const result = await importCredentialVault(fileContent, passphrase, strategy);
      toast.success(importSummary(result));
      onOpenChange(false);
    } catch (err) {
      setError(isVaultError(err) ? err.message : errorMessage(err));
      throw err;
    }
  }, [fileContent, passphrase, strategy, onOpenChange]);

  const footer = (
    <>
      <Button variant="secondary" onClick={() => onOpenChange(false)}>
        Cancel
      </Button>
      {preview ? (
        <Button
          variant="primary"
          onClick={handleImport}
          errorToast={false}
          pendingLabel="Importing…"
          data-testid="vault-import-submit"
        >
          Import
        </Button>
      ) : (
        <Button
          type="submit"
          form="vault-import-form"
          variant="primary"
          onClick={handlePreview}
          errorToast={false}
          pendingLabel="Decrypting…"
          data-testid="vault-import-preview"
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
      title={<span data-testid="vault-import-title">Import Credential Vault</span>}
      footer={footer}
    >
      {!preview ? (
        <form id="vault-import-form" className="credential-vault__form">
          <p className="credential-vault__note">
            Credentials are imported into your current store ({modeLabel}). Nothing is changed until
            you confirm the import.
          </p>
          <div className="credential-vault__file-row">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleChooseFile()}
              data-testid="vault-import-choose-file"
            >
              Choose file…
            </Button>
            <span data-testid="vault-import-file-name">{fileName || "No file selected"}</span>
          </div>
          <PasswordInput
            className="ui-input"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Vault passphrase"
            aria-label="Vault passphrase"
            data-testid="vault-import-passphrase"
          />
        </form>
      ) : (
        <div className="credential-vault__form" data-testid="vault-import-preview-panel">
          <ul className="credential-vault__summary">
            <li data-testid="vault-import-count-total">
              {credentials(preview.totalCount)} in the file
            </li>
            <li data-testid="vault-import-count-new">{preview.newCount} new</li>
            <li>{preview.unchangedCount} already up to date</li>
            <li data-testid="vault-import-count-conflicts">
              {preview.conflictCount} differ from what is saved here
            </li>
          </ul>
          {preview.unknownOwnerCount > 0 && (
            <p className="credential-vault__note" data-testid="vault-import-unknown-owners">
              {credentials(preview.unknownOwnerCount)} belong to connections or agents that are not
              saved on this machine. They are imported anyway and apply once those connections exist
              (for example after importing your connections).
            </p>
          )}
          {preview.conflictCount > 0 && (
            <>
              <ul className="credential-vault__conflicts" data-testid="vault-import-conflicts">
                {preview.conflicts.map((c) => (
                  <li key={`${c.connectionId}:${c.credentialType}`}>{conflictLabel(c)}</li>
                ))}
              </ul>
              <RadioGroup
                className="credential-vault__form"
                value={strategy}
                onValueChange={(v) => setStrategy(v as VaultConflictStrategy)}
                aria-label="When a credential already exists"
                options={[
                  {
                    value: "skip",
                    label: "Keep my existing credentials",
                    "data-testid": "vault-import-strategy-skip",
                  },
                  {
                    value: "overwrite",
                    label: "Replace them with the imported ones",
                    "data-testid": "vault-import-strategy-overwrite",
                  },
                ]}
              />
              {strategy === "overwrite" && (
                <p
                  className="credential-vault__warning"
                  data-testid="vault-import-overwrite-warning"
                >
                  {credentials(preview.conflictCount)} saved on this machine will be replaced. This
                  cannot be undone.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <p className="credential-vault__error" role="alert" data-testid="vault-import-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
