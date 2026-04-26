import { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, XCircle, HardDrive, Info } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { listConfigFiles, exportConfigToPortable, importConfigFromPortable } from "@/services/api";
import type { ConfigFileStatus } from "@/types/connection";
import "./PortableModeSettings.css";

const PORTABLE_FILES = [
  "connections.json",
  "settings.json",
  "tunnels.json",
  "credentials.enc",
  "workspaces.json",
];

interface MigrationDialogProps {
  title: string;
  description: string;
  targetDirLabel: string;
  targetDir: string;
  onConfirm: (selectedFiles: string[]) => Promise<void>;
  onCancel: () => void;
  isRunning: boolean;
  sourceFiles: ConfigFileStatus[];
}

function MigrationDialog({
  title,
  description,
  targetDirLabel,
  targetDir,
  onConfirm,
  onCancel,
  isRunning,
  sourceFiles,
}: MigrationDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(sourceFiles.filter((f) => f.present).map((f) => f.name))
  );

  const toggle = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  return (
    <div className="settings-panel__inline-dialog" data-testid="migration-dialog">
      <h4 className="settings-panel__inline-dialog-title">{title}</h4>
      <p className="settings-panel__inline-dialog-text">{description}</p>

      <div className="portable-mode__migration-files">
        {sourceFiles.map((f) => (
          <label
            key={f.name}
            className={`portable-mode__migration-file${!f.present ? " portable-mode__migration-file--missing" : ""}`}
          >
            <input
              type="checkbox"
              checked={selected.has(f.name)}
              disabled={!f.present || isRunning}
              onChange={() => toggle(f.name)}
            />
            <span className="portable-mode__migration-filename">{f.name}</span>
            {!f.present && <span className="portable-mode__migration-absent">not found</span>}
          </label>
        ))}
      </div>

      <div className="portable-mode__migration-dest">
        <span className="portable-mode__migration-dest-label">{targetDirLabel}:</span>
        <code className="portable-mode__migration-dest-path">{targetDir}</code>
      </div>

      <div className="settings-panel__inline-dialog-actions">
        <button
          className="settings-panel__btn"
          onClick={onCancel}
          disabled={isRunning}
          data-testid="migration-cancel"
        >
          Cancel
        </button>
        <button
          className="settings-panel__btn settings-panel__btn--primary"
          onClick={() => onConfirm(Array.from(selected))}
          disabled={selected.size === 0 || isRunning}
          data-testid="migration-confirm"
        >
          {isRunning ? "Copying…" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/**
 * Settings section for portable mode status and config migration.
 */
export function PortableModeSettings() {
  const isPortableMode = useAppStore((s) => s.isPortableMode);
  const portableDataDir = useAppStore((s) => s.portableDataDir);

  const [configFiles, setConfigFiles] = useState<ConfigFileStatus[]>([]);
  const [exportDialog, setExportDialog] = useState(false);
  const [importDialog, setImportDialog] = useState(false);
  const [migrationTarget, setMigrationTarget] = useState<string>("");
  const [migrationTargetFiles, setMigrationTargetFiles] = useState<ConfigFileStatus[]>([]);
  const [migrating, setMigrating] = useState(false);
  const [migrationResult, setMigrationResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (isPortableMode && portableDataDir) {
      listConfigFiles(portableDataDir)
        .then(setConfigFiles)
        .catch(() => {});
    }
  }, [isPortableMode, portableDataDir]);

  const handleExport = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (!dir) return;
    const destDir = typeof dir === "string" ? dir : dir[0];
    const files = await listConfigFiles(destDir);
    setMigrationTarget(destDir);
    setMigrationTargetFiles(files);
    setExportDialog(true);
    setMigrationResult(null);
  }, []);

  const handleImport = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (!dir) return;
    const srcDir = typeof dir === "string" ? dir : dir[0];
    const files = await listConfigFiles(srcDir);
    setMigrationTarget(srcDir);
    setMigrationTargetFiles(files);
    setImportDialog(true);
    setMigrationResult(null);
  }, []);

  const handleExportConfirm = useCallback(
    async (selectedFiles: string[]) => {
      setMigrating(true);
      try {
        const result = await exportConfigToPortable(migrationTarget, selectedFiles);
        setExportDialog(false);
        const warns = result.warnings.length > 0 ? ` (${result.warnings.join(", ")})` : "";
        setMigrationResult({
          success: true,
          message: `Copied ${result.filesCopied.length} file(s) to ${migrationTarget}${warns}`,
        });
      } catch (err) {
        setMigrationResult({ success: false, message: String(err) });
      } finally {
        setMigrating(false);
      }
    },
    [migrationTarget]
  );

  const handleImportConfirm = useCallback(
    async (selectedFiles: string[]) => {
      setMigrating(true);
      try {
        const result = await importConfigFromPortable(migrationTarget, selectedFiles);
        setImportDialog(false);
        const warns = result.warnings.length > 0 ? ` (${result.warnings.join(", ")})` : "";
        setMigrationResult({
          success: true,
          message: `Copied ${result.filesCopied.length} file(s) from ${migrationTarget}${warns}`,
        });
      } catch (err) {
        setMigrationResult({ success: false, message: String(err) });
      } finally {
        setMigrating(false);
      }
    },
    [migrationTarget]
  );

  return (
    <div className="settings-panel__category" data-testid="portable-mode-settings">
      <h3 className="settings-panel__category-title">Portable Mode</h3>

      <div className="portable-mode__kv-row">
        <span className="portable-mode__kv-label">Status</span>
        <span
          className={`portable-mode__kv-value ${isPortableMode ? "portable-mode__kv-value--active" : "portable-mode__kv-value--inactive"}`}
          data-testid="portable-mode-status"
        >
          <HardDrive size={14} />
          {isPortableMode ? "Active" : "Inactive (installed mode)"}
        </span>
      </div>

      {isPortableMode && portableDataDir && (
        <>
          <div className="portable-mode__kv-row">
            <span className="portable-mode__kv-label">Data path</span>
            <code
              className="portable-mode__kv-value portable-mode__kv-value--path"
              data-testid="portable-data-dir"
            >
              {portableDataDir}
            </code>
          </div>

          <div className="portable-mode__info-box">
            <Info size={14} />
            <span>
              termiHub detected a <code>portable.marker</code> file or <code>data/</code> directory
              next to the executable and is storing all data in the data/ directory alongside the
              app.
            </span>
          </div>

          <div className="settings-panel__section">
            <h4 className="settings-panel__section-title">Config Files</h4>
            <ul className="portable-mode__file-list">
              {configFiles.map((f) => (
                <li key={f.name} className="portable-mode__file-item">
                  {f.present ? (
                    <CheckCircle2 size={13} className="portable-mode__file-icon--present" />
                  ) : (
                    <XCircle size={13} className="portable-mode__file-icon--absent" />
                  )}
                  <span className="portable-mode__file-name">{f.name}</span>
                  <span className="portable-mode__file-status">
                    {f.present ? "present" : "not created yet"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {!isPortableMode && (
        <div className="portable-mode__info-box">
          <Info size={14} />
          <span>
            termiHub is running in installed mode. To enable portable mode, place a{" "}
            <code>portable.marker</code> file or <code>data/</code> directory next to the executable
            and restart.
          </span>
        </div>
      )}

      {migrationResult && (
        <div
          className={`portable-mode__result ${migrationResult.success ? "portable-mode__result--success" : "portable-mode__result--error"}`}
          data-testid="migration-result"
        >
          {migrationResult.success ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {migrationResult.message}
        </div>
      )}

      <div className="settings-panel__section">
        <h4 className="settings-panel__section-title">Config Migration</h4>
        <p className="settings-panel__description">
          Copy configuration between installed and portable mode. Use Export to move your config to
          a portable drive, or Import to bring it back.
        </p>
        <div className="portable-mode__actions">
          <button
            className="settings-panel__btn"
            onClick={handleExport}
            data-testid="export-config-btn"
          >
            Export to Directory
          </button>
          <button
            className="settings-panel__btn"
            onClick={handleImport}
            data-testid="import-config-btn"
          >
            Import from Directory
          </button>
        </div>
      </div>

      {exportDialog && (
        <MigrationDialog
          title="Export Config to Portable"
          description="Copy the current config files to a portable data directory."
          targetDirLabel="Destination"
          targetDir={migrationTarget}
          sourceFiles={PORTABLE_FILES.map((name) => ({
            name,
            present: !migrationTargetFiles.some((f) => f.name === name && f.present),
          }))}
          onConfirm={handleExportConfirm}
          onCancel={() => setExportDialog(false)}
          isRunning={migrating}
        />
      )}

      {importDialog && (
        <MigrationDialog
          title="Import Config from Portable"
          description="Copy config files from a portable data directory into the current config location."
          targetDirLabel="Source"
          targetDir={migrationTarget}
          sourceFiles={migrationTargetFiles}
          onConfirm={handleImportConfirm}
          onCancel={() => setImportDialog(false)}
          isRunning={migrating}
        />
      )}
    </div>
  );
}
