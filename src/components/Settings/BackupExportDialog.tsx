import { useState, useEffect, useCallback } from "react";
import { save } from "@/services/nativeDialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { exportBackup, isVaultError, listBackupSections, localOpenFolder } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { BackupSectionInfo } from "@/types/backup";
import type { CredentialStorageMode, OsAuthInfo } from "@/types/credential";
import { useOsAuthInfo } from "@/hooks/useOsAuthInfo";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button, Checkbox, Field, Toggle, toast } from "@/components/ui";
import type { ToastOptions } from "@/components/ui";
import { MIN_EXPORT_PASSPHRASE_LENGTH, ratePassphrase } from "@/utils/passphraseStrength";
import { errorMessage } from "@/utils/errorMessage";
import { getBasename, parentDir } from "@/utils/paths";
import { fileManagerActionLabel } from "@/utils/platform";
import { keychainExportReason } from "./CredentialVaultBackup";
import "./CredentialVault.css";
import "./BackupRestore.css";

interface BackupExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** How long an export warning stays on screen. */
const WARNING_TOAST_MS = 15_000;

/** Why a section can only be backed up with encryption turned on. */
function encryptionReason(section: BackupSectionInfo): string {
  return section.containsSecrets
    ? "Contains passwords — needs encryption"
    : "Trust decisions — needs encryption";
}

/** Default file name for a backup, dated so successive backups don't collide. */
function defaultBackupFileName(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `termihub-backup-${date}.json`;
}

/** Why the credentials cannot be included from the current store, or null. */
export function credentialsExportBlockedReason(
  mode: CredentialStorageMode,
  status: string | undefined,
  osAuth: OsAuthInfo | null
): string | null {
  if (mode === "none") return "Credential storage is off — there are no saved credentials.";
  if (mode === "os_keychain") return keychainExportReason(osAuth);
  if (status === "unavailable") return "No master password has been set up yet.";
  return null;
}

