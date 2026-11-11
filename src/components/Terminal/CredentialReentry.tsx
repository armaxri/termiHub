import { useCallback, useId, useMemo, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { Button, Checkbox, Field, Input, toast } from "@/components/ui";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { KeyPathInput } from "@/components/Settings/KeyPathInput";
import { t, tf } from "@/i18n/catalog";
import {
  credentialReentryTarget,
  reconnectWithReenteredCredentials,
  type CredentialReentryInput,
  type CredentialReentryTarget,
} from "@/utils/credentialReentry";
import "./CredentialReentry.css";

/**
 * Reconnect with the entered credential; resolves `false` when a requested
 * save cannot happen (the reconnect still runs).
 */
export type CredentialReentrySubmit = (
  target: CredentialReentryTarget,
  input: CredentialReentryInput
) => Promise<boolean>;

interface CredentialReentryProps {
  /** The tab whose connection the server rejected. */
  tabId: string;
  /**
   * The re-entry target, for a tab whose connection is not a terminal one
   * (VNC/RDP, FTP, #5377). Omitted: derived from the tab's terminal config.
   */
  target?: CredentialReentryTarget | null;
  /**
   * How to reconnect with the entered credential. Omitted: a terminal tab's
   * fresh shell ({@link reconnectWithReenteredCredentials}).
   */
  onSubmit?: CredentialReentrySubmit;
}

interface CredentialReentryFormProps {
  tabId: string;
  target: CredentialReentryTarget;
  /** Whether a credential store is configured, so a "Save" box makes sense. */
  storeActive: boolean;
  onCancel: () => void;
  onSubmit?: CredentialReentrySubmit;
}

/**
 * The expanded re-entry form: the secret the tab's auth method needs (password,
 * or key file + passphrase), the connect-time prompt's "Save" box, and
 * Reconnect / Cancel. Submitting reconnects the tab with the new credential.
 */
function CredentialReentryForm({
  tabId,
  target,
  storeActive,
  onCancel,
  onSubmit,
}: CredentialReentryFormProps) {
  const [secret, setSecret] = useState("");
  const [keyPath, setKeyPath] = useState(target.keyPath);
  const canSave = storeActive && target.credentialId !== null;
  const [save, setSave] = useState(target.saveDefault);
  const baseId = useId();
  const isKey = target.authMethod === "key";

  // Driven by the submit Button's async lifecycle (click or Enter), so the
  // button shows a pending state while the store is unlocked for a save.
  const handleSubmit = useCallback(async () => {
    const input = { secret, keyPath: isKey ? keyPath : undefined, save: canSave && save };
    const saved = onSubmit
      ? await onSubmit(target, input)
      : await reconnectWithReenteredCredentials(tabId, target, input);
    if (!saved) toast.error(t("credentialReentry.saveFailed"));
  }, [tabId, target, secret, isKey, keyPath, canSave, save, onSubmit]);

  const secretLabel = isKey
    ? t("credentialReentry.passphrase.label")
    : t("credentialReentry.password.label");
  const saveLabel = isKey
    ? t("credentialReentry.save.passphrase")
    : t("credentialReentry.save.password");

  return (
    <form className="credential-reentry" data-testid="terminal-credential-reentry-form">
      {target.host && (
        <p className="credential-reentry__target">
          {tf("credentialReentry.target", {
            target: target.username ? `${target.username}@${target.host}` : target.host,
          })}
        </p>
      )}
      {isKey && (
        <Field
          label={t("credentialReentry.keyPath.label")}
          htmlFor={`${baseId}-key`}
          hint={target.agentHosted ? t("credentialReentry.keyPath.agentHint") : undefined}
        >
          {target.agentHosted ? (
            // The key lives on the agent host: a plain path, no local picker.
            <Input
              id={`${baseId}-key`}
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              data-testid="terminal-credential-reentry-key-path-input"
            />
          ) : (
            <KeyPathInput
              id={`${baseId}-key`}
              value={keyPath}
              onChange={setKeyPath}
              testIdPrefix="terminal-credential-reentry"
            />
          )}
        </Field>
      )}
      <Field
        label={secretLabel}
        htmlFor={`${baseId}-secret`}
        hint={isKey ? t("credentialReentry.passphrase.hint") : undefined}
      >
        <PasswordInput
          id={`${baseId}-secret`}
          className="ui-input"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoFocus
          data-testid="terminal-credential-reentry-secret"
        />
      </Field>
      {canSave && (
        <label className="credential-reentry__save">
          <Checkbox
            checked={save}
            onCheckedChange={setSave}
            aria-label={saveLabel}
            data-testid="terminal-credential-reentry-save"
          />
          <span>{saveLabel}</span>
        </label>
      )}
      <div className="credential-reentry__actions">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onCancel}
          data-testid="terminal-credential-reentry-cancel"
        >
          {t("credentialReentry.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          data-testid="terminal-credential-reentry-submit"
        >
          {t("credentialReentry.submit")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Inline credential re-entry for a tab whose credentials the server rejected
 * (#3089). Rendered by the terminal overlays only for a structurally-detected
 * auth failure; renders nothing when the tab's auth method has no secret to
 * re-enter. Collapsed to an "Update Credentials" button until opened; Cancel
 * collapses it again and leaves the tab in its auth-failed state.
 */
export function CredentialReentry({
  tabId,
  target: targetOverride,
  onSubmit,
}: CredentialReentryProps) {
  const config = useAppStore((s) => s.tabContent[tabId]?.config);
  const connectionId = useAppStore((s) => s.tabContent[tabId]?.connectionId);
  const storeMode = useAppStore((s) => s.credentialStoreStatus?.mode);
  const [open, setOpen] = useState(false);
  const derived = useMemo(
    () => credentialReentryTarget(config, connectionId),
    [config, connectionId]
  );
  const target = targetOverride !== undefined ? targetOverride : derived;

  if (!target) return null;
  if (!open) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="terminal-credential-reentry-open-btn"
      >
        {t("credentialReentry.open")}
      </Button>
    );
  }
  return (
    <CredentialReentryForm
      tabId={tabId}
      target={target}
      storeActive={storeMode !== undefined && storeMode !== "none"}
      onCancel={() => setOpen(false)}
      onSubmit={onSubmit}
    />
  );
}
