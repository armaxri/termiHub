import { useState, useEffect, useCallback } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { exportBackup, isVaultError, listBackupSections } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { BackupSectionInfo } from "@/types/backup";
import type { CredentialStorageMode } from "@/types/credential";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button, Checkbox, Toggle, toast } from "@/components/ui";
import { MIN_EXPORT_PASSPHRASE_LENGTH, ratePassphrase } from "@/utils/passphraseStrength";
import { errorMessage } from "@/utils/errorMessage";
import { KEYCHAIN_EXPORT_BLOCKED_REASON } from "./CredentialVaultBackup";
import "./CredentialVault.css";
import "./BackupRestore.css";

interface BackupExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** How long an export warning stays on screen. */
const WARNING_TOAST_MS = 15_000;

/** Why a section can only be backed up with encryption turned on. */
export function encryptionReason(section: BackupSectionInfo): string {
  return section.containsSecrets
    ? "Contains passwords — needs encryption"
    : "Trust decisions — needs encryption";
}

/** Default file name for a backup, dated so successive backups don't collide. */
export function defaultBackupFileName(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `termihub-backup-${date}.json`;
}

/** Why the credentials cannot be included from the current store, or null. */
export function credentialsExportBlockedReason(
  mode: CredentialStorageMode,
  status: string | undefined
): string | null {
  if (mode === "none") return "Credential storage is off — there are no saved credentials.";
  if (mode === "os_keychain") return KEYCHAIN_EXPORT_BLOCKED_REASON;
  if (status === "unavailable") return "No master password has been set up yet.";
  return null;
}

interface ExportForm {
  mode: CredentialStorageMode;
  selected: ReadonlySet<string>;
  includeCredentials: boolean;
  encrypt: boolean;
  masterPassword: string;
  passphrase: string;
  confirm: string;
}

/** Client-side validation mirroring the backend rules; returns an error or null. */
export function validateBackupExport(form: ExportForm): string | null {
  if (form.selected.size === 0 && !form.includeCredentials) {
    return "Choose at least one thing to back up.";
  }
  if (form.includeCredentials && form.mode === "master_password" && !form.masterPassword) {
    return "Enter your master password to include your credentials.";
  }
  if (form.encrypt || form.includeCredentials) {
    if ([...form.passphrase].length < MIN_EXPORT_PASSPHRASE_LENGTH) {
      return `The passphrase must be at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters.`;
    }
    if (form.passphrase !== form.confirm) return "The passphrases do not match.";
    if (form.masterPassword && form.passphrase === form.masterPassword) {
      return "The passphrase must be different from your master password.";
    }
  }
  return null;
}

/**
 * Export everything to one backup file (PROD-068): pick the parts, optionally
 * include the encrypted credential vault, and protect the whole file with a
 * passphrase (on by default). Only ciphertext of any secret ever reaches the
 * frontend or the disk.
 */
