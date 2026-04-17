import { useState, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ExternalAgentFile } from "@/types/terminal";

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
    <div className="settings-form__field" data-testid="agent-external-files">
      <span className="settings-form__label">External Connection Files</span>
      <p className="settings-form__hint">
        Load shared connection configs from files on the remote host (e.g. from a git repo). Paths
        are absolute paths on the remote machine. Changes take effect on next reconnect.
      </p>
      {files.map((file) => (
        <div
          key={file.path}
          className="settings-form__list-row"
          data-testid="agent-external-file-row"
        >
          <label className="settings-form__list-checkbox">
            <input
              type="checkbox"
              checked={file.enabled}
              onChange={() => handleToggle(file.path)}
              data-testid={`agent-external-file-toggle`}
            />
          </label>
          <span
            className="settings-form__list-input"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              fontSize: "var(--font-size-sm)",
              color: file.enabled ? "var(--text-primary)" : "var(--text-secondary)",
            }}
            title={file.path}
          >
            {file.path}
          </span>
          <button
            className="settings-form__list-remove"
            onClick={() => handleRemove(file.path)}
            title="Remove file"
            data-testid={`agent-external-file-remove`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="settings-form__list-row">
        <input
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
        <button
          className="settings-form__list-browse"
          onClick={handleAdd}
          disabled={!newPath.trim()}
          data-testid="agent-external-file-add"
          title="Add external connection file path"
        >
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}
