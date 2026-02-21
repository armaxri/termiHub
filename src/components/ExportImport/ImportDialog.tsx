import { useState, useCallback, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { previewImport, importConnectionsWithCredentials } from "@/services/api";
import type { ImportPreview } from "@/services/api";
import { useAppStore } from "@/store/appStore";
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

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="import-dialog__overlay" />
        <Dialog.Content className="import-dialog__content">
          <Dialog.Title className="import-dialog__title">Import Connections</Dialog.Title>

          {error && !success && <p className="import-dialog__error">{error}</p>}

          {success ? (
            <>
              <p className="import-dialog__success">{success}</p>
              <div className="import-dialog__actions">
                <button
                  className="import-dialog__btn import-dialog__btn--primary"
                  onClick={handleClose}
                >
                  Done
                </button>
              </div>
            </>
          ) : preview ? (
            <>
              <Dialog.Description className="import-dialog__description">
                Found {preview.connectionCount} connection
                {preview.connectionCount !== 1 ? "s" : ""}
                {preview.folderCount > 0 &&
                  `, ${preview.folderCount} folder${preview.folderCount !== 1 ? "s" : ""}`}
                {preview.agentCount > 0 &&
                  `, ${preview.agentCount} agent${preview.agentCount !== 1 ? "s" : ""}`}
              </Dialog.Description>

              {preview.hasEncryptedCredentials && (
                <div className="import-dialog__password-section">
                  <p className="import-dialog__hint">
                    This file contains encrypted credentials. Enter the export password to import
                    them.
                  </p>
                  <input
                    className="import-dialog__input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Export password"
                    autoFocus
                    data-testid="import-password"
                  />
                </div>
              )}

              <div className="import-dialog__actions">
                <button
                  className="import-dialog__btn import-dialog__btn--secondary"
                  onClick={handleClose}
                  disabled={importing}
                >
                  Cancel
                </button>
                {preview.hasEncryptedCredentials ? (
                  <>
                    <button
                      className="import-dialog__btn import-dialog__btn--secondary"
                      onClick={() => handleImport(false)}
                      disabled={importing}
                      data-testid="import-without-credentials"
                    >
                      Skip Credentials
                    </button>
                    <button
                      className="import-dialog__btn import-dialog__btn--primary"
                      onClick={() => handleImport(true)}
                      disabled={importing || !password}
                      data-testid="import-with-credentials"
                    >
                      {importing ? "Importing..." : "Import with Credentials"}
                    </button>
                  </>
                ) : (
                  <button
                    className="import-dialog__btn import-dialog__btn--primary"
                    onClick={() => handleImport(false)}
                    disabled={importing}
                    data-testid="import-submit"
                  >
                    {importing ? "Importing..." : "Import"}
                  </button>
                )}
              </div>
            </>
          ) : (
            !error && <p className="import-dialog__description">Loading preview...</p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
