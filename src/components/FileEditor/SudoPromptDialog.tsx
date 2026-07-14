import { useState, useEffect, useCallback } from "react";
import { ShieldCheck } from "lucide-react";
import { Modal, Button, Field, Toggle } from "@/components/ui";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import "./SudoPromptDialog.css";

/** Caching choices returned alongside the entered password. */
export interface SudoAuthorizeOptions {
  /** Keep the password in memory for the rest of this editor session. */
  rememberForSession: boolean;
  /** Persist the password in the (unlocked) credential store. */
  persistToStore: boolean;
}

export interface SudoPromptDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** Host label (`user@host:port`) of the remote connection, for context. */
  hostLabel: string;
  /** Absolute remote path of the file being saved. */
  targetPath: string;
  /** 1-based attempt number; when > 1 the previous password was rejected. */
  attempt: number;
  /** Maximum number of attempts allowed (drives the "attempt X of N" counter). */
  maxAttempts: number;
  /** Whether the credential store is unlocked — gates the persist option. */
  credentialStoreUnlocked: boolean;
  /** True while the parent verifies the submitted password (pending state). */
  busy?: boolean;
  /** Submit the entered password plus the caching choices. */
  onSubmit: (password: string, options: SudoAuthorizeOptions) => void;
  /** Cancel / dismiss without authorizing. */
  onCancel: () => void;
}

/** Split a `user@host:port` label into its user and host parts for display. */
function splitHostLabel(hostLabel: string): { user: string; host: string } {
  const at = hostLabel.indexOf("@");
  if (at < 0) return { user: "", host: hostLabel };
  return { user: hostLabel.slice(0, at), host: hostLabel.slice(at + 1) };
}

/**
 * Password prompt for a privilege-elevated (`sudo`) remote save.
 *
 * Composed entirely from shared UI primitives (Modal / Field / Toggle / Button)
 * plus the masked {@link PasswordInput}. The password is handed straight back to
 * the caller via {@link onSubmit}; this component never stores or logs it beyond
 * the controlled input, and clears it whenever the attempt changes (re-prompt).
 */
export function SudoPromptDialog({
  open,
  hostLabel,
  targetPath,
  attempt,
  maxAttempts,
  credentialStoreUnlocked,
  busy = false,
  onSubmit,
  onCancel,
}: SudoPromptDialogProps) {
  const [password, setPassword] = useState("");
  const [rememberForSession, setRememberForSession] = useState(true);
  const [persistToStore, setPersistToStore] = useState(false);

  // Reset all fields when the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setPassword("");
      setRememberForSession(true);
      setPersistToStore(false);
    }
  }, [open]);

  // On a re-prompt (attempt bumped while the dialog stays open) clear only the
  // rejected password, preserving the user's caching choices.
  useEffect(() => {
    setPassword("");
  }, [attempt]);

  const { user, host } = splitHostLabel(hostLabel);

  const handleSubmit = useCallback(() => {
    if (!password || busy) return;
    onSubmit(password, {
      rememberForSession,
      persistToStore: credentialStoreUnlocked && persistToStore,
    });
  }, [password, busy, onSubmit, rememberForSession, persistToStore, credentialStoreUnlocked]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSubmit();
    },
    [handleSubmit]
  );

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title="Save with sudo"
      description="Authenticate to write this read-only file with elevated privileges."
      onKeyDown={handleKeyDown}
      data-testid="sudo-prompt-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-testid="sudo-prompt-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<ShieldCheck size={14} />}
            onClick={handleSubmit}
            disabled={!password || busy}
            data-testid="sudo-prompt-submit"
          >
            {busy ? "Authorizing…" : "Authorize"}
          </Button>
        </>
      }
    >
      <p className="sudo-prompt__lead">
        Saving requires administrator (<code>sudo</code>) privileges on the remote host.
      </p>
      <dl className="sudo-prompt__facts">
        <div className="sudo-prompt__fact">
          <dt>Host</dt>
          <dd data-testid="sudo-prompt-host">{host}</dd>
        </div>
        <div className="sudo-prompt__fact">
          <dt>User</dt>
          <dd data-testid="sudo-prompt-user">{user || "(default)"}</dd>
        </div>
        <div className="sudo-prompt__fact">
          <dt>File</dt>
          <dd data-testid="sudo-prompt-target" title={targetPath}>
            {targetPath}
          </dd>
        </div>
      </dl>
      <Field label="sudo password" htmlFor="sudo-prompt-password">
        <PasswordInput
          id="sudo-prompt-password"
          className="ui-input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Password for sudo"
          autoFocus
          disabled={busy}
          data-testid="sudo-prompt-input"
        />
      </Field>
      {attempt > 1 && (
        <p className="sudo-prompt__error" role="alert" data-testid="sudo-prompt-error">
          Incorrect password. Attempt {attempt} of {maxAttempts}.
        </p>
      )}
      <div className="sudo-prompt__option">
        <Toggle
          id="sudo-prompt-remember"
          checked={rememberForSession}
          onCheckedChange={setRememberForSession}
          disabled={busy}
          data-testid="sudo-prompt-remember"
        />
        <label htmlFor="sudo-prompt-remember" className="sudo-prompt__option-label">
          Remember for this session
        </label>
      </div>
      {credentialStoreUnlocked && (
        <div className="sudo-prompt__option">
          <Toggle
            id="sudo-prompt-persist"
            checked={persistToStore}
            onCheckedChange={setPersistToStore}
            disabled={busy}
            data-testid="sudo-prompt-persist"
          />
          <label htmlFor="sudo-prompt-persist" className="sudo-prompt__option-label">
            Save in credential store
          </label>
        </div>
      )}
    </Modal>
  );
}
