import { useState, useCallback, useEffect } from "react";
import { previewImport, importConnectionsWithCredentials } from "@/services/api";
import type { ImportPreview } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button } from "@/components/ui";
import "./ImportDialog.css";

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

  useEffect(() => {
    if (open && fileContent) {
      setPassword("");
      setError("");
      setSuccess("");
      setImporting(false);

      previewImport(fileContent)
        .then(setPreview)
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
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

        let message = `Imported ${result.connectionsImported} connection${result.connectionsImported !== 1 ? "s" : ""}`;
        if (result.credentialsImported > 0) {
          message += ` and ${result.credentialsImported} credential${result.credentialsImported !== 1 ? "s" : ""}`;
        }
        setSuccess(message);
        await loadFromBackend();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("wrong password")) {
          setError("Wrong password. Please try again.");
        } else {
          setError(msg);
        }
      } finally {
        setImporting(false);
      }
    },
    [fileContent, password, loadFromBackend]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
        <p className="import-dialog__success" data-testid="import-dialog-success">
          {success}
        </p>
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
