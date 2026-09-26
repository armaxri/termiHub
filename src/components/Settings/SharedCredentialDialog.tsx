import { useCallback, useEffect, useState } from "react";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Button, Field, Input, Modal, Select, toast } from "@/components/ui";
import {
  createNamedCredential,
  isNamedCredentialError,
  renameNamedCredential,
  rotateNamedCredential,
} from "@/services/namedCredentials";
import type { NamedCredential } from "@/types/generated/NamedCredential";
import type { NamedCredentialKind } from "@/types/generated/NamedCredentialKind";
import { errorMessage } from "@/utils/errorMessage";
import "./CredentialVault.css";

/** What the dialog does: create a credential, or rename / rotate `credential`. */
export type SharedCredentialDialogMode =
  | { kind: "create" }
  | { kind: "rename"; credential: NamedCredential }
  | { kind: "rotate"; credential: NamedCredential };

interface SharedCredentialDialogProps {
  mode: SharedCredentialDialogMode | null;
  onClose: () => void;
}

/** Display label of a named-credential kind. */
export function kindLabel(kind: NamedCredentialKind): string {
  return kind === "password" ? "Password" : "SSH key passphrase";
}

const KIND_OPTIONS = [
  { value: "password", label: kindLabel("password") },
  { value: "key_passphrase", label: kindLabel("key_passphrase") },
];

function titleFor(mode: SharedCredentialDialogMode): string {
  switch (mode.kind) {
    case "create":
      return "New Shared Credential";
    case "rename":
      return `Rename "${mode.credential.name}"`;
    case "rotate":
      return `Change Secret of "${mode.credential.name}"`;
  }
}

/** Client-side validation mirroring the backend rules; an error or null. */
function validate(
  mode: SharedCredentialDialogMode,
  name: string,
  secret: string,
  confirm: string
): string | null {
  if (mode.kind !== "rotate" && !name.trim()) return "Enter a name.";
  if (mode.kind !== "rename") {
    if (!secret) return "Enter the secret.";
    if (secret !== confirm) return "The secrets do not match.";
  }
  return null;
}

/**
 * Create, rename, or rotate a shared named credential (#3557). The secret is
 * typed twice, sent to the backend once, and cleared whenever the dialog opens
 * or closes; it is never shown or read back.
 */
export function SharedCredentialDialog({ mode, onClose }: SharedCredentialDialogProps) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<NamedCredentialKind>("password");
  const [secret, setSecret] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setName(mode && mode.kind !== "create" ? mode.credential.name : "");
    setKind(mode && mode.kind !== "create" ? mode.credential.kind : "password");
    setSecret("");
    setConfirm("");
    setError("");
  }, [mode]);

  const handleSubmit = useCallback(async () => {
    if (!mode) return;
    const validationError = validate(mode, name, secret, confirm);
    if (validationError) {
      setError(validationError);
      throw new Error(validationError);
    }
    setError("");
    try {
      if (mode.kind === "create") {
        await createNamedCredential(name.trim(), kind, secret);
        toast.success(`Shared credential "${name.trim()}" created.`);
      } else if (mode.kind === "rename") {
        await renameNamedCredential(mode.credential.id, name.trim());
        toast.success("Shared credential renamed.");
      } else {
        await rotateNamedCredential(mode.credential.id, secret);
        toast.success(`"${mode.credential.name}" updated for every connection that uses it.`);
      }
      onClose();
    } catch (err) {
      setError(isNamedCredentialError(err) ? err.message : errorMessage(err));
      throw err;
    }
  }, [mode, name, kind, secret, confirm, onClose]);

  if (!mode) return null;
  const secretLabel =
    (mode.kind === "create" ? kind : mode.credential.kind) === "password"
      ? "password"
      : "passphrase";

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={<span data-testid="shared-credential-dialog-title">{titleFor(mode)}</span>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="shared-credential-form"
            variant="primary"
            onClick={handleSubmit}
            errorToast={false}
            data-testid="shared-credential-submit"
          >
            {mode.kind === "create" ? "Create" : "Save"}
          </Button>
        </>
      }
    >
      <form id="shared-credential-form" className="credential-vault__form">
        {mode.kind !== "rotate" && (
          <Field label="Name" htmlFor="shared-credential-name">
            <Input
              id="shared-credential-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Bastion admin"
              autoFocus
              data-testid="shared-credential-name"
            />
          </Field>
        )}
        {mode.kind === "create" && (
          <Field label="Kind">
            <Select
              value={kind}
              onChange={(v) => setKind(v === "key_passphrase" ? "key_passphrase" : "password")}
              options={KIND_OPTIONS}
              data-testid="shared-credential-kind"
            />
          </Field>
        )}
        {mode.kind !== "rename" && (
          <>
            {mode.kind === "rotate" && (
              <p className="credential-vault__note">
                Every connection that uses this credential will use the new {secretLabel} from its
                next connect.
              </p>
            )}
            <PasswordInput
              className="ui-input"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={mode.kind === "rotate" ? `New ${secretLabel}` : `The ${secretLabel}`}
              aria-label={mode.kind === "rotate" ? `New ${secretLabel}` : `The ${secretLabel}`}
              autoFocus={mode.kind === "rotate"}
              data-testid="shared-credential-secret"
            />
            <PasswordInput
              className="ui-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={`Confirm ${secretLabel}`}
              aria-label={`Confirm ${secretLabel}`}
              data-testid="shared-credential-confirm"
            />
          </>
        )}
        {error && (
          <p className="credential-vault__error" role="alert" data-testid="shared-credential-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
