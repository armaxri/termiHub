import { ShellType } from "@/types/terminal";

/**
 * Detect available shells on the current platform.
 * Phase 1: Returns mock data. Phase 2 will call Tauri backend.
 */
export function detectAvailableShells(): ShellType[] {
  // Phase 2: will use Tauri command to detect shells
  const platform = navigator.platform.toLowerCase();

  if (platform.includes("win")) {
    return ["powershell", "cmd", "gitbash"];
  }
  if (platform.includes("mac")) {
    return ["zsh", "bash"];
  }
  // Linux
  return ["bash", "zsh"];
}

/** Get the default shell for the current platform */
export function getDefaultShell(): ShellType {
  const shells = detectAvailableShells();
  return shells[0];
}
