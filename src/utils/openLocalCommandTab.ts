import { listAvailableShells } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { ShellType } from "@/types/terminal";

/**
 * Open a new local terminal tab pre-loaded with `command`, which runs once the
 * shell connects (via the backend's `initialCommand` injection). Picks the first
 * available local shell.
 *
 * @param title Tab title.
 * @param command Command line to run in the new terminal.
 * @returns `true` if a tab was opened, `false` when no local shell is available
 *   to host the command (callers decide whether that is silent or an error).
 */
export async function openLocalCommandTab(title: string, command: string): Promise<boolean> {
  const shells = await listAvailableShells();
  if (shells.length === 0) return false;
  useAppStore.getState().addTab(title, "local", {
    type: "local",
    config: { shell: shells[0] as ShellType, initialCommand: command },
  });
  return true;
}
