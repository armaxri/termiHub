import type { ShellType } from "@/types/terminal";

/**
 * winget one-liner that installs Git for Windows — the MSYS2-based bundle that
 * provides Git Bash plus coreutils, curl, OpenSSH, tar/gzip/xz, git, vim and
 * less. termiHub does not host or redistribute it; winget (or the user) fetches
 * it and termiHub only launches the resulting `bash.exe`.
 */
export const GIT_FOR_WINDOWS_WINGET_COMMAND = "winget install --id Git.Git -e";

/**
 * Official Git for Windows download page. The manual / portable-Git fallback for
 * machines without winget (App Installer). Help ends here — termiHub never hosts
 * the installer.
 */
export const GIT_FOR_WINDOWS_DOWNLOAD_URL = "https://git-scm.com/download/win";

/**
 * Shell names that provide a POSIX / Unix environment (bash + coreutils). Git
 * Bash (`gitbash`) counts: it is the Unix-tools provider this feature guides the
 * user to install.
 */
const UNIX_SHELL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "zsh",
  "sh",
  "fish",
  "nushell",
  "gitbash",
]);

/**
 * True when the detected-shell list already contains a usable Unix shell — a
 * known POSIX shell (incl. Git Bash) or a WSL distribution (`wsl:<distro>`),
 * which brings its own bash. When this holds, no guided install is needed.
 */
export function hasUnixShell(shells: readonly ShellType[]): boolean {
  return shells.some((shell) => shell.startsWith("wsl:") || UNIX_SHELL_NAMES.has(shell));
}

/**
 * Whether to offer the guided Git-for-Windows install for the given platform and
 * detected shells. The guidance is Windows-only (macOS/Linux ship native Unix
 * shells) and only surfaces when no Unix shell — Git Bash or WSL bash — was
 * detected. Pure so the gate is unit-testable on any CI platform.
 */
export function shouldOfferGitBashSetup(
  isWindowsPlatform: boolean,
  shells: readonly ShellType[]
): boolean {
  return isWindowsPlatform && !hasUnixShell(shells);
}
