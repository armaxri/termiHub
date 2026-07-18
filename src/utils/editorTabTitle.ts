import type { TerminalTab } from "@/types/terminal";

/**
 * Editor tabs disambiguated by session (#1640). An editor tab's `sessionKey`
 * (#1599) is a machine key — `sftp:<hostLabel>` or `session:<owning-tab-id>` —
 * not something to show a user. These helpers turn that key into a readable
 * qualifier and decide when a tab actually needs one.
 */

const SFTP_KEY_PREFIX = "sftp:";
const SESSION_KEY_PREFIX = "session:";

/** Separator between an editor tab's basename and its session qualifier. */
export const EDITOR_TAB_QUALIFIER_SEPARATOR = " — ";

/**
 * Human-readable label identifying the remote session backing an editor tab,
 * derived from its `editorMeta.sessionKey` (#1599):
 *
 * - SFTP tabs (`sftp:user@host:port`) → the host label (`user@host:port`).
 * - Session-layer tabs (`session:<tab-id>`) → the title of the terminal tab that
 *   owns the backing session, resolved from `allTabs`.
 *
 * Returns `undefined` for local tabs (no `sessionKey`), for remote tabs whose
 * identity could not be resolved, and when a session-layer owner is gone — in
 * every such case there is no meaningful qualifier to surface.
 */
export function getEditorSessionQualifier(
  tab: TerminalTab,
  allTabs: readonly TerminalTab[]
): string | undefined {
  const sessionKey = tab.editorMeta?.sessionKey;
  if (!sessionKey) return undefined;

  if (sessionKey.startsWith(SFTP_KEY_PREFIX)) {
    return sessionKey.slice(SFTP_KEY_PREFIX.length) || undefined;
  }

  if (sessionKey.startsWith(SESSION_KEY_PREFIX)) {
    const ownerId = sessionKey.slice(SESSION_KEY_PREFIX.length);
    const owner = allTabs.find((t) => t.id === ownerId);
    return owner?.title || undefined;
  }

  return undefined;
}

/**
 * Visible title for a tab, disambiguating editor tabs only **when there is
 * ambiguity** (#1640): if another editor tab shares this tab's basename, a
 * session qualifier is appended so the two are distinguishable (e.g.
 * `hosts — user@host-a`). A lone editor tab, a local editor tab (which has no
 * `sessionKey`), and every non-editor tab keep their plain title.
 *
 * @param tab The tab whose display title is wanted.
 * @param allTabs All tabs the ambiguity is judged against (the current tab group).
 */
export function getEditorTabDisplayTitle(
  tab: TerminalTab,
  allTabs: readonly TerminalTab[]
): string {
  if (tab.contentType !== "editor") return tab.title;

  // Local tabs (no sessionKey) never carry a qualifier: two tabs on the same
  // local path dedup to one, so a local basename is never ambiguous.
  const qualifier = getEditorSessionQualifier(tab, allTabs);
  if (!qualifier) return tab.title;

  // Only disambiguate when a different editor tab shows the same basename.
  const isAmbiguous = allTabs.some(
    (other) =>
      other.id !== tab.id && other.contentType === "editor" && other.title === tab.title
  );
  if (!isAmbiguous) return tab.title;

  return `${tab.title}${EDITOR_TAB_QUALIFIER_SEPARATOR}${qualifier}`;
}