export function BackupExportDialog({ open, onOpenChange }: BackupExportDialogProps) {
  const credentialStoreStatus = useAppStore((s) => s.credentialStoreStatus);
  const requestUnlock = useAppStore((s) => s.requestUnlock);
  const mode: CredentialStorageMode = credentialStoreStatus?.mode ?? "none";
  const status = credentialStoreStatus?.status;
  const credentialsBlocked = credentialsExportBlockedReason(mode, status);

  const [sections, setSections] = useState<BackupSectionInfo[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [encrypt, setEncrypt] = useState(true);
  const [masterPassword, setMasterPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  // Reset every field (and every secret) whenever the dialog opens or closes,
  // then load the sections that exist on this machine.
  useEffect(() => {
    setSections(null);
    setSelected(new Set());
    setIncludeCredentials(false);
    setEncrypt(true);
    setMasterPassword("");
    setPassphrase("");
    setConfirm("");
    setError("");
    if (!open) return;
    let cancelled = false;
    listBackupSections()
      .then((list) => {
        if (cancelled) return;
        setSections(list);
        setSelected(new Set(list.filter((s) => s.present).map((s) => s.id)));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`Could not read what can be backed up: ${errorMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    setIncludeCredentials(open && credentialsBlocked === null);
  }, [open, credentialsBlocked]);

  const toggleSection = useCallback((id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleEncryptChange = useCallback(
    (on: boolean) => {
      setEncrypt(on);
      if (!on && sections) {
        // Secret- and trust-bearing stores are only ever exported encrypted.
        setSelected((prev) => {
          const next = new Set(prev);
          sections.filter((s) => s.requiresEncryption).forEach((s) => next.delete(s.id));
          return next;
        });
      }
    },
    [sections]
  );

  const needsPassphrase = encrypt || includeCredentials;
  const strength = ratePassphrase(passphrase);

  const handleExport = useCallback(async () => {
    const validationError = validateBackupExport({
      mode,
      selected,
      includeCredentials,
      encrypt,
      masterPassword,
      passphrase,
      confirm,
    });
    if (validationError) {
      setError(validationError);
      throw new Error(validationError);
    }
    setError("");
    if (includeCredentials && mode === "master_password" && status === "locked") {
      if (!(await requestUnlock())) return;
    }
    try {
      const result = await exportBackup(
        { sections: [...selected], includeCredentials, encrypt },
        needsPassphrase ? passphrase : null,
        includeCredentials && mode === "master_password" ? masterPassword : null
      );
      const filePath = await save({
        defaultPath: defaultBackupFileName(),
        filters: [{ name: "termiHub backup", extensions: ["json"] }],
      });
      if (!filePath) {
        toast.info("Backup cancelled — no file was written.");
        return;
      }
      await writeTextFile(filePath, result.json);
      const parts = [`${result.sections.length} part${result.sections.length === 1 ? "" : "s"}`];
      if (result.credentialCount !== null) parts.push(`${result.credentialCount} credentials`);
      if (result.warnings.length > 0) {
        // Something was left out (e.g. a plugin over the size cap): keep the
        // explanation on screen long enough to read.
        toast.info(`Backup saved (${parts.join(", ")}), but some items were left out.`, {
          description: result.warnings.join("\n"),
          duration: WARNING_TOAST_MS,
        });
      } else {
        toast.success(`Backup saved (${parts.join(", ")}).`);
      }
      onOpenChange(false);
    } catch (err) {
      setError(isVaultError(err) ? err.message : errorMessage(err));
      throw err;
    }
  }, [
    mode,
    status,
    selected,
    includeCredentials,
    encrypt,
    masterPassword,
    passphrase,
    confirm,
    needsPassphrase,
    requestUnlock,
    onOpenChange,
  ]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={<span data-testid="backup-export-title">Back Up Everything</span>}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="backup-export-form"
            variant="primary"
            onClick={handleExport}
            errorToast={false}
            pendingLabel="Creating backup…"
            disabled={sections === null}
            data-testid="backup-export-submit"
          >
            Save backup…
          </Button>
        </>
      }
    >
      <form id="backup-export-form" className="credential-vault__form">
        <p className="credential-vault__note">Choose what to include in the backup file.</p>
        <ul className="backup-restore__list" data-testid="backup-export-sections">
          {sections?.map((s) => {
            const disabled = !s.present || (s.requiresEncryption && !encrypt);
            return (
              <li key={s.id} className="backup-restore__row">
                <Checkbox
                  id={`backup-export-${s.id}`}
                  checked={selected.has(s.id)}
                  onCheckedChange={(checked) => toggleSection(s.id, checked)}
                  disabled={disabled}
                  data-testid={`backup-export-section-${s.id}`}
                />
                <label htmlFor={`backup-export-${s.id}`} className="backup-restore__label">
                  <span className="backup-restore__name">{s.label}</span>
                  <span className="backup-restore__detail">
                    {!s.present
                      ? "Nothing saved yet"
                      : s.requiresEncryption && !encrypt
                        ? encryptionReason(s)
                        : s.description}
                  </span>
                </label>
              </li>
            );
          })}
          <li className="backup-restore__row">
            <Checkbox
              id="backup-export-credentials"
              checked={includeCredentials}
              onCheckedChange={setIncludeCredentials}
              disabled={credentialsBlocked !== null}
              data-testid="backup-export-credentials"
            />
            <label htmlFor="backup-export-credentials" className="backup-restore__label">
              <span className="backup-restore__name">Credentials</span>
              <span
                className="backup-restore__detail"
                data-testid="backup-export-credentials-detail"
              >
                {credentialsBlocked ??
                  "Saved passwords and key passphrases, always encrypted with the passphrase."}
              </span>
            </label>
          </li>
        </ul>
        <div className="backup-restore__toggle-row">
          <Toggle
            id="backup-export-encrypt"
            checked={encrypt}
            onCheckedChange={handleEncryptChange}
            data-testid="backup-export-encrypt"
          />
          <label htmlFor="backup-export-encrypt">Encrypt the whole backup (recommended)</label>
        </div>
        {!encrypt && (
          <p className="credential-vault__warning" data-testid="backup-export-plain-warning">
            Without encryption, anyone who gets the file can read your connection hosts, usernames
            and settings.
          </p>
        )}
        {includeCredentials && mode === "master_password" && (
          <PasswordInput
            className="ui-input"
            value={masterPassword}
            onChange={(e) => setMasterPassword(e.target.value)}
            placeholder="Current master password"
            aria-label="Current master password"
            data-testid="backup-export-master-password"
          />
        )}
        {needsPassphrase && (
          <>
            <PasswordInput
              className="ui-input"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={`Backup passphrase (min ${MIN_EXPORT_PASSPHRASE_LENGTH} characters)`}
              aria-label="Backup passphrase"
              data-testid="backup-export-passphrase"
            />
            {passphrase.length > 0 && (
              <p
                className={`credential-vault__strength credential-vault__strength--${strength.strength}`}
                data-testid="backup-export-strength"
                aria-live="polite"
              >
                {strength.hint}
              </p>
            )}
            <PasswordInput
              className="ui-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm backup passphrase"
              aria-label="Confirm backup passphrase"
              data-testid="backup-export-confirm"
            />
            <p className="credential-vault__note">
              You need this passphrase to restore the backup. If you forget it, the backup cannot be
              recovered.
            </p>
          </>
        )}
        {error && (
          <p className="credential-vault__error" role="alert" data-testid="backup-export-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
