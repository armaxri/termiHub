import { useState, useCallback } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { FilePlus2, Plus, Trash2, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { ExternalFileConfig } from "@/types/connection";

/**
 * External connection file management, extracted from SettingsPanel.
 */
export function ExternalFilesSettings() {
  const settings = useAppStore((s) => s.settings);
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
      console.error("Failed to create external connection file:", err);
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
    <div className="settings-panel__category">
      <div className="settings-panel__section">
        <div className="settings-panel__section-header">
          <h3 className="settings-panel__section-title">External Connection Files</h3>
          <div className="settings-panel__section-actions">
            <button
              className="settings-panel__btn"
              onClick={handleReload}
              disabled={reloading}
              title="Reload all external files"
            >
              <RefreshCw size={14} className={reloading ? "settings-panel__spin" : ""} />
              Reload
            </button>
            <button
              className="settings-panel__btn"
              onClick={() => setShowCreatePrompt((v) => !v)}
              title="Create a new external connection file from your current connections"
            >
              <FilePlus2 size={14} />
              Create File
            </button>
            <button
              className="settings-panel__btn settings-panel__btn--primary"
              onClick={handleAddFile}
              title="Add external connection file"
            >
              <Plus size={14} />
              Add File
            </button>
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
            <button
              className="settings-panel__btn settings-panel__btn--primary"
              onClick={handleCreateFile}
              disabled={!createName.trim()}
            >
              Save
            </button>
            <button className="settings-panel__btn" onClick={() => setShowCreatePrompt(false)}>
              Cancel
            </button>
          </div>
        )}
        {settings.externalConnectionFiles.length === 0 ? (
          <div className="settings-panel__empty">No external connection files configured.</div>
        ) : (
          <ul className="settings-panel__file-list">
            {settings.externalConnectionFiles.map((file) => (
              <li key={file.path} className="settings-panel__file-item">
                <label className="settings-panel__toggle">
                  <input
                    type="checkbox"
                    checked={file.enabled}
                    onChange={() => handleToggleFile(file.path)}
                  />
                  <span className="settings-panel__toggle-slider" />
                </label>
                <span
                  className={`settings-panel__file-path${!file.enabled ? " settings-panel__file-path--disabled" : ""}`}
                  title={file.path}
                >
                  {file.path}
                </span>
                <button
                  className="settings-panel__file-remove"
                  onClick={() => handleRemoveFile(file.path)}
                  title="Remove file"
                >
                  <Trash2 size={14} />
                </button>
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
        <ul className="settings-panel__file-list">
          <li className="settings-panel__file-item">
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                checked={settings.powerMonitoringEnabled}
                onChange={() =>
                  updateSettings({
                    ...settings,
                    powerMonitoringEnabled: !settings.powerMonitoringEnabled,
                  })
                }
                data-testid="toggle-power-monitoring"
              />
              <span className="settings-panel__toggle-slider" />
            </label>
            <span className="settings-panel__file-path">Power Monitoring</span>
          </li>
          <li className="settings-panel__file-item">
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                checked={settings.fileBrowserEnabled}
                onChange={() =>
                  updateSettings({
                    ...settings,
                    fileBrowserEnabled: !settings.fileBrowserEnabled,
                  })
                }
                data-testid="toggle-file-browser"
              />
              <span className="settings-panel__toggle-slider" />
            </label>
            <span className="settings-panel__file-path">File Browser</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
