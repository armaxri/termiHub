import { useState, useEffect, useCallback } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { exportCredentialVault, isVaultError } from "@/services/api";
import type { CredentialStorageMode } from "@/types/credential";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button, toast } from "@/components/ui";
import { MIN_EXPORT_PASSPHRASE_LENGTH, ratePassphrase } from "@/utils/passphraseStrength";
import { errorMessage } from "@/utils/errorMessage";
import "./CredentialVault.css";

interface CredentialVaultExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active credential store mode; master-password mode requires re-auth. */
  mode: CredentialStorageMode;
  /** OS verification method (e.g. "Touch ID"), shown in OS-keychain mode. */
  osAuthLabel?: string;
}

/** Default file name for a vault export, dated so successive backups don't collide. */
function defaultExportFileName(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `termihub-credential-vault-${date}.json`;
}

/** Client-side validation mirroring the backend rules; returns an error or null. */
function validate(
  mode: CredentialStorageMode,
  masterPassword: string,
  passphrase: string,
  confirm: string
): string | null {
  if (mode === "master_password" && !masterPassword) {
    return "Enter your master password to confirm the export.";
  }
  if ([...passphrase].length < MIN_EXPORT_PASSPHRASE_LENGTH) {
    return `The export passphrase must be at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters.`;
  }
  if (passphrase !== confirm) {
    return "The passphrases do not match.";
  }
  if (mode === "master_password" && passphrase === masterPassword) {
    return "The export passphrase must be different from your master password.";
  }
  return null;
}

/**
 * Export the credential vault to an encrypted file (PROD-063).
 *
 * Re-authenticates a master-password store, asks for an export passphrase
 * twice (with a strength hint), then saves the sealed file where the user
 * chooses. Only ciphertext ever reaches the frontend or the disk.
 */
export function CredentialVaultExportDialog({
  open,
  onOpenChange,
  mode,
  osAuthLabel,
}: CredentialVaultExportDialogProps) {
  const [masterPassword, setMasterPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  // Clear every secret whenever the dialog opens or closes.
  useEffect(() => {
    setMasterPassword("");
    setPassphrase("");
    setConfirm("");
    setError("");
  }, [open]);

  const strength = ratePassphrase(passphrase);

  const handleExport = useCallback(async () => {
    const validationError = validate(mode, masterPassword, passphrase, confirm);
    if (validationError) {
      setError(validationError);
      throw new Error(validationError);
    }
    setError("");
    try {
      const json = await exportCredentialVault(
        mode === "master_password" ? masterPassword : null,
        passphrase
      );
      const filePath = await save({
        defaultPath: defaultExportFileName(),
        filters: [{ name: "termiHub credential vault", extensions: ["json"] }],
      });
      if (!filePath) {
        toast.info("Export cancelled — no file was written.");
        return;
      }
      await writeTextFile(filePath, json);
      toast.success("Credential vault exported.");
      onOpenChange(false);
    } catch (err) {
      setError(isVaultError(err) ? err.message : errorMessage(err));
      throw err;
    }
  }, [mode, masterPassword, passphrase, confirm, onOpenChange]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={<span data-testid="vault-export-title">Export Credential Vault</span>}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="vault-export-form"
            variant="primary"
            onClick={handleExport}
            errorToast={false}
            pendingLabel="Encrypting…"
            data-testid="vault-export-submit"
          >
            Export…
          </Button>
        </>
      }
    >
      <form id="vault-export-form" className="credential-vault__form">
        <p className="credential-vault__warning" data-testid="vault-export-warning">
          The file will contain all your saved passwords and key passphrases, encrypted with the
          passphrase you choose below. Anyone with the file <strong>and</strong> the passphrase can
          read them — store it somewhere safe. If you forget the passphrase, the file cannot be
          recovered.
        </p>
        {mode === "os_keychain" && (
          <p className="credential-vault__note" data-testid="vault-export-os-auth-note">
            After you choose a passphrase, you&apos;ll be asked to confirm it&apos;s you with{" "}
            {osAuthLabel ?? "system authentication"}.
          </p>
        )}
        {mode === "master_password" && (
          <PasswordInput
            className="ui-input"
            value={masterPassword}
            onChange={(e) => setMasterPassword(e.target.value)}
            placeholder="Current master password"
            aria-label="Current master password"
            autoFocus
            data-testid="vault-export-master-password"
          />
        )}
        <PasswordInput
          className="ui-input"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder={`Export passphrase (min ${MIN_EXPORT_PASSPHRASE_LENGTH} characters)`}
          aria-label="Export passphrase"
          autoFocus={mode !== "master_password"}
          data-testid="vault-export-passphrase"
        />
        {passphrase.length > 0 && (
          <p
            className={`credential-vault__strength credential-vault__strength--${strength.strength}`}
            data-testid="vault-export-strength"
            data-strength={strength.strength}
            aria-live="polite"
          >
            {strength.hint}
          </p>
        )}
        <PasswordInput
          className="ui-input"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm export passphrase"
          aria-label="Confirm export passphrase"
          data-testid="vault-export-confirm"
        />
        {error && (
          <p className="credential-vault__error" role="alert" data-testid="vault-export-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
