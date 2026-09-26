import { useState, useCallback, useEffect } from "react";
import { Fingerprint } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useOsAuthInfo } from "@/hooks/useOsAuthInfo";
import {
  disableBiometricUnlock,
  enableBiometricUnlock,
  isBiometricUnlockError,
} from "@/services/api";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Button, Toggle, toast } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import { errorMessage } from "@/utils/errorMessage";

/** User-facing message for a failed enable attempt. */
export function enableErrorMessage(err: unknown, methodLabel: string): string {
  if (!isBiometricUnlockError(err)) return errorMessage(err);
  switch (err.kind) {
    case "cancelled":
      return `${methodLabel} was cancelled — unlock with ${methodLabel} was not turned on.`;
    case "wrongMasterPassword":
      return "The master password is incorrect.";
    default:
      return err.message;
  }
}

/**
 * Settings → Security → "Unlock with Touch ID / Windows Hello" (PROD-064).
 *
 * Only rendered where the OS supports biometric verification. Turning it on
 * needs the master password **and** a successful OS verification; turning it
 * off deletes the stored key. The master password always keeps working.
 */
export function BiometricUnlockSettings() {
  const status = useAppStore((s) => s.credentialStoreStatus?.status);
  const requestUnlock = useAppStore((s) => s.requestUnlock);
  const { info, refresh } = useOsAuthInfo();
  const [enabling, setEnabling] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const biometric = info?.biometricUnlock;
  const label = biometric?.methodLabel ?? "biometrics";

  // Never keep the master password around once the form closes.
  useEffect(() => {
    if (!enabling) setPassword("");
  }, [enabling]);

  const handleToggle = useCallback(
    async (on: boolean) => {
      setError("");
      if (on) {
        if (status === "locked" && !(await requestUnlock())) return;
        setEnabling(true);
        return;
      }
      setEnabling(false);
      try {
        await disableBiometricUnlock();
        toast.success(`Unlock with ${label} turned off`);
      } catch (err) {
        toast.error(`Could not turn off unlock with ${label}: ${errorMessage(err)}`);
      } finally {
        await refresh();
      }
    },
    [status, requestUnlock, label, refresh]
  );

  const handleEnable = useCallback(async () => {
    if (!password) {
      setError("Enter your master password.");
      throw new Error("Enter your master password.");
    }
    setError("");
    try {
      await enableBiometricUnlock(password);
      setEnabling(false);
      toast.success(`Unlock with ${label} turned on`);
    } catch (err) {
      setError(enableErrorMessage(err, label));
      setPassword("");
      throw err; // keep the async Button in its error path (inline error)
    } finally {
      await refresh();
    }
  }, [password, label, refresh]);

  if (!biometric?.supported) return null;

  return (
    <div className="settings-panel__field" data-testid="biometric-unlock-settings">
      <SettingsField
        label={`Unlock with ${label}`}
        hint={`Unlock the credential store with ${label} instead of typing your master password. Your master password keeps working, and is needed again after you change it or your ${label} enrollment changes.`}
      >
        <Toggle
          checked={biometric.enabled || enabling}
          onCheckedChange={(on) => void handleToggle(on)}
          aria-label={`Unlock with ${label}`}
          data-testid="biometric-unlock-toggle"
        />
      </SettingsField>
      {enabling && !biometric.enabled && (
        <form className="settings-panel__inline-dialog" data-testid="biometric-unlock-enable-form">
          <h4 className="settings-panel__inline-dialog-title">Turn on unlock with {label}</h4>
          <PasswordInput
            className="settings-panel__inline-dialog-input"
            placeholder="Current master password"
            aria-label="Current master password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            data-testid="biometric-unlock-password"
          />
          {error && (
            <p className="settings-panel__inline-dialog-error" data-testid="biometric-unlock-error">
              {error}
            </p>
          )}
          <div className="settings-panel__inline-dialog-actions">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon={<Fingerprint size={14} />}
              onClick={handleEnable}
              errorToast={false}
              pendingLabel={`Waiting for ${label}…`}
              data-testid="biometric-unlock-enable-btn"
            >
              Turn on
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setEnabling(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
