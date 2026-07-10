import { frontendLog } from "@/utils/frontendLog";
import { openLocalCommandTab } from "@/utils/openLocalCommandTab";

/**
 * Open a local terminal tab pre-loaded with a dependency's installer so the user
 * can drive its interactive `sudo` / RETURN prompts themselves — the recovery for
 * a `guidedTerminal` install-mode error (#1309, generalized in #1312). Today's
 * only case is the macOS brew-absent path: `command` is the official Homebrew
 * installer, and once it finishes a retry re-detects `brew` and installs XQuartz.
 *
 * Both the command and the tab title come from the caller (ultimately the Rust
 * `XServerError` payload), so termiHub keeps a single source of truth and nothing
 * here is dependency-specific.
 *
 * @param command The installer command to run in the new terminal.
 * @param tabTitle The title for the terminal tab (e.g. `Install Homebrew`).
 * @throws if no local shell is available to host the installer.
 */
export async function guideTerminalInstall(command: string, tabTitle: string): Promise<void> {
  const opened = await openLocalCommandTab(tabTitle, command);
  if (!opened) {
    frontendLog("xserver", "no local shell available to guide terminal install");
    throw new Error("No local shell is available to run the installer.");
  }
  frontendLog("xserver", "opened terminal for guided install");
}
