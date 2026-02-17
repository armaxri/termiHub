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
 * Convert a Linux filesystem path to a Windows-accessible path for WSL.
 *
 * Paths under `/mnt/<letter>/` are Windows drive mounts — these are converted
 * directly to native Windows paths (e.g. `/mnt/c/Users` → `C:/Users`) to
 * avoid permission errors that occur when accessing Windows drives through
 * the `\\wsl$\` UNC share.
 *
 * All other paths use the `\\wsl$\<distro>` share for native WSL filesystem
 * access. Returns forward-slash paths since the backend normalizes separators.
 */
export function wslToWindowsPath(linuxPath: string, distro: string): string {
  const driveMatch = linuxPath.match(/^\/mnt\/([a-z])(\/.*)?$/);
  if (driveMatch) {
    const driveLetter = driveMatch[1].toUpperCase();
    const rest = driveMatch[2] ?? "/";
    return `${driveLetter}:${rest}`;
  }
  return `//wsl$/${distro}${linuxPath}`;
}
