import { useState, useCallback, useMemo } from "react";
import { Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import type { CredentialStorageMode, SwitchCredentialStoreResult } from "@/types/credential";
import { switchCredentialStore, changeMasterPassword, setAutoLockTimeout } from "@/services/api";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Button, RadioGroup, Select, Toggle, toast } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import { CredentialVaultBackup } from "./CredentialVaultBackup";
import { SharedCredentialsSettings } from "./SharedCredentialsSettings";
import { BiometricUnlockSettings } from "./BiometricUnlockSettings";
import { ImportedWorkspaceConfirmations } from "./ImportedWorkspaceConfirmations";
import { MasterPasswordSetupFields } from "@/components/CredentialStorage/MasterPasswordSetupFields";
import { credentialStorageRadioOptions } from "@/components/CredentialStorage/credentialStorageOptions";
import { validateNewMasterPassword } from "@/utils/masterPasswordValidation";
import { errorMessage } from "@/utils/errorMessage";
import { tf } from "@/i18n/catalog";
import { switchConfirmCopy } from "./credentialSwitchCopy";

interface SecuritySettingsProps {
  visibleFields?: Set<string>;
}

/**
 * Settings ▸ Security test id of each storage-mode card. The cards themselves
 * (order, names, descriptions, badge) come from the shared option list the
 * first-use chooser renders too (#5553).
 */
const STORAGE_MODE_TEST_IDS: { mode: CredentialStorageMode; testId: string }[] = [
  { mode: "os_keychain", testId: "storage-mode-os-keychain" },
  { mode: "master_password", testId: "storage-mode-master-password" },
  { mode: "none", testId: "storage-mode-none" },
];

function storageModeTestId(mode: CredentialStorageMode): string {
  return STORAGE_MODE_TEST_IDS.find((o) => o.mode === mode)?.testId ?? mode;
}

/**
 * Short name of a storage mode for sentences in the switch dialogs and
 * migration messages ("Switch to None?"), where the option label would not read.
 */
const STORAGE_MODE_NAMES: Record<CredentialStorageMode, string> = {
  os_keychain: "OS Keychain",
  master_password: "Master password",
  none: "None",
};

/** Human-readable label for a credential storage mode, used in dialog copy. */
function modeLabel(mode: CredentialStorageMode): string {
  return STORAGE_MODE_NAMES[mode] ?? mode;
}

/** Pluralize "credential" for a count. */
function credentials(count: number): string {
  return tf(count === 1 ? "credentialSwitch.count.one" : "credentialSwitch.count.other", {
    count,
  });
}

/** A completed switch plus the modes involved, for truthful result messaging. */
interface MigrationResultView extends SwitchCredentialStoreResult {
  targetMode: CredentialStorageMode;
  targetLabel: string;
  previousLabel: string;
}

/**
 * Human-readable summary of a completed store switch, driven by the backend's
 * structured `status` (#2839) — never inferred from the free-text warnings. A
 * partial or failed migration must not read as a clean success. A failed switch
 * was rolled back, so it reads "nothing changed"; a switch to `none` removes the
 * credentials, so it says "removed", never "migrated" (#3323).
 */
function migrationSummary(view: MigrationResultView): string {
  const { status, migratedCount, removedCount, failedCount, targetLabel, previousLabel } = view;
  const target = targetLabel;
  const previous = previousLabel;
  const removing = view.targetMode === "none";
  const done = removing ? removedCount : migratedCount;
  const total = done + failedCount;
  switch (status) {
    case "partial":
      return removing
        ? tf("credentialSwitch.removed.partial", {
            target,
            previous,
            removed: removedCount,
            total,
            failed: credentials(failedCount),
          })
        : tf("credentialSwitch.migrated.partial", {
            target,
            previous,
            migrated: migratedCount,
            total,
            failed: credentials(failedCount),
          });
    case "failed":
      return tf(removing ? "credentialSwitch.removed.failed" : "credentialSwitch.migrated.failed", {
        target,
        previous,
        credentials: credentials(failedCount),
      });
    case "success":
    default:
      if (done === 0) return tf("credentialSwitch.switched", { target });
      return tf(
        removing ? "credentialSwitch.removed.success" : "credentialSwitch.migrated.success",
        { target, credentials: credentials(done) }
      );
  }
}

