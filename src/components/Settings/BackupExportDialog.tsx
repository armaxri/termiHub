import { useState, useEffect, useCallback } from "react";
import { save } from "@/services/nativeDialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { exportBackup, isVaultError, listBackupSections, localOpenFolder } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { BackupSectionInfo } from "@/types/backup";
import type { CredentialStorageMode, OsAuthInfo } from "@/types/credential";
import { useOsAuthInfo } from "@/hooks/useOsAuthInfo";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button, Checkbox, Field, toast } from "@/components/ui";
import type { ToastOptions } from "@/components/ui";
import { MIN_EXPORT_PASSPHRASE_LENGTH, ratePassphrase } from "@/utils/passphraseStrength";
import { errorMessage } from "@/utils/errorMessage";
import { getBasename, parentDir } from "@/utils/paths";
import { fileManagerActionLabel } from "@/utils/platform";
import { keychainExportReason } from "./CredentialVaultBackup";
import {
  BACKUP_EXPORT_STEP_NAMES,
  backupExportSteps,
  emptySectionsLine,
  joinList,
  midSentence,
  plainBackupBlockedReason,
  validateBackupExport,
  validateChooseStep,
  validatePassphraseStep,
  type BackupExportStep,
  type ExportForm,
} from "./backupExportForm";
import "./CredentialVault.css";
import "./BackupRestore.css";

export {
  backupExportSteps,
  emptySectionsLine,
  plainBackupBlockedReason,
  validateBackupExport,
} from "./backupExportForm";

interface BackupExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** How long an export warning stays on screen. */
const WARNING_TOAST_MS = 15_000;

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