/** Lower-case a label's first letter for mid-sentence use, keeping acronyms ("SSH …"). */
function midSentence(label: string): string {
  if (label.length > 1 && label[1] === label[1].toUpperCase() && /[A-Z]/.test(label[1])) {
    return label;
  }
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** Join items as "a, b and c". */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The success toast after a backup: names the file and what went into it, e.g.
 * "Backup saved to termihub-backup.json — connections, settings and 1 credential."
 */
export function backupSavedMessage(
  fileName: string,
  sectionLabels: readonly string[],
  credentialCount: number | null
): string {
  const items = sectionLabels.map(midSentence);
  if (credentialCount !== null) {
    items.push(`${credentialCount} credential${credentialCount === 1 ? "" : "s"}`);
  }
  return items.length > 0
    ? `Backup saved to ${fileName} — ${joinList(items)}.`
    : `Backup saved to ${fileName}.`;
}

/** Toast action that reveals the folder holding the saved backup. */
function revealAction(filePath: string): NonNullable<ToastOptions["action"]> {
  return {
    label: fileManagerActionLabel(),
    onClick: () => {
      localOpenFolder(parentDir(filePath)).catch((err: unknown) => {
        toast.error(`Could not open the folder: ${errorMessage(err)}`);
      });
    },
  };
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
  const { info: osAuth } = useOsAuthInfo();
  const credentialsBlocked = credentialsExportBlockedReason(mode, status, osAuth);

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
        toast.info("Backup canceled — no file was written.");
        return;
      }
      await writeTextFile(filePath, result.json);
      const labelOf = (id: string) => sections?.find((sec) => sec.id === id)?.label ?? id;
      const message = backupSavedMessage(
        getBasename(filePath),
        result.sections.map(labelOf),
        result.credentialCount
      );
      const action = revealAction(filePath);
      if (result.warnings.length > 0) {
        // Something was left out (e.g. a plugin over the size cap): keep the
        // explanation on screen long enough to read.
        toast.info(`${message} Some items were left out.`, {
          description: result.warnings.join("\n"),
          duration: WARNING_TOAST_MS,
          action,
        });
      } else {
        toast.success(message, { action });
      }
      onOpenChange(false);
    } catch (err) {
      setError(isVaultError(err) ? err.message : errorMessage(err));
      throw err;
    }
  }, [
    mode,
    status,
    sections,
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

  // Connections first, then Credentials (security-relevant, so never below the
  // fold), then the other sections that hold something; empty ones collapse
  // into one line (#5613).
  const present = sections?.filter((sec) => sec.present) ?? [];
  const firstSections = present.filter((sec) => sec.id === "connections");
  const otherSections = present.filter((sec) => sec.id !== "connections");
  const emptySections = sections?.filter((sec) => !sec.present) ?? [];

  const renderSection = (sec: BackupSectionInfo) => {
    const disabled = sec.requiresEncryption && !encrypt;
    return (
      <li key={sec.id} className="backup-restore__row">
        <Checkbox
          id={`backup-export-${sec.id}`}
          checked={selected.has(sec.id)}
          onCheckedChange={(checked) => toggleSection(sec.id, checked)}
          disabled={disabled}
          data-testid={`backup-export-section-${sec.id}`}
        />
        <label htmlFor={`backup-export-${sec.id}`} className="backup-restore__label">
          <span className="backup-restore__name">{sec.label}</span>
          <span className="backup-restore__detail">
            {disabled ? encryptionReason(sec) : sec.description}
          </span>
        </label>
      </li>
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={<span data-testid="backup-export-title">Back up everything</span>}
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
          {firstSections.map(renderSection)}
          <li className="backup-restore__row" data-testid="backup-export-credentials-row">
            <Checkbox
              id="backup-export-credentials"
              checked={includeCredentials}
              onCheckedChange={setIncludeCredentials}
              disabled={credentialsBlocked !== null}
              data-testid="backup-export-credentials"
            />
            <div className="backup-export__row-body">
              <label htmlFor="backup-export-credentials" className="backup-restore__label">
                <span className="backup-restore__name">Credentials</span>
                <span
                  className="backup-restore__detail"
                  data-testid="backup-export-credentials-detail"
                >
                  {credentialsBlocked ??
                    (mode === "os_keychain" && osAuth
                      ? `Saved passwords and key passphrases, always encrypted with the passphrase. You'll confirm with ${osAuth.exportReauth.methodLabel}.`
                      : "Saved passwords and key passphrases, always encrypted with the passphrase.")}
                </span>
              </label>
              {includeCredentials && mode === "master_password" && (
                <Field
                  label="Current master password"
                  htmlFor="backup-export-master-password"
                  labelTestId="backup-export-master-password-label"
                  hint="Needed to include your saved credentials."
                  data-testid="backup-export-master-password-field"
                >
                  <PasswordInput
                    id="backup-export-master-password"
                    className="ui-input"
                    value={masterPassword}
                    onChange={(e) => setMasterPassword(e.target.value)}
                    data-testid="backup-export-master-password"
                  />
                </Field>
              )}
            </div>
          </li>
          {otherSections.map(renderSection)}
          {emptySections.length > 0 && (
            <li className="backup-restore__detail" data-testid="backup-export-empty-sections">
              {`Nothing saved yet: ${emptySections.map((sec) => midSentence(sec.label)).join(", ")}`}
            </li>
          )}
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
        {needsPassphrase && (
          <>
            <Field
              label="Backup passphrase"
              htmlFor="backup-export-passphrase"
              labelTestId="backup-export-passphrase-label"
              data-testid="backup-export-passphrase-field"
              hint={
                passphrase.length > 0 ? (
                  <span
                    className={`credential-vault__strength credential-vault__strength--${strength.strength}`}
                    data-testid="backup-export-strength"
                    aria-live="polite"
                  >
                    {strength.hint}
                  </span>
                ) : (
                  `At least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters.`
                )
              }
            >
              <PasswordInput
                id="backup-export-passphrase"
                className="ui-input"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                data-testid="backup-export-passphrase"
              />
            </Field>
            <Field
              label="Repeat backup passphrase"
              htmlFor="backup-export-confirm"
              labelTestId="backup-export-confirm-label"
              data-testid="backup-export-confirm-field"
            >
              <PasswordInput
                id="backup-export-confirm"
                className="ui-input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                data-testid="backup-export-confirm"
              />
            </Field>
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
