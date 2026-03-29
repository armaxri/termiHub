import { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, XCircle, HardDrive, Info } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { listConfigFiles, exportConfigToPortable, importConfigFromPortable } from "@/services/api";
import type { ConfigFileStatus } from "@/types/connection";

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
    <div className="settings-section__migration-dialog" data-testid="migration-dialog">
      <h4 className="settings-section__migration-title">{title}</h4>
      <p className="settings-section__migration-description">{description}</p>
      <div className="settings-section__migration-files">
        {sourceFiles.map((f) => (
          <label
            key={f.name}
            className={`settings-section__migration-file ${!f.present ? "settings-section__migration-file--missing" : ""}`}
          >
            <input
              type="checkbox"
              checked={selected.has(f.name)}
              disabled={!f.present || isRunning}
              onChange={() => toggle(f.name)}
            />
            <span className="settings-section__migration-filename">{f.name}</span>
            {!f.present && <span className="settings-section__migration-absent">not found</span>}
          </label>
        ))}
      </div>
      <div className="settings-section__migration-dest">
        <span className="settings-section__migration-dest-label">{targetDirLabel}:</span>
        <code className="settings-section__migration-dest-path">{targetDir}</code>
      </div>
      <div className="settings-section__migration-actions">
        <button
          className="settings-section__btn settings-section__btn--secondary"
          onClick={onCancel}
          disabled={isRunning}
          data-testid="migration-cancel"
        >
          Cancel
        </button>
        <button
          className="settings-section__btn settings-section__btn--primary"
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
    // Pick the destination portable data directory
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
    // Pick the source portable data directory
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
    <div className="settings-section" data-testid="portable-mode-settings">
      <h3 className="settings-section__title">Portable Mode</h3>

      <div className="settings-section__row">
        <span className="settings-section__label">Status</span>
        <span
          className={`settings-section__value ${isPortableMode ? "settings-section__value--active" : "settings-section__value--inactive"}`}
          data-testid="portable-mode-status"
        >
          <HardDrive size={14} />
          {isPortableMode ? "Active" : "Inactive (installed mode)"}
        </span>
      </div>

      {isPortableMode && portableDataDir && (
        <>
          <div className="settings-section__row">
            <span className="settings-section__label">Data path</span>
            <code
              className="settings-section__value settings-section__value--path"
              data-testid="portable-data-dir"
            >
              {portableDataDir}
            </code>
          </div>

          <div className="settings-section__info-box">
            <Info size={14} />
            <span>
              termiHub detected a <code>portable.marker</code> file or <code>data/</code> directory
              next to the executable and is storing all data in the data/ directory alongside the
              app.
            </span>
          </div>

          <div className="settings-section__subsection">
            <h4 className="settings-section__subtitle">Config Files</h4>
            <div className="settings-section__file-list">
              {configFiles.map((f) => (
                <div key={f.name} className="settings-section__file-item">
                  {f.present ? (
                    <CheckCircle2 size={13} className="settings-section__file-icon--present" />
                  ) : (
                    <XCircle size={13} className="settings-section__file-icon--absent" />
                  )}
                  <span className="settings-section__file-name">{f.name}</span>
                  <span className="settings-section__file-status">
                    {f.present ? "present" : "not created yet"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {!isPortableMode && (
        <div className="settings-section__info-box">
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
          className={`settings-section__migration-result ${migrationResult.success ? "settings-section__migration-result--success" : "settings-section__migration-result--error"}`}
          data-testid="migration-result"
        >
          {migrationResult.success ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {migrationResult.message}
        </div>
      )}

      <div className="settings-section__actions">
        <button
          className="settings-section__btn settings-section__btn--secondary"
          onClick={handleExport}
          data-testid="export-config-btn"
        >
          Export Config to Directory
        </button>
        <button
          className="settings-section__btn settings-section__btn--secondary"
          onClick={handleImport}
          data-testid="import-config-btn"
        >
          Import Config from Directory
        </button>
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
