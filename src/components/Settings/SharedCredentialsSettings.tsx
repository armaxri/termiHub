import { useCallback, useState } from "react";
import { KeyRound, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, ConfirmDialog, toast } from "@/components/ui";
import { useNamedCredentials } from "@/hooks/useNamedCredentials";
import { deleteNamedCredential, isNamedCredentialError } from "@/services/namedCredentials";
import type { NamedCredential } from "@/types/generated/NamedCredential";
import type { NamedCredentialEntry } from "@/types/generated/NamedCredentialEntry";
import type { NamedCredentialUsage } from "@/types/generated/NamedCredentialUsage";
import { errorMessage } from "@/utils/errorMessage";
import {
  kindLabel,
  SharedCredentialDialog,
  type SharedCredentialDialogMode,
} from "./SharedCredentialDialog";
import "./CredentialVault.css";

/** "Used by 2 connections" / "Not used". */
export function usageSummary(usages: NamedCredentialUsage[]): string {
  if (usages.length === 0) return "Not used";
  return `Used by ${usages.length} connection${usages.length === 1 ? "" : "s"}`;
}

/** A refused delete: the credential and who still uses it. */
interface InUseRefusal {
  message: string;
  usages: NamedCredentialUsage[];
}

/**
 * Settings → Security section managing shared named credentials (#3557): one
 * password or key passphrase that many connections use and that is rotated in
 * one place. Deleting a credential that connections still use is refused, and
 * the refusal lists them.
 */
export function SharedCredentialsSettings() {
  const credentialStoreStatus = useAppStore((s) => s.credentialStoreStatus);
  const requestUnlock = useAppStore((s) => s.requestUnlock);
  const { entries } = useNamedCredentials();
  const [dialog, setDialog] = useState<SharedCredentialDialogMode | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NamedCredential | null>(null);
  const [refusal, setRefusal] = useState<InUseRefusal | null>(null);

  const mode = credentialStoreStatus?.mode ?? "none";
  const status = credentialStoreStatus?.status;
  const unavailable =
    mode === "none"
      ? "Credential storage is off — choose Master Password or OS Keychain to use shared credentials."
      : mode === "master_password" && status === "unavailable"
        ? "Set up a master password first."
        : null;

  const ensureUnlocked = useCallback(async (): Promise<boolean> => {
    if (mode === "master_password" && status === "locked") return await requestUnlock();
    return true;
  }, [mode, status, requestUnlock]);

  const open = useCallback(
    async (next: SharedCredentialDialogMode) => {
      setRefusal(null);
      if (next.kind === "rename" || (await ensureUnlocked())) setDialog(next);
    },
    [ensureUnlocked]
  );

  const askDelete = useCallback(
    async (credential: NamedCredential) => {
      setRefusal(null);
      if (await ensureUnlocked()) setPendingDelete(credential);
    },
    [ensureUnlocked]
  );

  const confirmDelete = useCallback(async () => {
    const credential = pendingDelete;
    if (!credential) return;
    try {
      await deleteNamedCredential(credential.id);
      toast.success(`Shared credential "${credential.name}" deleted.`);
      setPendingDelete(null);
    } catch (err) {
      setPendingDelete(null);
      if (isNamedCredentialError(err) && err.kind === "inUse") {
        setRefusal({ message: err.message, usages: err.usages });
        return;
      }
      toast.error(isNamedCredentialError(err) ? err.message : errorMessage(err));
    }
  }, [pendingDelete]);

  return (
    <div className="settings-panel__section" data-testid="shared-credentials">
      <h3 className="settings-panel__section-title">Shared Credentials</h3>
      <p className="settings-panel__description">
        A password or key passphrase that several connections use. Change it here once and every
        connection that uses it picks up the new secret. Choose one in a connection&apos;s
        Authentication settings.
      </p>
      {unavailable && (
        <p className="settings-panel__description" data-testid="shared-credentials-unavailable">
          {unavailable}
        </p>
      )}
      {entries.length > 0 && (
        <ul className="shared-credentials__list" data-testid="shared-credentials-list">
          {entries.map((entry) => (
            <SharedCredentialRow
              key={entry.credential.id}
              entry={entry}
              disabled={unavailable !== null}
              onRename={() => void open({ kind: "rename", credential: entry.credential })}
              onRotate={() => void open({ kind: "rotate", credential: entry.credential })}
              onDelete={() => void askDelete(entry.credential)}
            />
          ))}
        </ul>
      )}
      {refusal && (
        <div
          className="credential-vault__warning"
          role="alert"
          data-testid="shared-credentials-in-use"
        >
          <p className="shared-credentials__refusal">{refusal.message}</p>
          <ul className="shared-credentials__users">
            {refusal.usages.map((u) => (
              <li key={`${u.ownerKind}:${u.ownerId}`}>
                {u.ownerName}
                {u.ownerKind === "agent" ? " (remote agent)" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="credential-vault__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={14} />}
          disabled={unavailable !== null}
          onClick={() => void open({ kind: "create" })}
          data-testid="shared-credentials-create"
        >
          New shared credential…
        </Button>
      </div>
      <SharedCredentialDialog mode={dialog} onClose={() => setDialog(null)} />
      <ConfirmDialog
        open={pendingDelete !== null}
        variant="danger"
        title={`Delete "${pendingDelete?.name ?? ""}"?`}
        message="The secret is removed from the credential store. This cannot be undone."
        confirmLabel="Delete"
        confirmErrorToast={false}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
        testIdBase="shared-credential-delete"
      />
    </div>
  );
}

interface SharedCredentialRowProps {
  entry: NamedCredentialEntry;
  disabled: boolean;
  onRename: () => void;
  onRotate: () => void;
  onDelete: () => void;
}

/** One shared credential: name, kind, usage, and its actions. */
function SharedCredentialRow({
  entry,
  disabled,
  onRename,
  onRotate,
  onDelete,
}: SharedCredentialRowProps) {
  const { credential, usages } = entry;
  return (
    <li className="shared-credentials__row" data-testid={`shared-credential-${credential.id}`}>
      <KeyRound size={14} className="shared-credentials__icon" aria-hidden />
      <div className="shared-credentials__text">
        <span className="shared-credentials__name">{credential.name}</span>
        <span
          className="shared-credentials__meta"
          title={usages.map((u) => u.ownerName).join(", ") || undefined}
        >
          {kindLabel(credential.kind)} · {usageSummary(usages)}
        </span>
      </div>
      <div className="shared-credentials__row-actions">
        <Button
          variant="ghost"
          size="sm"
          icon={<Pencil size={13} />}
          onClick={onRename}
          aria-label={`Rename ${credential.name}`}
          data-testid={`shared-credential-rename-${credential.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={13} />}
          disabled={disabled}
          onClick={onRotate}
          aria-label={`Change the secret of ${credential.name}`}
          data-testid={`shared-credential-rotate-${credential.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={13} />}
          onClick={onDelete}
          aria-label={`Delete ${credential.name}`}
          data-testid={`shared-credential-delete-${credential.id}`}
        />
      </div>
    </li>
  );
}
