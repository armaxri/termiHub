/**
 * Following a saved connection's id change in open tabs (#3579).
 *
 * A saved connection's id is its path in the tree (`Folder/Name`), so renaming or
 * moving it — or renaming, moving or deleting a folder above it — changes the id.
 * The backend reports each persisted change as a `connection-ids-changed` event
 * (`[{ oldId, newId }]`, see `src-tauri/src/boot/connection_id_changes.rs`).
 *
 * Which references follow, and which do not:
 *
 * - **Open tabs' `connectionId` / `persistentConnectionId`** — live references
 *   ("this tab was opened from that connection"): they follow, so the tab keeps
 *   its bookmarks scope (`connection:<id>`), on-connect workflow matching, etc.
 *   Tab content is window-local frontend state (the backend `layout` region holds
 *   the panel structure only), so each window remaps its own tabs.
 * - **`persistentSessions`** — keyed by the id the *backend* persistent-session
 *   registry uses. Re-keying only the frontend map would desync it from the
 *   backend, so it is left as is (backend follow-up).
 * - **Saved workspaces, broadcast groups, schedules, workflow triggers, tunnels,
 *   jump-host references** — persisted, backend-owned records; not remapped here.
 * - **Session history** — a historical record of what was opened; not remapped.
 */

import type { ConnectionIdChange } from "@/types/connection";
import type { TabContent } from "@/types/terminal";

/**
 * A lookup applying one batch of id changes. The changes of one batch apply
 * simultaneously: `a→b, b→c` maps `a` to `b` and `b` to `c` (not `a` to `c`), and
 * a swap `a→b, b→a` exchanges the two. Ids not in the batch map to themselves.
 */
export function connectionIdRemapper(
  changes: readonly ConnectionIdChange[]
): (id: string) => string {
  const byOld = new Map<string, string>();
  for (const { oldId, newId } of changes) byOld.set(oldId, newId);
  return (id) => byOld.get(id) ?? id;
}

/**
 * Re-point every tab's `connectionId` / `persistentConnectionId` at its
 * connection's new id. Returns `null` when no tab referenced a changed id, so the
 * caller can skip the store update.
 */
export function remapTabContentConnectionIds(
  tabContent: Readonly<Record<string, TabContent>>,
  changes: readonly ConnectionIdChange[]
): Record<string, TabContent> | null {
  if (changes.length === 0) return null;
  const remap = connectionIdRemapper(changes);
  let next: Record<string, TabContent> | null = null;
  for (const [tabId, content] of Object.entries(tabContent)) {
    const patch: Partial<TabContent> = {};
    if (content.connectionId != null) {
      const id = remap(content.connectionId);
      if (id !== content.connectionId) patch.connectionId = id;
    }
    if (content.persistentConnectionId != null) {
      const id = remap(content.persistentConnectionId);
      if (id !== content.persistentConnectionId) patch.persistentConnectionId = id;
    }
    if (Object.keys(patch).length > 0) {
      next ??= { ...tabContent };
      next[tabId] = { ...content, ...patch };
    }
  }
  return next;
}