interface AutoLockOption {
  value: number;
  label: string;
}

const AUTO_LOCK_OPTIONS: AutoLockOption[] = [
  { value: 0, label: "Never" },
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
];

/** Auto-lock options as string-valued Select options, hoisted so they are not rebuilt each render. */
const AUTO_LOCK_SELECT_OPTIONS = AUTO_LOCK_OPTIONS.map((opt) => ({
  value: String(opt.value),
  label: opt.label,
}));

/**
 * Security settings panel for credential storage configuration.
 */
export function SecuritySettings({ visibleFields }: SecuritySettingsProps) {
  const credentialStoreStatus = useAppStore((s) => s.credentialStoreStatus);
  const loadCredentialStoreStatus = useAppStore((s) => s.loadCredentialStoreStatus);
  const requestUnlock = useAppStore((s) => s.requestUnlock);
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [switching, setSwitching] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState<CredentialStorageMode | null>(null);
  const [masterPasswordSetup, setMasterPasswordSetup] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [migrationResult, setMigrationResult] = useState<MigrationResultView | null>(null);

  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [changeNewPassword, setChangeNewPassword] = useState("");
  const [changeConfirmPassword, setChangeConfirmPassword] = useState("");
  const [changePasswordError, setChangePasswordError] = useState("");

  const currentMode = credentialStoreStatus?.mode ?? "none";
  const switchCopy = confirmSwitch ? switchConfirmCopy(currentMode, confirmSwitch) : null;

  const show = (field: string): boolean => !visibleFields || visibleFields.has(field);

  const resetSwitchDialogs = useCallback(() => {
    setConfirmSwitch(null);
    setMasterPasswordSetup(false);
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError("");
    setMigrationResult(null);
  }, []);

  const resetChangePasswordDialog = useCallback(() => {
    setChangingPassword(false);
    setCurrentPasswordInput("");
    setChangeNewPassword("");
    setChangeConfirmPassword("");
    setChangePasswordError("");
  }, []);

  /**
   * Begins a storage-mode switch. Switching *away* from an existing master-password
   * store touches encrypted data (it must be decrypted to migrate/discard), so when
   * that store is locked this routes through the shared unlock flow first — the same
   * gate the change-password flow uses (audit G4) — and only opens the confirm once
   * the unlock succeeds. Without this gate the destructive switch would proceed against
   * a locked store with no password check.
   */
  const handleModeSelect = useCallback(
    async (mode: CredentialStorageMode) => {
      if (mode === currentMode) return;
      if (
        currentMode === "master_password" &&
        mode !== "master_password" &&
        credentialStoreStatus?.status === "locked"
      ) {
        const unlocked = await requestUnlock();
        if (!unlocked) return;
      }
      resetSwitchDialogs();
      if (mode === "master_password") {
        setMasterPasswordSetup(true);
        setConfirmSwitch(mode);
      } else {
        setConfirmSwitch(mode);
      }
    },
    [currentMode, credentialStoreStatus?.status, requestUnlock, resetSwitchDialogs]
  );

  const handleConfirmSwitch = useCallback(async () => {
    if (!confirmSwitch) return;
    const targetMode = confirmSwitch;
    const previousMode = currentMode;

    if (confirmSwitch === "master_password") {
      // Reject (rather than return) on invalid input so the submit Button's async
      // lifecycle returns to idle instead of flashing success; the inline
      // passwordError is the feedback.
      const validationError = validateNewMasterPassword(newPassword, confirmPassword);
      if (validationError) {
        setPasswordError(validationError);
        throw new Error(validationError);
      }
    }

    setSwitching(true);
    setPasswordError("");
    try {
      const result = await switchCredentialStore(
        confirmSwitch,
        confirmSwitch === "master_password" ? newPassword : undefined
      );
      const view: MigrationResultView = {
        ...result,
        targetMode,
        targetLabel: modeLabel(targetMode),
        previousLabel: modeLabel(previousMode),
      };
      setMigrationResult(view);
      setConfirmSwitch(null);
      setMasterPasswordSetup(false);
      setNewPassword("");
      setConfirmPassword("");
      await loadCredentialStoreStatus();
      // The outcome is confirmed once, by the inline migration-result banner
      // (status/alert role by outcome) — never a toast on top of it (#5629).
    } catch (err) {
      // Shown inline in the still-open confirmation; no toast on top (#5629).
      setPasswordError(errorMessage(err));
      throw err; // keep the async Button in its error path (no success flash)
    } finally {
      setSwitching(false);
    }
  }, [confirmSwitch, currentMode, newPassword, confirmPassword, loadCredentialStoreStatus]);

  const handleChangePassword = useCallback(async () => {
    // Reject (rather than return) on invalid input so the submit Button's async
    // lifecycle returns to idle instead of flashing success; the wrong-password /
    // validation feedback stays inline (no toast).
    const validationError = !currentPasswordInput
      ? "Current password is required."
      : !changeNewPassword
        ? "New password is required."
        : changeNewPassword !== changeConfirmPassword
          ? "Passwords do not match."
          : changeNewPassword.length < 8
            ? "Password must be at least 8 characters."
            : null;
    if (validationError) {
      setChangePasswordError(validationError);
      throw new Error(validationError);
    }

    try {
      await changeMasterPassword(currentPasswordInput, changeNewPassword);
      resetChangePasswordDialog();
      toast.success("Master password changed");
    } catch (err) {
      setChangePasswordError(errorMessage(err));
      throw err; // keep the async Button in its error path (inline error, no toast)
    }
  }, [currentPasswordInput, changeNewPassword, changeConfirmPassword, resetChangePasswordDialog]);

  /**
   * Opens the change-master-password dialog. changeMasterPassword requires an unlocked
   * store, so when the store is locked this routes through the shared unlock flow first
   * (matching the connect-flow gate) and only opens the dialog once the unlock succeeds —
   * avoiding the dead-end where submitting yields a raw "Store is locked" error with no
   * unlock affordance (audit GAP G4).
   */
  const handleOpenChangePassword = useCallback(async () => {
    if (credentialStoreStatus?.status === "locked") {
      const unlocked = await requestUnlock();
      if (!unlocked) return;
    }
    setChangingPassword(true);
  }, [credentialStoreStatus?.status, requestUnlock]);

  const handleAutoLockChange = useCallback(
    (value: number) => {
      updateSettings({ ...settings, credentialAutoLockMinutes: value });
      setAutoLockTimeout(value === 0 ? null : value);
    },
    [settings, updateSettings]
  );

  const localProcessEnabled = settings.workflowLocalProcessEnabled ?? false;
  const localProcessAllowlist = useMemo(
    () => settings.workflowLocalProcessAllowlist ?? [],
    [settings.workflowLocalProcessAllowlist]
  );

  const handleToggleLocalProcess = useCallback(
    (enabled: boolean) => {
      void updateSettings({ ...settings, workflowLocalProcessEnabled: enabled });
      toast.success(
        enabled
          ? "Workflow local process execution enabled"
          : "Workflow local process execution disabled"
      );
    },
    [settings, updateSettings]
  );

  const handleRemoveAllowedProgram = useCallback(
    (program: string) => {
      const next = localProcessAllowlist.filter((p) => p !== program);
      void updateSettings({ ...settings, workflowLocalProcessAllowlist: next });
      toast.success(`Removed ${program} from the allowlist`);
    },
    [settings, updateSettings, localProcessAllowlist]
  );

  return (
    <div className="settings-panel__category">
      {show("credentialStorageMode") && (
        <div className="settings-panel__section">
          <h3
            className="settings-panel__section-title"
            data-testid="security-credential-storage-title"
          >
            Credential storage
          </h3>
          <p className="settings-panel__description">
            Choose how connection passwords, SSH key passphrases, and other secrets are stored.
          </p>

          <RadioGroup
            variant="cards"
            className="settings-panel__radio-group"
            value={currentMode}
            onValueChange={(v) => void handleModeSelect(v as CredentialStorageMode)}
            disabled={switching}
            aria-label="Storage mode"
            data-testid="storage-mode-group"
            options={credentialStorageRadioOptions(storageModeTestId)}
          />

          {masterPasswordSetup && confirmSwitch === "master_password" && (
            <form className="settings-panel__inline-dialog" data-testid="master-password-setup">
              <h4 className="settings-panel__inline-dialog-title">{switchCopy?.title}</h4>
              <p className="settings-panel__inline-dialog-text">{switchCopy?.text}</p>
              <MasterPasswordSetupFields
                password={newPassword}
                confirm={confirmPassword}
                onPasswordChange={setNewPassword}
                onConfirmChange={setConfirmPassword}
                error={passwordError}
                inputClassName="settings-panel__inline-dialog-input"
                errorClassName="settings-panel__inline-dialog-error"
              />
              <div className="settings-panel__inline-dialog-actions">
                <Button variant="secondary" size="sm" onClick={resetSwitchDialogs}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={switching}
                  onClick={handleConfirmSwitch}
                  errorToast={false}
                  pendingLabel="Switching…"
                  data-testid="master-password-confirm-btn"
                >
                  {switchCopy?.action}
                </Button>
              </div>
            </form>
          )}

          {confirmSwitch && confirmSwitch !== "master_password" && (
            <div className="settings-panel__inline-dialog" data-testid="confirm-switch-dialog">
              <h4 className="settings-panel__inline-dialog-title">{switchCopy?.title}</h4>
              <p className="settings-panel__inline-dialog-text">{switchCopy?.text}</p>
              {passwordError && (
                <p className="settings-panel__inline-dialog-error">{passwordError}</p>
              )}
              <div className="settings-panel__inline-dialog-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={resetSwitchDialogs}
                  data-testid="confirm-switch-cancel-btn"
                >
                  Cancel
                </Button>
                <Button
                  variant={switchCopy?.destructive ? "danger" : "primary"}
                  size="sm"
                  onClick={handleConfirmSwitch}
                  disabled={switching}
                  errorToast={false}
                  pendingLabel="Switching…"
                  data-testid="confirm-switch-confirm-btn"
                >
                  {switchCopy?.action}
                </Button>
              </div>
            </div>
          )}

          {migrationResult && (
            <div
              className={`settings-panel__migration-result settings-panel__migration-result--${migrationResult.status}`}
              data-testid="migration-result"
              data-status={migrationResult.status}
              role={migrationResult.status === "success" ? "status" : "alert"}
            >
              <p>{migrationSummary(migrationResult)}</p>
              {migrationResult.remaining.length > 0 && (
                <>
                  <p>
                    {tf("credentialSwitch.remaining.title", {
                      previous: migrationResult.previousLabel,
                    })}
                  </p>
                  <ul
                    className="settings-panel__migration-warnings"
                    data-testid="migration-remaining"
                  >
                    {migrationResult.remaining.map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                </>
              )}
              {migrationResult.remaining.length === 0 && migrationResult.warnings.length > 0 && (
                <ul className="settings-panel__migration-warnings" data-testid="migration-warnings">
                  {migrationResult.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {currentMode === "master_password" && (
        <>
          {show("credentialAutoLockMinutes") && (
            <div className="settings-panel__section">
              <h3 className="settings-panel__section-title">Master password options</h3>

              <SettingsField
                label="Auto-lock timeout"
                hint="Lock the credential store after a period of inactivity."
              >
                <Select
                  data-testid="auto-lock-timeout"
                  value={String(settings.credentialAutoLockMinutes ?? 15)}
                  onChange={(value) => handleAutoLockChange(Number(value))}
                  options={AUTO_LOCK_SELECT_OPTIONS}
                />
              </SettingsField>

              <BiometricUnlockSettings />

              <div className="settings-panel__field">
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="change-master-password-btn"
                  onClick={handleOpenChangePassword}
                  title={
                    credentialStoreStatus?.status === "locked"
                      ? "The credential store is locked — you'll be asked to unlock it first."
                      : undefined
                  }
                >
                  Change master password
                </Button>
              </div>

              {changingPassword && (
                <form
                  className="settings-panel__inline-dialog"
                  data-testid="change-password-dialog"
                >
                  <h4 className="settings-panel__inline-dialog-title">Change master password</h4>
                  <PasswordInput
                    className="settings-panel__inline-dialog-input"
                    placeholder="Current password"
                    value={currentPasswordInput}
                    onChange={(e) => setCurrentPasswordInput(e.target.value)}
                    autoFocus
                    data-testid="change-master-password-current"
                  />
                  <PasswordInput
                    className="settings-panel__inline-dialog-input"
                    placeholder="New password"
                    value={changeNewPassword}
                    onChange={(e) => setChangeNewPassword(e.target.value)}
                    data-testid="change-master-password-new"
                  />
                  <PasswordInput
                    className="settings-panel__inline-dialog-input"
                    placeholder="Confirm new password"
                    value={changeConfirmPassword}
                    onChange={(e) => setChangeConfirmPassword(e.target.value)}
                    data-testid="change-master-password-confirm"
                  />
                  {changePasswordError && (
                    <p className="settings-panel__inline-dialog-error">{changePasswordError}</p>
                  )}
                  <div className="settings-panel__inline-dialog-actions">
                    <Button variant="secondary" size="sm" onClick={resetChangePasswordDialog}>
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      onClick={handleChangePassword}
                      errorToast={false}
                      pendingLabel="Changing…"
                      data-testid="change-master-password-confirm-btn"
                    >
                      Change
                    </Button>
                  </div>
                </form>
              )}
            </div>
          )}
        </>
      )}

      {show("sharedCredentials") && <SharedCredentialsSettings />}

      {show("credentialVaultBackup") && (
        <CredentialVaultBackup modeLabel={modeLabel(currentMode)} />
      )}

      {show("workflowLocalProcess") && (
        <div className="settings-panel__section">
          <h3 className="settings-panel__section-title">Workflow local process execution</h3>
          <p className="settings-panel__description">
            The guarded <code>run-local-process</code> workflow step runs a program on this
            computer. This is off by default. When enabled, each not-yet-trusted program still
            requires a one-time confirmation before it can run; imported workflows are never
            pre-authorized.
          </p>

          <SettingsField
            label="Allow workflows to run local programs"
            hint="Master switch. While off, any run-local-process step is refused."
          >
            <Toggle
              checked={localProcessEnabled}
              onCheckedChange={handleToggleLocalProcess}
              aria-label="Allow workflows to run local programs"
              data-testid="workflow-local-process-toggle"
            />
          </SettingsField>

          {localProcessEnabled && (
            <div className="settings-panel__field">
              <span className="settings-panel__field-label">Allowed programs</span>
              {localProcessAllowlist.length === 0 ? (
                <p className="settings-panel__description" data-testid="workflow-allowlist-empty">
                  No programs are remembered yet. Choosing &ldquo;Always allow&rdquo; when a
                  workflow runs one adds it here.
                </p>
              ) : (
                <ul className="settings-panel__list" data-testid="workflow-allowlist">
                  {localProcessAllowlist.map((program) => (
                    <li key={program} className="settings-panel__list-item">
                      <code>{program}</code>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon={<Trash2 size={14} />}
                        aria-label={`Remove ${program} from the allowlist`}
                        onClick={() => handleRemoveAllowedProgram(program)}
                        data-testid={`workflow-allowlist-remove-${program}`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {show("workspaceImportConfirmations") && <ImportedWorkspaceConfirmations />}
    </div>
  );
}
