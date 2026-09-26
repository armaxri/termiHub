import { useState, useCallback, useEffect } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { exportConnectionsEncrypted } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Modal, Button, RadioGroup } from "@/components/ui";
import "./ExportDialog.css";
import { errorMessage } from "@/utils/errorMessage";

type ExportMode = "plain" | "encrypted";

export function ExportDialog() {
  const open = useAppStore((s) => s.exportDialogOpen);
  const setOpen = useAppStore((s) => s.setExportDialogOpen);
  const storeMode = useAppStore((s) => s.credentialStoreStatus?.mode ?? "none");

  const [mode, setMode] = useState<ExportMode>("plain");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [masterPassword, setMasterPassword] = useState("");
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  // Reset the form and clear every secret whenever the dialog opens or closes.
  useEffect(() => {
    setMode("plain");
    setPassword("");
    setConfirmPassword("");
    setMasterPassword("");
    setError("");
    setExporting(false);
  }, [open]);

  // Exporting credentials from a master-password store re-authenticates, the
  // same as the credential-vault export (#3598). OS-keychain mode is verified
  // by the OS in the backend instead.
  const needsMasterPassword = mode === "encrypted" && storeMode === "master_password";

  const passwordValid =
    mode === "plain" ||
    (password.length >= 8 &&
      password === confirmPassword &&
      (!needsMasterPassword || masterPassword.length > 0));

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
      const json = await exportConnectionsEncrypted(
        exportPassword,
        null,
        needsMasterPassword ? masterPassword : null
      );

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
      setError(errorMessage(err));
    } finally {
      // The master password is single-use: never keep it past an attempt.
      setMasterPassword("");
      setExporting(false);
    }
  }, [mode, password, masterPassword, needsMasterPassword, passwordValid, setOpen]);

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
      <RadioGroup
        className="export-dialog__fieldset"
        value={mode}
        onValueChange={(v) => setMode(v as ExportMode)}
        aria-label="Export mode"
        options={[
          {
            value: "plain",
            label: "Without credentials",
            "data-testid": "export-mode-plain",
          },
          {
            value: "encrypted",
            label: "With credentials (encrypted)",
            "data-testid": "export-mode-encrypted",
          },
        ]}
      />

      {mode === "plain" && (
        <p className="export-dialog__warning" data-testid="export-plain-hint">
          Shared credentials are exported by name only — the importing machine asks for their
          secrets. Choose "With credentials" to include them.
        </p>
      )}

      {mode === "encrypted" && (
        <div className="export-dialog__password-section">
          <p className="export-dialog__warning" data-testid="export-warning">
            Credentials, including the shared credentials these connections use, will be encrypted
            with AES-256-GCM. You will need this password to import them on another machine.
          </p>
          {needsMasterPassword && (
            <PasswordInput
              className="ui-input"
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              placeholder="Current master password"
              aria-label="Current master password"
              autoFocus
              data-testid="export-master-password"
            />
          )}
          <PasswordInput
            className="ui-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Encryption password (min 8 characters)"
            aria-label="Encryption password"
            autoFocus={!needsMasterPassword}
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

      {error && (
        <p className="export-dialog__error" role="alert" data-testid="export-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
