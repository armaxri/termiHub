import { useState, useEffect, useCallback } from "react";
import { CheckCircle2, AlertTriangle, Shield } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { CredentialStorageMode } from "@/types/credential";
import {
  switchCredentialStore,
  setupMasterPassword,
  changeMasterPassword,
  checkKeychainAvailable,
  setAutoLockTimeout,
} from "@/services/api";

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
    value: "keychain",
    label: "OS Keychain",
    badge: "Recommended",
    description:
      "Store credentials in the operating system's native keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service).",
    testId: "storage-mode-keychain",
  },
  {
    value: "master_password",
    label: "Master Password",
    description:
      "Encrypt credentials with a master password. You'll need to enter it when the app starts or after a timeout.",
    testId: "storage-mode-master-password",
  },
  {
    value: "none",
    label: "None",
    description: "Don't store credentials. You'll be prompted for passwords each time you connect.",
    testId: "storage-mode-none",
  },
];

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

/**
 * Security settings panel for credential storage configuration.
 */
export function SecuritySettings({ visibleFields }: SecuritySettingsProps) {
  const credentialStoreStatus = useAppStore((s) => s.credentialStoreStatus);
  const loadCredentialStoreStatus = useAppStore((s) => s.loadCredentialStoreStatus);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [keychainAvailable, setKeychainAvailable] = useState<boolean | null>(null);
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

  useEffect(() => {
    checkKeychainAvailable()
      .then(setKeychainAvailable)
      .catch(() => setKeychainAvailable(false));
  }, []);

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

  const handleModeSelect = useCallback(
    (mode: CredentialStorageMode) => {
      if (mode === currentMode) return;
      resetSwitchDialogs();
      if (mode === "master_password") {
        setMasterPasswordSetup(true);
        setConfirmSwitch(mode);
      } else {
        setConfirmSwitch(mode);
      }
    },
    [currentMode, resetSwitchDialogs]
  );

  const handleConfirmSwitch = useCallback(async () => {
    if (!confirmSwitch) return;

    if (confirmSwitch === "master_password") {
      if (!newPassword) {
        setPasswordError("Password is required.");
        return;
      }
      if (newPassword !== confirmPassword) {
        setPasswordError("Passwords do not match.");
        return;
      }
      if (newPassword.length < 8) {
        setPasswordError("Password must be at least 8 characters.");
        return;
      }
    }

    setSwitching(true);
    setPasswordError("");
    try {
      if (confirmSwitch === "master_password") {
        await setupMasterPassword(newPassword);
      }
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
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  }, [confirmSwitch, newPassword, confirmPassword, loadCredentialStoreStatus]);

  const handleChangePassword = useCallback(async () => {
    if (!currentPasswordInput) {
      setChangePasswordError("Current password is required.");
      return;
    }
    if (!changeNewPassword) {
      setChangePasswordError("New password is required.");
      return;
    }
    if (changeNewPassword !== changeConfirmPassword) {
      setChangePasswordError("Passwords do not match.");
      return;
    }
    if (changeNewPassword.length < 8) {
      setChangePasswordError("Password must be at least 8 characters.");
      return;
    }

    try {
      await changeMasterPassword(currentPasswordInput, changeNewPassword);
      resetChangePasswordDialog();
    } catch (err) {
      setChangePasswordError(err instanceof Error ? err.message : String(err));
    }
  }, [currentPasswordInput, changeNewPassword, changeConfirmPassword, resetChangePasswordDialog]);

  const handleAutoLockChange = useCallback(
    (value: number) => {
      updateSettings({ ...settings, credentialAutoLockMinutes: value });
      setAutoLockTimeout(value === 0 ? null : value);
    },
    [settings, updateSettings]
  );

  return (
    <div className="settings-panel__category">
      {show("credentialStorageMode") && (
        <div className="settings-panel__section">
          <h3 className="settings-panel__section-title">Credential Storage</h3>
          <p className="settings-panel__description">
            Choose how connection passwords, SSH key passphrases, and other secrets are stored.
          </p>

          <div className="settings-panel__status-indicator" data-testid="keychain-status">
            {keychainAvailable === null ? (
              <span className="settings-panel__status-indicator--checking">
                Checking keychain availability…
              </span>
            ) : keychainAvailable ? (
              <>
                <CheckCircle2 size={14} />
                <span className="settings-panel__status-indicator--ok">
                  OS Keychain is available
                </span>
              </>
            ) : (
              <>
                <AlertTriangle size={14} />
                <span className="settings-panel__status-indicator--warning">
                  OS Keychain is not available on this system
                </span>
              </>
            )}
          </div>

          <div className="settings-panel__radio-group" role="radiogroup" aria-label="Storage mode">
            {STORAGE_MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={`settings-panel__radio-option${currentMode === option.value ? " settings-panel__radio-option--active" : ""}`}
                data-testid={option.testId}
                onClick={() => handleModeSelect(option.value)}
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
            <div className="settings-panel__inline-dialog" data-testid="master-password-setup">
              <h4 className="settings-panel__inline-dialog-title">Set Master Password</h4>
              <p className="settings-panel__inline-dialog-text">
                Choose a strong password to encrypt your credentials.
              </p>
              <input
                className="settings-panel__inline-dialog-input"
                type="password"
                placeholder="Master password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoFocus
              />
              <input
                className="settings-panel__inline-dialog-input"
                type="password"
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleConfirmSwitch();
                }}
              />
              {passwordError && (
                <p className="settings-panel__inline-dialog-error">{passwordError}</p>
              )}
              <div className="settings-panel__inline-dialog-actions">
                <button
                  className="settings-panel__btn settings-panel__btn--primary"
                  onClick={handleConfirmSwitch}
                  disabled={switching}
                >
                  {switching ? "Switching…" : "Confirm"}
                </button>
                <button className="settings-panel__btn" onClick={resetSwitchDialogs}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {confirmSwitch && confirmSwitch !== "master_password" && (
            <div className="settings-panel__inline-dialog" data-testid="confirm-switch-dialog">
              <h4 className="settings-panel__inline-dialog-title">
                Switch to {confirmSwitch === "keychain" ? "OS Keychain" : "No Storage"}?
              </h4>
              <p className="settings-panel__inline-dialog-text">
                Existing credentials will be migrated to the new storage backend.
              </p>
              {passwordError && (
                <p className="settings-panel__inline-dialog-error">{passwordError}</p>
              )}
              <div className="settings-panel__inline-dialog-actions">
                <button
                  className="settings-panel__btn settings-panel__btn--primary"
                  onClick={handleConfirmSwitch}
                  disabled={switching}
                >
                  {switching ? "Switching…" : "Confirm"}
                </button>
                <button className="settings-panel__btn" onClick={resetSwitchDialogs}>
                  Cancel
                </button>
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

              <div className="settings-panel__field">
                <label className="settings-panel__description" htmlFor="auto-lock-timeout">
                  Lock the credential store after a period of inactivity:
                </label>
                <select
                  id="auto-lock-timeout"
                  className="settings-panel__inline-dialog-input"
                  data-testid="auto-lock-timeout"
                  value={settings.credentialAutoLockMinutes ?? 15}
                  onChange={(e) => handleAutoLockChange(Number(e.target.value))}
                >
                  {AUTO_LOCK_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="settings-panel__field">
                <button
                  className="settings-panel__btn"
                  data-testid="change-master-password-btn"
                  onClick={() => setChangingPassword(true)}
                >
                  Change Master Password
                </button>
              </div>

              {changingPassword && (
                <div className="settings-panel__inline-dialog" data-testid="change-password-dialog">
                  <h4 className="settings-panel__inline-dialog-title">Change Master Password</h4>
                  <input
                    className="settings-panel__inline-dialog-input"
                    type="password"
                    placeholder="Current password"
                    value={currentPasswordInput}
                    onChange={(e) => setCurrentPasswordInput(e.target.value)}
                    autoFocus
                  />
                  <input
                    className="settings-panel__inline-dialog-input"
                    type="password"
                    placeholder="New password"
                    value={changeNewPassword}
                    onChange={(e) => setChangeNewPassword(e.target.value)}
                  />
                  <input
                    className="settings-panel__inline-dialog-input"
                    type="password"
                    placeholder="Confirm new password"
                    value={changeConfirmPassword}
                    onChange={(e) => setChangeConfirmPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleChangePassword();
                    }}
                  />
                  {changePasswordError && (
                    <p className="settings-panel__inline-dialog-error">{changePasswordError}</p>
                  )}
                  <div className="settings-panel__inline-dialog-actions">
                    <button
                      className="settings-panel__btn settings-panel__btn--primary"
                      onClick={handleChangePassword}
                    >
                      Change
                    </button>
                    <button className="settings-panel__btn" onClick={resetChangePasswordDialog}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
