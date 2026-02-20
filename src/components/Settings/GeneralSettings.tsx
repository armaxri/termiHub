import { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AppSettings } from "@/types/connection";
import { ShellType } from "@/types/terminal";
import { detectAvailableShells } from "@/utils/shell-detection";
import { getWslDistroName } from "@/utils/shell-detection";
import { useAppStore } from "@/store/appStore";
import { getHomeDir } from "@/services/api";

const SHELL_LABELS: Record<string, string> = {
  bash: "Bash",
  zsh: "Zsh",
  cmd: "Command Prompt",
  powershell: "PowerShell",
  gitbash: "Git Bash",
};

function getShellLabel(shell: ShellType, defaultShell: ShellType): string {
  const distro = getWslDistroName(shell);
  let label: string;
  if (distro !== null) {
    label = `WSL: ${distro}`;
  } else {
    label = SHELL_LABELS[shell] ?? shell;
  }
  return shell === defaultShell ? `${label} (platform default)` : label;
}

interface GeneralSettingsProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  visibleFields?: Set<string>;
}

export function GeneralSettings({ settings, onChange, visibleFields }: GeneralSettingsProps) {
  const [availableShells, setAvailableShells] = useState<ShellType[]>([]);
  const platformDefaultShell = useAppStore((s) => s.defaultShell);

  useEffect(() => {
    detectAvailableShells().then(setAvailableShells);
  }, []);

  const handleBrowseSshKey = useCallback(async () => {
    let defaultPath: string | undefined;
    try {
      const home = await getHomeDir();
      defaultPath = `${home}/.ssh`;
    } catch {
      // Fall through
    }
    const selected = await open({
      multiple: false,
      title: "Select default SSH private key",
      defaultPath,
    });
    if (selected) {
      onChange({ ...settings, defaultSshKeyPath: selected as string });
    }
  }, [settings, onChange]);

  const show = (field: string) => !visibleFields || visibleFields.has(field);

  return (
    <div className="settings-panel__category">
      <h3 className="settings-panel__category-title">General</h3>
      {show("defaultUser") && (
        <label className="settings-form__field">
          <span className="settings-form__label">Default User</span>
          <input
            type="text"
            value={settings.defaultUser ?? ""}
            onChange={(e) => onChange({ ...settings, defaultUser: e.target.value || undefined })}
            placeholder="e.g. admin"
          />
          <span className="settings-form__hint">
            Default username pre-filled for new SSH connections.
          </span>
        </label>
      )}
      {show("defaultSshKeyPath") && (
        <div className="settings-form__field">
          <span className="settings-form__label">Default SSH Key Path</span>
          <div className="settings-form__file-row">
            <input
              type="text"
              value={settings.defaultSshKeyPath ?? ""}
              onChange={(e) =>
                onChange({ ...settings, defaultSshKeyPath: e.target.value || undefined })
              }
              placeholder="~/.ssh/id_ed25519"
            />
            <button
              type="button"
              className="settings-form__list-browse"
              onClick={handleBrowseSshKey}
              title="Browse"
            >
              ...
            </button>
          </div>
          <span className="settings-form__hint">
            Default private key path for SSH key authentication.
          </span>
        </div>
      )}
      {show("defaultShell") && (
        <label className="settings-form__field">
          <span className="settings-form__label">Default Shell</span>
          <select
            value={settings.defaultShell ?? ""}
            onChange={(e) => onChange({ ...settings, defaultShell: e.target.value || undefined })}
          >
            <option value="">Platform default ({getShellLabel(platformDefaultShell, platformDefaultShell).replace(" (platform default)", "")})</option>
            {availableShells.map((shell) => (
              <option key={shell} value={shell}>
                {getShellLabel(shell, platformDefaultShell)}
              </option>
            ))}
          </select>
          <span className="settings-form__hint">
            Default shell for new local terminal sessions.
          </span>
        </label>
      )}
    </div>
  );
}
