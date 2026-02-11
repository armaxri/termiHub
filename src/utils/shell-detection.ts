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
