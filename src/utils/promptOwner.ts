/**
 * Split a prompt owner (`connect_id = ${tabId}:${retryCount}`) into its tab id
 * and attempt number; `null` when it is not a terminal tab's connect id.
 *
 * SSH host-key and keyboard-interactive prompts name the connect that raised
 * them this way (#5243), so the frontend can find the owning tab.
 */
export function parsePromptOwner(owner: string): { tabId: string; attempt: number } | null {
  const sep = owner.lastIndexOf(":");
  if (sep <= 0) return null;
  const attempt = Number(owner.slice(sep + 1));
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  return { tabId: owner.slice(0, sep), attempt };
}

/**
 * The name of the connection behind a prompt owner (#5862, R-111): the title
 * of the terminal tab whose connect raised the prompt. A tab opened from a
 * saved connection carries that connection's name. `undefined` when the
 * prompt has no owning tab (SFTP, tunnels) or the tab is gone.
 */
export function promptConnectionName(
  owner: string | null | undefined,
  tabs: readonly { id: string; title: string }[]
): string | undefined {
  const parsed = owner ? parsePromptOwner(owner) : null;
  if (!parsed) return undefined;
  const title = tabs.find((t) => t.id === parsed.tabId)?.title.trim();
  return title ? title : undefined;
}
