import { openUrl } from "@tauri-apps/plugin-opener";
import { GIT_FOR_WINDOWS_DOWNLOAD_URL, GIT_FOR_WINDOWS_WINGET_COMMAND } from "@/utils/gitBashSetup";
import { guideTerminalInstall } from "./guideTerminalInstall";

/** Title of the local terminal tab that hosts the guided Git-for-Windows install. */
export const GIT_FOR_WINDOWS_TAB_TITLE = "Install Git for Windows";

/**
 * Open a local terminal tab pre-loaded with the winget install command for Git
 * for Windows, reusing the shared guided-terminal-install helper built for the
 * macOS Homebrew flow (#1309/#1312). The user drives any UAC / winget prompts in
 * the tab; once the install finishes, re-detection surfaces Git Bash without an
 * app restart. Throws when no local shell is available to host the installer
 * (the winget-absent machine still has PowerShell, so this is rare on Windows).
 *
 * @throws if no local shell is available to run the installer.
 */
export async function guideGitForWindowsInstall(): Promise<void> {
  await guideTerminalInstall(GIT_FOR_WINDOWS_WINGET_COMMAND, GIT_FOR_WINDOWS_TAB_TITLE);
}

/**
 * Open the official Git for Windows download page — the manual / portable-Git
 * fallback for machines without winget. termiHub never hosts the installer, so
 * the help ends at this deep link.
 */
export async function openGitForWindowsDownload(): Promise<void> {
  await openUrl(GIT_FOR_WINDOWS_DOWNLOAD_URL);
}
