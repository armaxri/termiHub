import { useState, useCallback, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { exportConnectionsEncrypted } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import "./ExportDialog.css";

type ExportMode = "plain" | "encrypted";

export function ExportDialog() {
  const open = useAppStore((s) => s.exportDialogOpen);
  const setOpen = useAppStore((s) => s.setExportDialogOpen);

  const [mode, setMode] = useState<ExportMode>("plain");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (open) {
      setMode("plain");
      setPassword("");
      setConfirmPassword("");
      setError("");
      setExporting(false);
    }
  }, [open]);

  const passwordValid = mode === "plain" || (password.length >= 8 && password === confirmPassword);

  const passwordError = (() => {
    if (mode === "plain") return "";
    if (password.length > 0 && password.length < 8) return "Password must be at least 8 characters";
    if (confirmPassword.length > 0 && password !== confirmPassword) return "Passwords do not match";
    return "";
  })();

  const handleExport = useCallback(async () => {
    if (!passwordValid) return;
    setExporting(true);
    setError("");

    try {
      const exportPassword = mode === "encrypted" ? password : null;
      const json = await exportConnectionsEncrypted(exportPassword, null);

      const filePath = await save({
        defaultPath: "termihub-connections.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) {
        setExporting(false);
        return;
      }

      await writeTextFile(filePath, json);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [mode, password, passwordValid, setOpen]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="export-dialog__overlay" />
        <Dialog.Content className="export-dialog__content">
          <Dialog.Title className="export-dialog__title">Export Connections</Dialog.Title>

          <fieldset className="export-dialog__fieldset">
            <label className="export-dialog__radio-label">
              <input
                type="radio"
                name="export-mode"
                checked={mode === "plain"}
                onChange={() => setMode("plain")}
              />
              Without credentials
            </label>
            <label className="export-dialog__radio-label">
              <input
                type="radio"
                name="export-mode"
                checked={mode === "encrypted"}
                onChange={() => setMode("encrypted")}
              />
              With credentials (encrypted)
            </label>
          </fieldset>

          {mode === "encrypted" && (
            <div className="export-dialog__password-section">
              <p className="export-dialog__warning">
                Credentials will be encrypted with AES-256-GCM. You will need this password to
                import them on another machine.
              </p>
              <input
                className="export-dialog__input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Encryption password (min 8 characters)"
                autoFocus
                data-testid="export-password"
              />
              <input
                className="export-dialog__input"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm password"
                data-testid="export-confirm-password"
              />
              {passwordError && <p className="export-dialog__error">{passwordError}</p>}
            </div>
          )}

          {error && <p className="export-dialog__error">{error}</p>}

          <div className="export-dialog__actions">
            <button
              className="export-dialog__btn export-dialog__btn--secondary"
              onClick={() => setOpen(false)}
              disabled={exporting}
            >
              Cancel
            </button>
            <button
              className="export-dialog__btn export-dialog__btn--primary"
              onClick={handleExport}
              disabled={!passwordValid || exporting}
              data-testid="export-submit"
            >
              {exporting ? "Exporting..." : "Export"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
