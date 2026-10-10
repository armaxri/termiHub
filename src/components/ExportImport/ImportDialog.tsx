import { useState, useCallback, useEffect } from "react";
import { previewImport, importConnectionsWithCredentials, isImportError } from "@/services/api";
import type { ConnectionImportResult, ImportPreview } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button } from "@/components/ui";
import "./ImportDialog.css";
import { errorMessage } from "@/utils/errorMessage";
import { isImeComposing } from "@/utils/imeComposition";

/** `count` followed by `noun`, pluralized with a trailing "s" when not 1. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count !== 1 ? "s" : ""}`;
}

/**
 * One-line summary of a completed connection import.
 *
 * Counts only the connections and agents actually added; ones the store
 * already held are skipped by the backend (#3689) and reported separately
 * (#4210, #4380). "Nothing imported" is only claimed when no agent was added
 * either (#4380).
 */
export function importSummary(result: ConnectionImportResult): string {
  const { connectionsImported, connectionsSkipped, credentialsImported } = result;
  const { agentsImported, agentsSkipped } = result;
  const shared = result.sharedCredentialsImported;
  const credentials =
    credentialsImported > 0 ? ` and ${plural(credentialsImported, "credential")}` : "";

  const added: string[] = [];
  if (connectionsImported > 0) {
    added.push(plural(connectionsImported, "connection") + credentials);
  }
  if (shared > 0) {
    added.push(plural(shared, "shared credential"));
  }
  if (agentsImported > 0) {
    // Agent credentials ride on the agents when no connection was added.
    added.push(plural(agentsImported, "agent") + (connectionsImported > 0 ? "" : credentials));
  }

  // "skipped N that already exist" may drop its noun only when connections are
  // the one kind mentioned; once agents appear, every count names its kind.
  const agentsMentioned = agentsImported > 0 || agentsSkipped > 0;
  const skipped: string[] = [];
  if (connectionsSkipped > 0) {
    skipped.push(
      connectionsImported > 0 && !agentsMentioned
        ? `${connectionsSkipped}`
        : plural(connectionsSkipped, "connection")
    );
  }
  if (agentsSkipped > 0) {
    skipped.push(plural(agentsSkipped, "agent"));
  }
  const verb = connectionsSkipped + agentsSkipped === 1 ? "exists" : "exist";

  if (added.length > 0) {
    let message = `Imported ${added.join(", ")}`;
    if (skipped.length > 0) {
      message += `, skipped ${skipped.join(" and ")} that already ${verb}`;
    }
    return message;
  }
  if (connectionsSkipped > 0 && agentsSkipped > 0) {
    return `Nothing imported — ${skipped.join(" and ")} already exist`;
  }
  if (connectionsSkipped === 1) {
    return "Nothing imported — the connection already exists";
  }
  if (connectionsSkipped > 1) {
    return `Nothing imported — all ${connectionsSkipped} connections already exist`;
  }
  if (agentsSkipped === 1) {
    return "Nothing imported — the agent already exists";
  }
  if (agentsSkipped > 1) {
    return `Nothing imported — all ${agentsSkipped} agents already exist`;
  }
  return "Nothing imported — the file contains no connections or agents";
}

export function ImportDialog() {
  const open = useAppStore((s) => s.importDialogOpen);
  const fileContent = useAppStore((s) => s.importFileContent);
  const setImportDialog = useAppStore((s) => s.setImportDialog);
  const loadFromBackend = useAppStore((s) => s.loadFromBackend);

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [success, setSuccess] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    if (open && fileContent) {
      setPassword("");
      setError("");
      setSuccess("");
      setWarnings([]);
      setImporting(false);

      previewImport(fileContent)
        .then(setPreview)
        .catch((err) => {
          setError(errorMessage(err));
          setPreview(null);
        });
    } else {
      setPreview(null);
    }
  }, [open, fileContent]);

  const handleClose = useCallback(() => {
    setImportDialog(false, undefined);
  }, [setImportDialog]);

  const handleImport = useCallback(
    async (withCredentials: boolean) => {
      if (!fileContent) return;
      setImporting(true);
      setError("");
      setSuccess("");

      try {
        const importPassword = withCredentials && password ? password : null;
        const result = await importConnectionsWithCredentials(fileContent, importPassword);

        setWarnings(result.warnings);
        setSuccess(importSummary(result));
        await loadFromBackend();
      } catch (err) {
        // Classify by the backend's stable error `kind`, never by the English
        // message — so a localized or reworded backend string still yields the
        // tailored wrong-password affordance (I18N-010).
        if (isImportError(err)) {
          setError(
            err.kind === "wrongPassword" ? "Wrong password. Please try again." : err.message
          );
        } else {
          setError(errorMessage(err));
        }
      } finally {
        setImporting(false);
      }
    },
    [fileContent, password, loadFromBackend]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isImeComposing(e)) return;
      if (e.key === "Enter" && preview?.hasEncryptedCredentials && password) {
        handleImport(true);
      }
    },
    [handleImport, preview, password]
  );

  let footer: React.ReactNode = null;
  if (success) {
    footer = (
      <Button variant="primary" onClick={handleClose}>
        Done
      </Button>
    );
  } else if (preview) {
    footer = (
      <>
        <Button variant="secondary" onClick={handleClose} disabled={importing}>
          Cancel
        </Button>
        {preview.hasEncryptedCredentials ? (
          <>
            <Button
              variant="secondary"
              onClick={() => handleImport(false)}
              disabled={importing}
              data-testid="import-without-credentials"
            >
              Skip Credentials
            </Button>
            <Button
              variant="primary"
              onClick={() => handleImport(true)}
              disabled={importing || !password}
              data-testid="import-with-credentials"
            >
              Import with Credentials
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            onClick={() => handleImport(false)}
            disabled={importing}
            data-testid="import-submit"
          >
            Import
          </Button>
        )}
      </>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={(v) => !v && handleClose()}
      title="Import Connections"
      footer={footer}
    >
      {error && !success && <p className="import-dialog__error">{error}</p>}

      {success ? (
        <>
          <p className="import-dialog__success" data-testid="import-dialog-success">
            {success}
          </p>
          {warnings.length > 0 && (
            <ul className="import-dialog__warnings" data-testid="import-dialog-warnings">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </>
      ) : preview ? (
        <>
          <p className="import-dialog__description">
            Found {preview.connectionCount} connection
            {preview.connectionCount !== 1 ? "s" : ""}
            {preview.folderCount > 0 &&
              `, ${preview.folderCount} folder${preview.folderCount !== 1 ? "s" : ""}`}
            {preview.agentCount > 0 &&
              `, ${preview.agentCount} agent${preview.agentCount !== 1 ? "s" : ""}`}
          </p>

          {preview.hasEncryptedCredentials && (
            <div className="import-dialog__password-section">
              <p className="import-dialog__hint">
                This file contains encrypted credentials. Enter the export password to import them.
              </p>
              <PasswordInput
                className="ui-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Export password"
                autoFocus
                data-testid="import-password"
              />
            </div>
          )}
        </>
      ) : (
        !error && <p className="import-dialog__description">Loading preview...</p>
      )}
    </Modal>
  );
}
