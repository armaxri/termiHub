import { useState, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ExternalAgentFile } from "@/types/terminal";
import { Button, Input, Toggle } from "@/components/ui";

interface AgentExternalFilesSettingsProps {
  files: ExternalAgentFile[];
  onChange: (files: ExternalAgentFile[]) => void;
}

/**
 * UI for managing external connection file paths on a remote agent.
 *
 * Unlike the local ExternalFilesSettings, paths are entered manually (no file
 * picker) because the paths refer to locations on the remote host machine.
 * Changes take effect on the next reconnect.
 */
export function AgentExternalFilesSettings({ files, onChange }: AgentExternalFilesSettingsProps) {
  const [newPath, setNewPath] = useState("");

  const handleAdd = useCallback(() => {
    const trimmed = newPath.trim();
    if (!trimmed) return;
    if (files.some((f) => f.path === trimmed)) {
      setNewPath("");
      return;
    }
    onChange([...files, { path: trimmed, enabled: true }]);
    setNewPath("");
  }, [newPath, files, onChange]);

  const handleRemove = useCallback(
    (path: string) => {
      onChange(files.filter((f) => f.path !== path));
    },
    [files, onChange]
  );

  const handleToggle = useCallback(
    (path: string) => {
      onChange(files.map((f) => (f.path === path ? { ...f, enabled: !f.enabled } : f)));
    },
    [files, onChange]
  );

  return (
    <div className="settings-panel__category" data-testid="agent-external-files">
      <h3 className="settings-panel__category-title">External Connection Files</h3>
      <p className="settings-form__hint">
        Load shared connection configs from files on the remote host (e.g. from a git repo). Paths
        are absolute paths on the remote machine. Changes take effect on next reconnect.
      </p>

      {files.length > 0 && (
        <ul className="settings-panel__file-list">
          {files.map((file) => (
            <li
              key={file.path}
              className="settings-panel__file-item"
              data-testid="agent-external-file-row"
            >
              <Toggle
                checked={file.enabled}
                onCheckedChange={() => handleToggle(file.path)}
                aria-label={`Toggle ${file.path}`}
                data-testid="agent-external-file-toggle"
              />
              <span
                className={`settings-panel__file-path settings-panel__file-path--rtl${!file.enabled ? " settings-panel__file-path--disabled" : ""}`}
                title={file.path}
              >
                {file.path}
              </span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Trash2 size={14} />}
                onClick={() => handleRemove(file.path)}
                title="Remove file"
                aria-label="Remove file"
                data-testid="agent-external-file-remove"
              />
            </li>
          ))}
        </ul>
      )}

      <div className="settings-form__list-row" style={{ marginTop: "var(--spacing-sm)" }}>
        <Input
          type="text"
          className="settings-form__list-input"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
          placeholder="/home/user/team-connections.json"
          data-testid="agent-external-file-input"
        />
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={12} />}
          onClick={handleAdd}
          disabled={!newPath.trim()}
          data-testid="agent-external-file-add"
          title="Add external connection file path"
          aria-label="Add external connection file path"
        />
      </div>
    </div>
  );
}
