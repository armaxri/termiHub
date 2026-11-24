/**
 * Default titles for shell tabs the user opens without a saved connection
 * (#5829). Every such tab used to read "Terminal" (local) or "Shell: /bin/bash"
 * (agent), so several open tabs, and the "Closed …" reopen toast, could not be
 * told apart. A local tab is named after its shell and numbered when that name
 * is taken (`zsh`, `zsh 2`); an agent tab names the agent (`pi · bash`).
 *
 * A title is only chosen when the tab opens. A tab the user renamed keeps its
 * name; nothing here ever renames an open tab.
 */

/** Separator between an agent's name and the shell it runs. */
export const AGENT_TAB_SEPARATOR = " · ";

/** Name for a shell the title cannot name more precisely. */
const GENERIC_SHELL_NAME = "shell";

/** Prefix of a WSL distribution's shell kind (`wsl:Ubuntu`). */
const WSL_PREFIX = "wsl:";

/** Shell kinds whose tab name is not simply the shell id. */
const SHELL_TAB_NAMES: Readonly<Record<string, string>> = {
  gitbash: "Git Bash",
  nushell: "nu",
  custom: GENERIC_SHELL_NAME,
};

/**
 * The short name a tab uses for `shell`: a local shell kind (`zsh`, `pwsh`,
 * `wsl:Ubuntu`) or the shell path an agent reports (`/bin/bash`). Paths are
 * reduced to the program name without `.exe`; an unknown or missing shell
 * reads "shell".
 */
export function shellTabName(shell: string | null | undefined): string {
  const raw = shell?.trim();
  if (!raw) return GENERIC_SHELL_NAME;
  if (raw.startsWith(WSL_PREFIX)) return `WSL: ${raw.slice(WSL_PREFIX.length)}`;
  const program = raw
    .split(/[\\/]/u)
    .pop()
    ?.replace(/\.exe$/iu, "");
  if (!program) return GENERIC_SHELL_NAME;
  return SHELL_TAB_NAMES[program.toLowerCase()] ?? program;
}

/** Title of a shell tab on a remote agent: `<agent name> · <shell>`. */
export function agentShellTabTitle(agentName: string, shell: string | null | undefined): string {
  const name = agentName.trim();
  const shellName = shellTabName(shell);
  return name ? `${name}${AGENT_TAB_SEPARATOR}${shellName}` : shellName;
}

/**
 * `base` when no open tab carries it, else `base N` with the smallest free
 * `N ≥ 2`. A closed tab frees its number again.
 */
export function numberedTabTitle(base: string, takenTitles: Iterable<string>): string {
  const taken = new Set(takenTitles);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
