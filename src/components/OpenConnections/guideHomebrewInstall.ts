import { listAvailableShells } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { ShellType } from "@/types/terminal";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Open a local terminal tab pre-loaded with the official Homebrew installer so
 * the user can drive the real `sudo` / RETURN prompts themselves (#1117). Used on
 * the macOS X-server setup path when XQuartz's automatic install needs Homebrew
 * but it isn't installed. Once Homebrew is installed, retrying the XQuartz
 * install re-detects `brew` and proceeds with `brew install --cask xquartz`.
 *
 * The installer command originates in the Rust `XServerError::homebrew_required`
 * (`installCommand`), so termiHub keeps a single source of truth for it.
 *
 * @param command The Homebrew installer command to run in the new terminal.
 * @throws if no local shell is available to host the installer.
 */
export async function guideHomebrewInstall(command: string): Promise<void> {
  const shells = await listAvailableShells();
  if (shells.length === 0) {
    frontendLog("xserver", "no local shell available to guide Homebrew install");
    throw new Error("No local shell is available to run the Homebrew installer.");
  }
  useAppStore.getState().addTab("Install Homebrew", "local", {
    type: "local",
    config: { shell: shells[0] as ShellType, initialCommand: command },
  });
  frontendLog("xserver", "opened terminal for guided Homebrew install");
}
