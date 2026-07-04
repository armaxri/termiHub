import { useState, useCallback, useEffect } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { exportConnectionsEncrypted } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button } from "@/components/ui";
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
    <Modal
      open={open}
      onOpenChange={setOpen}
      title={<span data-testid="export-dialog-title">Export Connections</span>}
      footer={
        <>
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={exporting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleExport}
            disabled={!passwordValid || exporting}
            data-testid="export-submit"
          >
            Export
          </Button>
        </>
      }
    >
      <fieldset className="export-dialog__fieldset">
        <label className="export-dialog__radio-label">
          <input
            type="radio"
            name="export-mode"
            checked={mode === "plain"}
            onChange={() => setMode("plain")}
            data-testid="export-mode-plain"
          />
          Without credentials
        </label>
        <label className="export-dialog__radio-label">
          <input
            type="radio"
            name="export-mode"
            checked={mode === "encrypted"}
            onChange={() => setMode("encrypted")}
            data-testid="export-mode-encrypted"
          />
          With credentials (encrypted)
        </label>
      </fieldset>

      {mode === "encrypted" && (
        <div className="export-dialog__password-section">
          <p className="export-dialog__warning" data-testid="export-warning">
            Credentials will be encrypted with AES-256-GCM. You will need this password to import
            them on another machine.
          </p>
          <PasswordInput
            className="ui-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Encryption password (min 8 characters)"
            autoFocus
            data-testid="export-password"
          />
          <PasswordInput
            className="ui-input"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm password"
            data-testid="export-confirm-password"
          />
          {passwordError && (
            <p className="export-dialog__error" data-testid="export-password-error">
              {passwordError}
            </p>
          )}
        </div>
      )}

      {error && <p className="export-dialog__error">{error}</p>}
    </Modal>
  );
}
