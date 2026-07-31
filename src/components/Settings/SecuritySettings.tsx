import { useState, useCallback, useMemo } from "react";
import { Shield, Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { CredentialStorageMode } from "@/types/credential";
import { switchCredentialStore, changeMasterPassword, setAutoLockTimeout } from "@/services/api";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Button, Select, Toggle, toast } from "@/components/ui";
import { SettingsField } from "./SettingsField";

interface SecuritySettingsProps {
  visibleFields?: Set<string>;
}

interface StorageModeOption {
  value: CredentialStorageMode;
  label: string;
  badge?: string;
  description: string;
  testId: string;
}

const STORAGE_MODE_OPTIONS: StorageModeOption[] = [
  {
    value: "master_password",
    label: "Master Password",
    description:
      "Encrypt credentials with a master password. You'll need to enter it when the app starts or after a timeout.",
    testId: "storage-mode-master-password",
  },
  {
    value: "os_keychain",
    label: "OS Keychain",
    description:
      "Store credentials in the native OS credential store (macOS Keychain, Windows Credential Manager, or Linux Secret Service). The OS manages access — no master password needed.",
    testId: "storage-mode-os-keychain",
  },
  {
    value: "none",
    label: "None",
    description: "Don't store credentials. You'll be prompted for passwords each time you connect.",
    testId: "storage-mode-none",
  },
];

/** Human-readable label for a credential storage mode, used in dialog copy. */
function modeLabel(mode: CredentialStorageMode): string {
  return STORAGE_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode;
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
  const [migrationResult, setMigrationResult] = useState<{
    migratedCount: number;
    warnings: string[];
  } | null>(null);

  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [changeNewPassword, setChangeNewPassword] = useState("");
  const [changeConfirmPassword, setChangeConfirmPassword] = useState("");
  const [changePasswordError, setChangePasswordError] = useState("");

  const currentMode = credentialStoreStatus?.mode ?? "none";

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

    if (confirmSwitch === "master_password") {
      // Reject (rather than return) on invalid input so the submit Button's async
      // lifecycle returns to idle instead of flashing success; the inline
      // passwordError is the feedback.
      const validationError = !newPassword
        ? "Password is required."
        : newPassword !== confirmPassword
          ? "Passwords do not match."
          : newPassword.length < 8
            ? "Password must be at least 8 characters."
            : null;
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
      setMigrationResult(result);
      setConfirmSwitch(null);
      setMasterPasswordSetup(false);
      setNewPassword("");
      setConfirmPassword("");
      await loadCredentialStoreStatus();
      toast.success(
        result.migratedCount > 0
          ? `Switched to ${modeLabel(targetMode)} — ${result.migratedCount} credential${
              result.migratedCount !== 1 ? "s" : ""
            } migrated`
          : `Switched to ${modeLabel(targetMode)}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPasswordError(message);
      toast.error(`Failed to switch credential store: ${message}`);
      throw err; // keep the async Button in its error path (no success flash)
    } finally {
      setSwitching(false);
    }
  }, [confirmSwitch, newPassword, confirmPassword, loadCredentialStoreStatus]);

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
      setChangePasswordError(err instanceof Error ? err.message : String(err));
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
          <h3 className="settings-panel__section-title">Credential Storage</h3>
          <p className="settings-panel__description">
            Choose how connection passwords, SSH key passphrases, and other secrets are stored.
          </p>

          <div className="settings-panel__radio-group" role="radiogroup" aria-label="Storage mode">
            {STORAGE_MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={`settings-panel__radio-option${currentMode === option.value ? " settings-panel__radio-option--active" : ""}`}
                data-testid={option.testId}
                onClick={() => void handleModeSelect(option.value)}
                aria-pressed={currentMode === option.value}
                disabled={switching}
              >
                <div className="settings-panel__radio-option-label">
                  <Shield size={14} />
                  <span>{option.label}</span>
                  {option.badge && (
                    <span className="settings-panel__radio-option-badge">{option.badge}</span>
                  )}
                </div>
                <p className="settings-panel__radio-option-desc">{option.description}</p>
              </button>
            ))}
          </div>

          {masterPasswordSetup && confirmSwitch === "master_password" && (
            <form className="settings-panel__inline-dialog" data-testid="master-password-setup">
              <h4 className="settings-panel__inline-dialog-title">Set Master Password</h4>
              <p className="settings-panel__inline-dialog-text">
                Choose a strong password to encrypt your credentials.
              </p>
              <PasswordInput
                className="settings-panel__inline-dialog-input"
                placeholder="Master password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoFocus
                data-testid="master-password-input"
              />
              <PasswordInput
                className="settings-panel__inline-dialog-input"
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                data-testid="master-password-confirm-input"
              />
              {passwordError && (
                <p className="settings-panel__inline-dialog-error">{passwordError}</p>
              )}
              <div className="settings-panel__inline-dialog-actions">
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
                  Confirm
                </Button>
                <Button variant="secondary" size="sm" onClick={resetSwitchDialogs}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {confirmSwitch && confirmSwitch !== "master_password" && (
            <div className="settings-panel__inline-dialog" data-testid="confirm-switch-dialog">
              <h4 className="settings-panel__inline-dialog-title">
                Switch to {modeLabel(confirmSwitch)}?
              </h4>
              <p className="settings-panel__inline-dialog-text">
                {confirmSwitch === "none"
                  ? "This permanently deletes all saved credentials and cannot be undone. You'll be prompted for passwords each time you connect."
                  : "Existing credentials will be migrated to the OS credential store."}
              </p>
              {passwordError && (
                <p className="settings-panel__inline-dialog-error">{passwordError}</p>
              )}
              <div className="settings-panel__inline-dialog-actions">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleConfirmSwitch}
                  disabled={switching}
                  errorToast={false}
                  pendingLabel="Switching…"
                  data-testid="confirm-switch-confirm-btn"
                >
                  Confirm
                </Button>
                <Button variant="secondary" size="sm" onClick={resetSwitchDialogs}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {migrationResult && (
            <div className="settings-panel__migration-result" data-testid="migration-result">
              <p>
                Switched successfully. {migrationResult.migratedCount} credential
                {migrationResult.migratedCount !== 1 ? "s" : ""} migrated.
              </p>
              {migrationResult.warnings.length > 0 && (
                <ul className="settings-panel__migration-warnings">
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
              <h3 className="settings-panel__section-title">Master Password Options</h3>

              <SettingsField
                label="Auto-Lock Timeout"
                hint="Lock the credential store after a period of inactivity."
              >
                <Select
                  data-testid="auto-lock-timeout"
                  value={String(settings.credentialAutoLockMinutes ?? 15)}
                  onChange={(value) => handleAutoLockChange(Number(value))}
                  options={AUTO_LOCK_SELECT_OPTIONS}
                />
              </SettingsField>

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
                  Change Master Password
                </Button>
              </div>

              {changingPassword && (
                <form
                  className="settings-panel__inline-dialog"
                  data-testid="change-password-dialog"
                >
                  <h4 className="settings-panel__inline-dialog-title">Change Master Password</h4>
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
                    <Button variant="secondary" size="sm" onClick={resetChangePasswordDialog}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </div>
          )}
        </>
      )}

      {show("workflowLocalProcess") && (
        <div className="settings-panel__section">
          <h3 className="settings-panel__section-title">Workflow Local Process Execution</h3>
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
    </div>
  );
}
