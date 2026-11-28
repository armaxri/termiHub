import { useState, useCallback, useEffect, useMemo } from "react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import type { CredentialStorageMode } from "@/types/credential";
import {
  countSavedCredentials,
  switchCredentialStore,
  changeMasterPassword,
  setAutoLockTimeout,
} from "@/services/api";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Button, RadioGroup, Select, Toggle, toast } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import { PasswordBackupLink } from "./PasswordBackupLink";
import { SharedCredentialsSettings } from "./SharedCredentialsSettings";
import { BiometricUnlockSettings } from "./BiometricUnlockSettings";
import { AllowedPrograms } from "./AllowedPrograms";
import { ConfirmedCommands } from "./ConfirmedCommands";
import { ImportedWorkspaceConfirmations } from "./ImportedWorkspaceConfirmations";
import { MasterPasswordSetupFields } from "@/components/CredentialStorage/MasterPasswordSetupFields";
import { credentialStorageRadioOptions } from "@/components/CredentialStorage/credentialStorageOptions";
import { validateNewMasterPassword } from "@/utils/masterPasswordValidation";
import { errorMessage } from "@/utils/errorMessage";
import {
  needsSwitchConfirm,
  remainingTitle,
  switchConfirmCopy,
  switchProgressLabel,
  switchResultSummary,
  trustedSavedCount,
  SWITCH_RESULT_FADE_MS,
  SWITCH_RESULT_VISIBLE_MS,
  type SavedPasswordCount,
  type SwitchResultView,
} from "./credentialSwitchCopy";
import { EXPERIMENTAL_SETTING_PATH } from "@/utils/experimentalSetting";
import { LOCAL_PROGRAMS_SETTING_LABEL } from "@/utils/localProcessGate";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

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
 * How many passwords the current store holds, for the switch confirmation
 * (#5837). Unknown (`null`) when the count cannot be read.
 */
async function readSavedCount(from: CredentialStorageMode): Promise<SavedPasswordCount> {
  try {
    return trustedSavedCount(from, await countSavedCredentials());
  } catch {
    return null;
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
  const [migrationResult, setMigrationResult] = useState<SwitchResultView | null>(null);
  const [resultFading, setResultFading] = useState(false);
  /** Saved passwords in the current store, read when a switch starts (#5837). */
  const [savedCount, setSavedCount] = useState<SavedPasswordCount>(null);
  /** The mode being switched to: the cards show it at once while the switch runs (#5837). */
  const [pendingMode, setPendingMode] = useState<CredentialStorageMode | null>(null);
  /** A switch that needed no confirmation failed; shown under the cards. */
  const [directSwitchError, setDirectSwitchError] = useState("");

  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [changeNewPassword, setChangeNewPassword] = useState("");
  const [changeConfirmPassword, setChangeConfirmPassword] = useState("");
  const [changePasswordError, setChangePasswordError] = useState("");

  const currentMode = credentialStoreStatus?.mode ?? "none";
  const shownMode = pendingMode ?? currentMode;
  const switchCopy = confirmSwitch
    ? switchConfirmCopy(currentMode, confirmSwitch, savedCount)
    : null;
  const progressLabel = switchProgressLabel(currentMode, pendingMode ?? currentMode, savedCount);

  const show = (field: string): boolean => !visibleFields || visibleFields.has(field);

  const resetSwitchDialogs = useCallback(() => {
    setConfirmSwitch(null);
    setMasterPasswordSetup(false);
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError("");
    setDirectSwitchError("");
    setMigrationResult(null);
  }, []);

  // A clean success is news for a few seconds, then fades out (#5837). A
  // partial or failed switch stays until the next switch: it needs action.
  useEffect(() => {
    setResultFading(false);
    if (migrationResult?.status !== "success") return;
    const fade = window.setTimeout(() => setResultFading(true), SWITCH_RESULT_VISIBLE_MS);
    const clear = window.setTimeout(
      () => setMigrationResult(null),
      SWITCH_RESULT_VISIBLE_MS + SWITCH_RESULT_FADE_MS
    );
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(clear);
    };
  }, [migrationResult]);

  const resetChangePasswordDialog = useCallback(() => {
    setChangingPassword(false);
    setCurrentPasswordInput("");
    setChangeNewPassword("");
    setChangeConfirmPassword("");
    setChangePasswordError("");
  }, []);

  /**
   * Runs the switch to `targetMode`. The cards show the target at once and a
   * progress line says what is happening (#5837); a failure puts the cards
   * back on the current mode and rethrows for the caller to show.
   */
  const runSwitch = useCallback(
    async (targetMode: CredentialStorageMode, masterPassword?: string) => {
      const previousMode = currentMode;
      setSwitching(true);
      setPendingMode(targetMode);
      setPasswordError("");
      setDirectSwitchError("");
      setMigrationResult(null);
      try {
        const result = await switchCredentialStore(targetMode, masterPassword);
        setMigrationResult({ ...result, targetMode, previousMode });
        setConfirmSwitch(null);
        setMasterPasswordSetup(false);
        setNewPassword("");
        setConfirmPassword("");
        await loadCredentialStoreStatus();
        // The outcome is confirmed once, by the inline result banner
        // (status/alert role by outcome) — never a toast on top of it (#5629).
      } finally {
        setPendingMode(null);
        setSwitching(false);
      }
    },
    [currentMode, loadCredentialStoreStatus]
  );

  /**
   * Begins a storage-mode switch. Switching *away* from an existing master-password
   * store touches encrypted data (it must be decrypted to migrate/discard), so when
   * that store is locked this routes through the shared unlock flow first — the same
   * gate the change-password flow uses (audit G4).
   *
   * A switch that moves or deletes saved passwords asks first, naming how many and
   * from where (#5837); one with nothing saved switches at once. A master password
   * always shows its setup form.
   */
  const handleModeSelect = useCallback(
    async (mode: CredentialStorageMode) => {
      if (mode === currentMode || switching) return;
      if (
        currentMode === "master_password" &&
        mode !== "master_password" &&
        credentialStoreStatus?.status === "locked"
      ) {
        const unlocked = await requestUnlock();
        if (!unlocked) return;
      }
      resetSwitchDialogs();
      // Nothing is stored without storage, so the count needs no backend
      // call there and the setup form opens in the same tick.
      const count = currentMode === "none" ? 0 : await readSavedCount(currentMode);
      setSavedCount(count);
      if (mode === "master_password") {
        setMasterPasswordSetup(true);
        setConfirmSwitch(mode);
        return;
      }
      if (needsSwitchConfirm(currentMode, mode, count)) {
        setConfirmSwitch(mode);
        return;
      }
      try {
        await runSwitch(mode);
      } catch (err) {
        setDirectSwitchError(errorMessage(err));
      }
    },
    [
      currentMode,
      switching,
      credentialStoreStatus?.status,
      requestUnlock,
      resetSwitchDialogs,
      runSwitch,
    ]
  );

  const handleConfirmSwitch = useCallback(async () => {
    if (!confirmSwitch) return;
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
    try {
      await runSwitch(confirmSwitch, confirmSwitch === "master_password" ? newPassword : undefined);
    } catch (err) {
      // Shown inline in the still-open confirmation; no toast on top (#5629).
      setPasswordError(errorMessage(err));
      throw err; // keep the async Button in its error path (no success flash)
    }
  }, [confirmSwitch, newPassword, confirmPassword, runSwitch]);

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
      // toast-policy: no-in-place-surface — a changed password has no on-screen state
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
    },
    [settings, updateSettings]
  );

  const handleRemoveAllowedProgram = useCallback(
    (program: string) => {
      const next = localProcessAllowlist.filter((p) => p !== program);
      void updateSettings({ ...settings, workflowLocalProcessAllowlist: next });
    },
    [settings, updateSettings, localProcessAllowlist]
  );

  return (
    <div className="settings-panel__category">
      {show("credentialStorageMode") && (
        <div className="settings-panel__section">
          <SettingsSectionHeading data-testid="security-credential-storage-title">
            Credential storage
          </SettingsSectionHeading>
          <p className="settings-panel__description">
            Choose how connection passwords, SSH key passphrases, and other secrets are stored.
          </p>

          <RadioGroup
            variant="cards"
            className="settings-panel__radio-group"
            value={shownMode}
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
                  pendingLabel={progressLabel}
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
                  pendingLabel={progressLabel}
                  data-testid="confirm-switch-confirm-btn"
                >
                  {switchCopy?.action}
                </Button>
              </div>
            </div>
          )}

          {switching && !confirmSwitch && (
            <p
              className="settings-panel__description"
              role="status"
              data-testid="storage-switch-progress"
            >
              {progressLabel}
            </p>
          )}

          {directSwitchError && (
            <p
              className="settings-panel__inline-dialog-error"
              role="alert"
              data-testid="storage-switch-error"
            >
              {directSwitchError}
            </p>
          )}

          {migrationResult && (
            <div
              className={`settings-panel__migration-result settings-panel__migration-result--${migrationResult.status}${resultFading ? " settings-panel__migration-result--fading" : ""}`}
              data-testid="migration-result"
              data-status={migrationResult.status}
              role={migrationResult.status === "success" ? "status" : "alert"}
            >
              <p>{switchResultSummary(migrationResult)}</p>
              {migrationResult.remaining.length > 0 && (
                <>
                  <p>{remainingTitle(migrationResult.previousMode)}</p>
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

      {shownMode === "master_password" && currentMode === "master_password" && (
        <>
          {show("credentialAutoLockMinutes") && (
            <div className="settings-panel__section">
              <SettingsSectionHeading>Master password options</SettingsSectionHeading>

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

      {show("credentialVaultBackup") && <PasswordBackupLink />}

      {show("workflowLocalProcess") && (
        <div className="settings-panel__section">
          <SettingsSectionHeading>Local programs run by automations</SettingsSectionHeading>
          <p className="settings-panel__description">
            The “Run local process” step of an automation runs a program on this computer. This is
            off by default. When enabled, each not-yet-trusted program still requires a one-time
            confirmation before it can run; imported automations are never pre-authorized.
          </p>

          <SettingsField
            label={LOCAL_PROGRAMS_SETTING_LABEL}
            hint={`Master switch. While off, any “Run local process” step is refused. The step is experimental: ${EXPERIMENTAL_SETTING_PATH} must be on too.`}
          >
            <Toggle
              checked={localProcessEnabled}
              onCheckedChange={handleToggleLocalProcess}
              aria-label={LOCAL_PROGRAMS_SETTING_LABEL}
              data-testid="workflow-local-process-toggle"
            />
          </SettingsField>

          {localProcessEnabled && (
            <AllowedPrograms
              programs={localProcessAllowlist}
              onRemove={handleRemoveAllowedProgram}
            />
          )}
          <ConfirmedCommands />
        </div>
      )}

      {show("workspaceImportConfirmations") && <ImportedWorkspaceConfirmations />}
    </div>
  );
}
