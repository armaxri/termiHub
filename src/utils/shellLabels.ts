import { ShellType } from "@/types/terminal";
import { getWslDistroName } from "@/utils/shell-detection";

/** Human-readable names for the local shell kinds reported by the backend. */
export const SHELL_LABELS: Record<string, string> = {
  bash: "Bash",
  zsh: "Zsh",
  cmd: "Command Prompt",
  // `powershell` stays "PowerShell" so saved connections read as before; on
  // Windows it is Windows PowerShell 5.1, next to `pwsh` (PowerShell 7, #3728).
  powershell: "PowerShell",
  pwsh: "PowerShell 7",
  gitbash: "Git Bash",
  fish: "Fish",
  nushell: "Nushell",
  custom: "Custom",
};

/** Label a shell for a picker, marking the platform default. */
export function getShellLabel(shell: ShellType, defaultShell: ShellType): string {
  const distro = getWslDistroName(shell);
  const label = distro !== null ? `WSL: ${distro}` : (SHELL_LABELS[shell] ?? shell);
  return shell === defaultShell ? `${label} (platform default)` : label;
}
