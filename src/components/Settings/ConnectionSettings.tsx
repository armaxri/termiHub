import { LocalShellConfig, ShellType } from "@/types/terminal";

interface ConnectionSettingsProps {
  config: LocalShellConfig;
  onChange: (config: LocalShellConfig) => void;
}

const SHELL_OPTIONS: { value: ShellType; label: string }[] = [
  { value: "bash", label: "Bash" },
  { value: "zsh", label: "Zsh" },
  { value: "cmd", label: "Command Prompt" },
  { value: "powershell", label: "PowerShell" },
  { value: "gitbash", label: "Git Bash" },
];

export function ConnectionSettings({ config, onChange }: ConnectionSettingsProps) {
  return (
    <div className="settings-form">
      <label className="settings-form__field">
        <span className="settings-form__label">Shell</span>
        <select
          value={config.shellType}
          onChange={(e) => onChange({ ...config, shellType: e.target.value as ShellType })}
        >
          {SHELL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
