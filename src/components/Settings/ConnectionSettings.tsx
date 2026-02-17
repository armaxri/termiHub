import { useState, useEffect } from "react";
import { LocalShellConfig, ShellType } from "@/types/terminal";
import { detectAvailableShells } from "@/utils/shell-detection";
import { getWslDistroName } from "@/utils/shell-detection";
import { useAppStore } from "@/store/appStore";

interface ConnectionSettingsProps {
  config: LocalShellConfig;
  onChange: (config: LocalShellConfig) => void;
}

const SHELL_LABELS: Record<string, string> = {
  bash: "Bash",
  zsh: "Zsh",
  cmd: "Command Prompt",
  powershell: "PowerShell",
  gitbash: "Git Bash",
};

/** Get the display label for a shell type, including WSL distros. */
function getShellLabel(shell: ShellType, defaultShell: ShellType): string {
  const distro = getWslDistroName(shell);
  let label: string;
  if (distro !== null) {
    label = `WSL: ${distro}`;
  } else {
    label = SHELL_LABELS[shell] ?? shell;
  }
  return shell === defaultShell ? `${label} (default)` : label;
}

export function ConnectionSettings({ config, onChange }: ConnectionSettingsProps) {
  const [availableShells, setAvailableShells] = useState<ShellType[]>([]);
  const defaultShell = useAppStore((s) => s.defaultShell);

  useEffect(() => {
    detectAvailableShells().then(setAvailableShells);
  }, []);

  // While loading, show at least the currently selected shell
  const options = availableShells.length > 0 ? availableShells : [config.shellType];

  return (
    <div className="settings-form">
      <label className="settings-form__field">
        <span className="settings-form__label">Shell</span>
        <select
          value={config.shellType}
          onChange={(e) => onChange({ ...config, shellType: e.target.value as ShellType })}
          data-testid="connection-settings-shell-select"
        >
          {options.map((shell) => (
            <option key={shell} value={shell}>
              {getShellLabel(shell, defaultShell)}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-form__field">
        <span className="settings-form__label">Starting Directory</span>
        <input
          type="text"
          value={config.startingDirectory ?? ""}
          onChange={(e) => onChange({ ...config, startingDirectory: e.target.value || undefined })}
          placeholder="Leave empty for home directory"
          data-testid="connection-settings-starting-directory"
        />
      </label>
    </div>
  );
}