/**
 * Back up to one file (PROD-068), step by step (#5847): choose the parts, set
 * the backup passphrase that locks the whole file, and — only when credentials
 * from the master-password vault are included — enter the master password.
 * Only ciphertext of any secret ever reaches the frontend or the disk.
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
  const [plain, setPlain] = useState(false);
  const [step, setStep] = useState<BackupExportStep>("choose");
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
    setPlain(false);
    setStep("choose");
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

  // What can only be written locked: credentials and the chosen
  // secret- or trust-bearing stores (host keys, plugins, embedded servers).
  const lockedOnly = [
    ...(includeCredentials ? ["Credentials"] : []),
    ...(sections ?? [])
      .filter((s) => s.requiresEncryption && selected.has(s.id))
      .map((s) => s.label),
  ];
  const plainBlocked = plainBackupBlockedReason(lockedOnly);
  const encrypt = !(plain && plainBlocked === null);
  const needsPassphrase = encrypt || includeCredentials;
  const needsMasterPassword = includeCredentials && mode === "master_password";
  const steps = backupExportSteps(needsMasterPassword);
  const stepIndex = Math.max(0, steps.indexOf(step));
  const isLastStep = stepIndex === steps.length - 1;
  const strength = ratePassphrase(passphrase);

  const form: ExportForm = {
    mode,
    selected,
    includeCredentials,
    encrypt,
    masterPassword,
    passphrase,
    confirm,
  };

  const goTo = (next: BackupExportStep) => {
    setError("");
    setStep(next);
  };

  const handleNext = () => {
    const validationError =
      step === "choose" ? validateChooseStep(form) : validatePassphraseStep(form);
    if (validationError) {
      setError(validationError);
      return;
    }
    goTo(steps[stepIndex + 1]);
  };

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
    if (needsMasterPassword && status === "locked") {
      if (!(await requestUnlock())) return;
    }
    try {
      const result = await exportBackup(
        { sections: [...selected], includeCredentials, encrypt },
        needsPassphrase ? passphrase : null,
        needsMasterPassword ? masterPassword : null
      );
      const filePath = await save({
        defaultPath: defaultBackupFileName(),
        filters: [{ name: "termiHub backup", extensions: ["json"] }],
      });
      if (!filePath) {
        // toast-policy: explains-outcome — no file was written, and this says so
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
        // toast-policy: no-in-place-surface — the backup is a file on disk; says what was left out
        toast.info(`${message} Some items were left out.`, {
          description: result.warnings.join("\n"),
          duration: WARNING_TOAST_MS,
          action,
        });
      } else {
        // toast-policy: no-in-place-surface — the backup is a file on disk; offers to reveal it
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
    needsMasterPassword,
    requestUnlock,
    onOpenChange,
  ]);

  // Connections first, then Credentials (security-relevant, so never below the
  // fold), then the other sections that hold something; empty ones collapse
  // into one line (#5613, #5847).
  const present = sections?.filter((sec) => sec.present) ?? [];
  const firstSections = present.filter((sec) => sec.id === "connections");
  const otherSections = present.filter((sec) => sec.id !== "connections");
  const emptySections = sections?.filter((sec) => !sec.present) ?? [];

  const renderSection = (sec: BackupSectionInfo) => (
    <li key={sec.id} className="backup-restore__row">
      <Checkbox
        id={`backup-export-${sec.id}`}
        checked={selected.has(sec.id)}
        onCheckedChange={(checked) => toggleSection(sec.id, checked)}
        data-testid={`backup-export-section-${sec.id}`}
      />
      <label htmlFor={`backup-export-${sec.id}`} className="backup-restore__label">
        <span className="backup-restore__name">{sec.label}</span>
        <span className="backup-restore__detail">{sec.description}</span>
      </label>
    </li>
  );

  const credentialsDetail =
    credentialsBlocked ??
    (mode === "os_keychain" && osAuth
      ? `Saved passwords and key passphrases. You'll confirm with ${osAuth.exportReauth.methodLabel}.`
      : mode === "master_password"
        ? "Saved passwords and key passphrases. You'll enter your master password in the last step."
        : "Saved passwords and key passphrases.");

  const chooseStep = (
    <>
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
          <label htmlFor="backup-export-credentials" className="backup-restore__label">
            <span className="backup-restore__name">Credentials</span>
            <span className="backup-restore__detail" data-testid="backup-export-credentials-detail">
              {credentialsDetail}
            </span>
          </label>
        </li>
        {otherSections.map(renderSection)}
      </ul>
      {emptySections.length > 0 && (
        <p
          className="backup-restore__detail backup-restore__folded"
          title={`Nothing saved yet: ${emptySections.map((sec) => midSentence(sec.label)).join(", ")}`}
          data-testid="backup-export-empty-sections"
        >
          {emptySectionsLine(emptySections.length)}
        </p>
      )}
    </>
  );

  const passphraseStep = (
    <>
      {encrypt ? (
        <p className="credential-vault__note" data-testid="backup-export-rule">
          Everything in this file is locked with the backup passphrase. You need it to restore the
          backup. If you forget it, the backup cannot be recovered.
        </p>
      ) : (
        <p className="credential-vault__warning" data-testid="backup-export-plain-warning">
          Without a passphrase, anyone who gets the file can read your connection hosts, usernames
          and settings.
        </p>
      )}
      {encrypt && (
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
              autoFocus
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
        </>
      )}
      <div className="backup-restore__row">
        <Checkbox
          id="backup-export-plain"
          checked={!encrypt}
          onCheckedChange={setPlain}
          disabled={plainBlocked !== null}
          data-testid="backup-export-plain"
        />
        <label htmlFor="backup-export-plain" className="backup-restore__label">
          <span className="backup-restore__name">Save without a passphrase</span>
          {plainBlocked && (
            <span className="backup-restore__detail" data-testid="backup-export-plain-detail">
              {plainBlocked}
            </span>
          )}
        </label>
      </div>
    </>
  );

  const masterPasswordStep = (
    <>
      <p className="credential-vault__note" data-testid="backup-export-master-purpose">
        Your saved credentials are locked with your master password. Enter it so termiHub can copy
        them into the backup. The file itself stays locked with the backup passphrase.
      </p>
      <Field
        label="Master password"
        htmlFor="backup-export-master-password"
        labelTestId="backup-export-master-password-label"
        data-testid="backup-export-master-password-field"
      >
        <PasswordInput
          id="backup-export-master-password"
          className="ui-input"
          value={masterPassword}
          onChange={(e) => setMasterPassword(e.target.value)}
          autoFocus
          data-testid="backup-export-master-password"
        />
      </Field>
    </>
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={<span data-testid="backup-export-title">Back up</span>}
      footer={
        <>
          {stepIndex === 0 ? (
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={() => goTo(steps[stepIndex - 1])}
              data-testid="backup-export-back"
            >
              Back
            </Button>
          )}
          {isLastStep ? (
            <Button
              key="save"
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
          ) : (
            <Button
              key="next"
              type="submit"
              form="backup-export-form"
              variant="primary"
              onClick={handleNext}
              disabled={sections === null}
              data-testid="backup-export-next"
            >
              Next
            </Button>
          )}
        </>
      }
    >
      <form id="backup-export-form" className="credential-vault__form">
        <p className="backup-export__step" data-testid="backup-export-step">
          {`Step ${stepIndex + 1} of ${steps.length} · ${BACKUP_EXPORT_STEP_NAMES[steps[stepIndex]]}`}
        </p>
        {step === "choose" && chooseStep}
        {step === "passphrase" && passphraseStep}
        {step === "masterPassword" && masterPasswordStep}
        {error && (
          <p className="credential-vault__error" role="alert" data-testid="backup-export-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
