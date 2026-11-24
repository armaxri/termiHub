/**
 * The status-bar chip for a local shell tab (#5839, R-172): the shell's name,
 * so the bar says what session the user is in instead of sitting empty (local
 * shells have no host metrics, #5754). The tooltip adds the configured start
 * directory.
 *
 * Pure so the wording is unit-tested; `LocalShellStatus` only renders it.
 */

import type { ConnectionConfig, ShellType, TabContentType } from "@/types/terminal";
import { isLocalConnectionConfig, isWslConnectionConfig } from "@/utils/typedConnectionConfig";
import { SHELL_LABELS } from "@/utils/shellLabels";
import { getWslDistroName } from "@/utils/shell-detection";
import type { SessionChip } from "@/utils/sessionStatusChips";
import { t, tf } from "@/i18n/catalog";

/** The display name of a shell kind: `Zsh`, `PowerShell 7`, `WSL: Ubuntu`. */
export function shellDisplayName(shell: ShellType | undefined): string {
  const name = shell?.trim();
  if (!name) return t("statusBar.local.unknownShell");
  const distro = getWslDistroName(name as ShellType);
  if (distro !== null) return `WSL: ${distro}`;
  return SHELL_LABELS[name] ?? name;
}

/**
 * The local-shell chip for a terminal tab's config (`local` or `wsl`), or
 * `null` for any other connection or a non-terminal tab (Settings and editor
 * tabs carry a placeholder local config).
 */
export function localShellChip(
  config: ConnectionConfig | undefined | null,
  contentType: TabContentType | undefined
): SessionChip | null {
  if (contentType !== "terminal") return null;
  let label: string;
  let startDir: string | undefined;
  if (isLocalConnectionConfig(config)) {
    label = shellDisplayName(config.config.shell ?? config.config.shellType);
    startDir = config.config.startingDirectory;
  } else if (isWslConnectionConfig(config)) {
    const distro = config.config.distribution?.trim();
    label = distro ? `WSL: ${distro}` : shellDisplayName(config.config.shell);
    startDir = config.config.startingDirectory;
  } else {
    return null;
  }
  const dir = startDir?.trim();
  const tooltip = [
    tf("statusBar.local.tooltip", { shell: label }),
    ...(dir ? [tf("statusBar.local.startDir", { dir })] : []),
  ].join("\n");
  return { label, tooltip };
}
