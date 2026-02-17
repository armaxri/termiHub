import { ShellType } from "@/types/terminal";
import { listAvailableShells } from "@/services/api";

/**
 * Detect available shells on the current platform via Tauri backend.
 */
export async function detectAvailableShells(): Promise<ShellType[]> {
  try {
    const shells = await listAvailableShells();
    return shells as ShellType[];
  } catch {
    // Fallback if backend is unavailable
    return ["bash", "zsh"];
  }
}

/** Get the default shell for the current platform */
export async function getDefaultShell(): Promise<ShellType> {
  const shells = await detectAvailableShells();
  return shells[0] ?? "bash";
}

/** Check whether a shell type represents a WSL distribution. */
export function isWslShell(shell: ShellType): boolean {
  return shell.startsWith("wsl:");
}

/** Extract the distro name from a WSL shell type, or null if not a WSL shell. */
export function getWslDistroName(shell: ShellType): string | null {
  if (!shell.startsWith("wsl:")) {
    return null;
  }
  return shell.slice(4);
}

/**
 * Convert a Linux filesystem path to a Windows UNC path for WSL access.
 * Uses the `\\wsl$\<distro>` share that Windows exposes for WSL filesystems.
 * Returns forward-slash UNC paths (e.g. `//wsl$/Ubuntu/home/user`) since
 * the backend normalizes all paths to forward slashes.
 */
export function wslToWindowsPath(linuxPath: string, distro: string): string {
  return `//wsl$/${distro}${linuxPath}`;
}
