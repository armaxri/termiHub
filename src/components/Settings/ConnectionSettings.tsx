import { useState, useEffect } from "react";
import { LocalShellConfig, ShellType } from "@/types/terminal";
import { detectAvailableShells } from "@/utils/shell-detection";

interface ConnectionSettingsProps {
  config: LocalShellConfig;
  onChange: (config: LocalShellConfig) => void;
}

const SHELL_LABELS: Record<ShellType, string> = {
  bash: "Bash",
  zsh: "Zsh",
  cmd: "Command Prompt",
  powershell: "PowerShell",
  gitbash: "Git Bash",
};

export function ConnectionSettings({ config, onChange }: ConnectionSettingsProps) {
  const [availableShells, setAvailableShells] = useState<ShellType[]>([]);

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
        >
          {options.map((shell) => (
            <option key={shell} value={shell}>
              {SHELL_LABELS[shell] ?? shell}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
