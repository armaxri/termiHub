import { useState, useCallback } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { FilePlus2, Plus, Trash2, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { ExternalFileConfig } from "@/types/connection";
import { Button, Toggle, Tooltip } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
import { SettingsField } from "./SettingsField";

/**
 * External connection file management, extracted from SettingsPanel.
 */
export function ExternalFilesSettings() {
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);
  const reloadExternalConnections = useAppStore((s) => s.reloadExternalConnections);
  const [reloading, setReloading] = useState(false);
  const [showCreatePrompt, setShowCreatePrompt] = useState(false);
  const [createName, setCreateName] = useState("Shared Connections");

  const handleCreateFile = useCallback(async () => {
    const name = createName.trim();
    if (!name) return;

    try {
      const emptyStore = { name, version: "1", folders: [], connections: [] };
      const output = JSON.stringify(emptyStore, null, 2);

      const filePath = await save({
        defaultPath: "shared-connections.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;

      await writeTextFile(filePath, output);
      setShowCreatePrompt(false);

      // Auto-add the newly created file to the list
      if (!settings.externalConnectionFiles.some((f) => f.path === filePath)) {
        const newFiles: ExternalFileConfig[] = [
          ...settings.externalConnectionFiles,
          { path: filePath, enabled: true },
        ];
        const newSettings = { ...settings, externalConnectionFiles: newFiles };
        await updateSettings(newSettings);
        await reloadExternalConnections();
      }
    } catch (err) {
      frontendLog("external-files", `Failed to create external connection file: ${err}`);
      throw err;
    }
  }, [createName, settings, updateSettings, reloadExternalConnections]);

  const handleAddFile = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;

    // Don't add duplicates
    if (settings.externalConnectionFiles.some((f) => f.path === path)) return;

    const newFiles: ExternalFileConfig[] = [
      ...settings.externalConnectionFiles,
      { path, enabled: true },
    ];
    const newSettings = { ...settings, externalConnectionFiles: newFiles };
    await updateSettings(newSettings);
    await reloadExternalConnections();
  }, [settings, updateSettings, reloadExternalConnections]);

  const handleRemoveFile = useCallback(
    async (path: string) => {
      const newFiles = settings.externalConnectionFiles.filter((f) => f.path !== path);
      const newSettings = { ...settings, externalConnectionFiles: newFiles };
      await updateSettings(newSettings);
      await reloadExternalConnections();
    },
    [settings, updateSettings, reloadExternalConnections]
  );

  const handleToggleFile = useCallback(
    async (path: string) => {
      const newFiles = settings.externalConnectionFiles.map((f) =>
        f.path === path ? { ...f, enabled: !f.enabled } : f
      );
      const newSettings = { ...settings, externalConnectionFiles: newFiles };
      await updateSettings(newSettings);
      await reloadExternalConnections();
    },
    [settings, updateSettings, reloadExternalConnections]
  );

  const handleReload = useCallback(async () => {
    setReloading(true);
    await reloadExternalConnections();
    setReloading(false);
  }, [reloadExternalConnections]);

  return (
    <div className="settings-panel__category" data-testid="settings-external-files">
      <div className="settings-panel__section">
        <div className="settings-panel__section-header">
          <h3 className="settings-panel__section-title">External Connection Files</h3>
          <div className="settings-panel__section-actions">
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={14} className={reloading ? "settings-panel__spin" : ""} />}
              onClick={handleReload}
              disabled={reloading}
              title="Reload all external files"
            >
              Reload
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<FilePlus2 size={14} />}
              onClick={() => setShowCreatePrompt((v) => !v)}
              title="Create a new external connection file from your current connections"
            >
              Create File
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={14} />}
              onClick={handleAddFile}
              title="Add external connection file"
              data-testid="external-files-add"
            >
              Add File
            </Button>
          </div>
        </div>
        <p className="settings-panel__description">
          Load shared connection configs from external JSON files (e.g. from a git repo). External
          connections appear in the unified connection list alongside local connections.
        </p>
        {showCreatePrompt && (
          <div className="settings-panel__create-prompt">
            <label className="settings-panel__create-label">Display name:</label>
            <input
              className="settings-panel__create-input"
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFile();
                if (e.key === "Escape") setShowCreatePrompt(false);
              }}
              placeholder="e.g. Test Farm Connections"
              autoFocus
            />
            <Button
              variant="primary"
              size="sm"
              onClick={handleCreateFile}
              disabled={!createName.trim()}
            >
              Save
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setShowCreatePrompt(false)}>
              Cancel
            </Button>
          </div>
        )}
        {settings.externalConnectionFiles.length === 0 ? (
          <div className="settings-panel__empty">No external connection files configured.</div>
        ) : (
          <ul className="settings-panel__file-list">
            {settings.externalConnectionFiles.map((file) => (
              <li key={file.path} className="settings-panel__file-item">
                <Toggle
                  aria-label={`Toggle external file ${file.path}`}
                  checked={file.enabled}
                  onCheckedChange={() => handleToggleFile(file.path)}
                />
                <span
                  className={`settings-panel__file-path settings-panel__file-path--rtl${!file.enabled ? " settings-panel__file-path--disabled" : ""}`}
                  title={file.path}
                >
                  {file.path}
                </span>
                <Tooltip content="Remove file">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<Trash2 size={14} />}
                    onClick={() => handleRemoveFile(file.path)}
                    aria-label="Remove file"
                  />
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="settings-panel__section">
        <div className="settings-panel__section-header">
          <h3 className="settings-panel__section-title">Advanced</h3>
        </div>
        <p className="settings-panel__description">
          Default settings for new SSH connections. Individual connections can override these in
          their SSH settings. Disabling a default disconnects active sessions that use the default.
        </p>
        <SettingsField
          label="Power Monitoring"
          hint="Monitor CPU, memory, and power events via SSH agent connections."
        >
          <Toggle
            checked={settings.powerMonitoringEnabled}
            onCheckedChange={() =>
              updateSettings({
                ...settings,
                powerMonitoringEnabled: !settings.powerMonitoringEnabled,
              })
            }
            data-testid="toggle-power-monitoring"
          />
        </SettingsField>

        <SettingsField
          label="File Browser"
          hint="Enable the SFTP file browser for SSH agent sessions."
        >
          <Toggle
            checked={settings.fileBrowserEnabled}
            onCheckedChange={() =>
              updateSettings({
                ...settings,
                fileBrowserEnabled: !settings.fileBrowserEnabled,
              })
            }
            data-testid="toggle-file-browser"
          />
        </SettingsField>
      </div>
    </div>
  );
}
