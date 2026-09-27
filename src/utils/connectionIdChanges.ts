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
 * - **An open connection editor's own connection** (`connectionEditorMeta.connectionId`,
 *   #3622) — follows like the tab references above, so the editor keeps editing
 *   (and saving) the renamed connection instead of a now-missing id. A *new*
 *   connection's target folder (`connectionEditorMeta.folderId`) follows a folder
 *   rename / move / delete once the tree confirms the old folder is gone — see
 *   {@link inferFolderFollow} and the connection editor.
 * - **`persistentSessions`** — keyed by the id the *backend* persistent-session
 *   registry uses. The backend re-keys its registry before it sends the event,
 *   so each window re-keys its map in the same step ({@link remapPersistentSessions},
 *   #3595) and attach / stop keep reaching the running session; the backend then
 *   reports each moved session's state under its new id.
 * - **Saved workspaces (and the stored last session), broadcast groups,
 *   shell-integration entries, schedules, workflow triggers, tunnels, jump-host
 *   references** — persisted, backend-owned records; the backend re-points them
 *   before it sends the event (#3596, `src-tauri/src/boot/connection_id_changes.rs`).
 *   The UI caches refresh from their own sources: the `settings`, `tunnels` and
 *   `connections` regions, `schedules-changed`, and a workflow-list reload in
 *   `followConnectionIdChanges`.
 * - **Open editors' unsaved drafts** of those records (workspace tab refs,
 *   workflow on-connect triggers, schedule targets, a tunnel's SSH connection,
 *   jump-host hops, a shell-integration entry's connection) — each editor
 *   follows the event while open (`useFollowConnectionIdChanges`, #3603) with
 *   the helpers below, so saving the draft does not write the old id back.
 * - **Session history** — a historical record of what was opened; not remapped.
 */

import type { ConnectionIdChange, PersistentSessionEntry } from "@/types/connection";
import type { TabContent } from "@/types/terminal";
import type { WorkspaceLayoutNode, WorkspaceTabGroupDef } from "@/types/workspace";
import type { WorkflowTrigger } from "@/types/workflow";

/** Maps a saved-connection id to its id after one batch of changes. */
export type ConnectionIdRemap = (id: string) => string;

/**
 * A lookup applying one batch of id changes. The changes of one batch apply
 * simultaneously: `a→b, b→c` maps `a` to `b` and `b` to `c` (not `a` to `c`), and
 * a swap `a→b, b→a` exchanges the two. Ids not in the batch map to themselves.
 */
export function connectionIdRemapper(changes: readonly ConnectionIdChange[]): ConnectionIdRemap {
  const byOld = new Map<string, string>();
  for (const { oldId, newId } of changes) byOld.set(oldId, newId);
  return (id) => byOld.get(id) ?? id;
}

/**
 * Re-point every tab's `connectionId` / `persistentConnectionId`, and an open
 * connection editor's own `connectionEditorMeta.connectionId` (#3622), at its
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
    const meta = content.connectionEditorMeta;
    // An agent-definition editor's `connectionId` is the agent's id, never a saved
    // connection's; it cannot appear in a batch, but do not even look.
    if (meta && meta.agentDefinitionId == null) {
      const id = remap(meta.connectionId);
      if (id !== meta.connectionId) patch.connectionEditorMeta = { ...meta, connectionId: id };
    }
    if (Object.keys(patch).length > 0) {
      next ??= { ...tabContent };
      next[tabId] = { ...content, ...patch };
    }
  }
  return next;
}

/** A folder id's inferred new id (`null` = the root). */
export interface FolderFollow {
  from: string;
  to: string | null;
}

/**
 * Infer where folder `folderId` went from one batch of connection id changes
 * (#3622). The backend reports connection ids only, so a folder rename / move /
 * delete is visible as every connection under the folder moving to the same new
 * parent path with the same relative path (`Work/a/x → Job/a/x`; deleting `Work`
 * moves its contents up, `Work/x → x`).
 *
 * `connectionIdsBefore` is the tree's connection ids *before* the batch applied.
 * Returns `null` when the folder holds no connection, or when its connections did
 * not all move the same way.
 *
 * The result is a candidate, not a fact: moving each connection out of a folder
 * one by one looks the same as moving the folder. Apply it only once the tree no
 * longer has `folderId` (the connection editor does).
 */
export function inferFolderFollow(
  folderId: string,
  changes: readonly ConnectionIdChange[],
  connectionIdsBefore: readonly string[]
): FolderFollow | null {
  const prefix = `${folderId}/`;
  const remap = connectionIdRemapper(changes);
  let to: string | null | undefined;
  for (const id of connectionIdsBefore) {
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    const next = remap(id);
    let parent: string | null;
    if (next === rest) parent = null;
    else if (next.endsWith(`/${rest}`)) parent = next.slice(0, next.length - rest.length - 1);
    else return null;
    if (to !== undefined && to !== parent) return null;
    to = parent;
  }
  if (to === undefined || to === folderId) return null;
  return { from: folderId, to };
}

/**
 * Re-point a list of connection ids. Returns the input array itself when no id
 * changed, so a state setter can bail out of a re-render.
 */
export function remapConnectionIdList<T extends readonly string[]>(
  ids: T,
  remap: ConnectionIdRemap
): T {
  let next: string[] | null = null;
  ids.forEach((id, i) => {
    const mapped = remap(id);
    if (mapped !== id) {
      next ??= [...ids];
      next[i] = mapped;
    }
  });
  return (next ?? ids) as T;
}

function remapWorkspaceLayout(
  node: WorkspaceLayoutNode,
  remap: ConnectionIdRemap
): WorkspaceLayoutNode {
  if (node.type === "leaf") {
    let tabs: typeof node.tabs | null = null;
    node.tabs.forEach((tab, i) => {
      if (tab.connectionRef == null) return;
      const mapped = remap(tab.connectionRef);
      if (mapped !== tab.connectionRef) {
        tabs ??= [...node.tabs];
        tabs[i] = { ...tab, connectionRef: mapped };
      }
    });
    return tabs ? { ...node, tabs } : node;
  }
  let children: WorkspaceLayoutNode[] | null = null;
  node.children.forEach((child, i) => {
    const mapped = remapWorkspaceLayout(child, remap);
    if (mapped !== child) {
      children ??= [...node.children];
      children[i] = mapped;
    }
  });
  return children ? { ...node, children } : node;
}

/**
 * Re-point every tab's `connectionRef` in a workspace's tab groups (mirrors the
 * backend's saved-workspace follow, #3596). Returns the input array itself when
 * nothing changed.
 */
export function remapWorkspaceTabGroups(
  groups: WorkspaceTabGroupDef[],
  remap: ConnectionIdRemap
): WorkspaceTabGroupDef[] {
  let next: WorkspaceTabGroupDef[] | null = null;
  groups.forEach((group, i) => {
    const layout = remapWorkspaceLayout(group.layout, remap);
    if (layout !== group.layout) {
      next ??= [...groups];
      next[i] = { ...group, layout };
    }
  });
  return next ?? groups;
}

/**
 * Re-point the connections of every on-connect trigger (mirrors the backend's
 * workflow-trigger follow, #3596). Returns the input array itself when nothing
 * changed.
 */
export function remapWorkflowTriggers(
  triggers: WorkflowTrigger[],
  remap: ConnectionIdRemap
): WorkflowTrigger[] {
  let next: WorkflowTrigger[] | null = null;
  triggers.forEach((trigger, i) => {
    if (trigger.kind !== "on-connect") return;
    const connectionIds = remapConnectionIdList(trigger.connectionIds, remap);
    if (connectionIds !== trigger.connectionIds) {
      next ??= [...triggers];
      next[i] = { ...trigger, connectionIds };
    }
  });
  return next ?? triggers;
}

/**
 * Re-point the saved-connection jump-host references in a connection's settings
 * — the `proxyJump` array and its legacy `jumpHosts` alias (mirrors the backend's
 * `follow_jump_host_refs`, #3596). Returns the input object itself when nothing
 * changed.
 */
export function remapJumpHostRefs<T extends Record<string, unknown>>(
  settings: T,
  remap: ConnectionIdRemap
): T {
  let next: Record<string, unknown> | null = null;
  for (const key of ["proxyJump", "jumpHosts"]) {
    const hops = settings[key];
    if (!Array.isArray(hops)) continue;
    let nextHops: unknown[] | null = null;
    hops.forEach((hop: unknown, i) => {
      if (hop === null || typeof hop !== "object") return;
      const id = (hop as { connectionId?: unknown }).connectionId;
      if (typeof id !== "string") return;
      const mapped = remap(id);
      if (mapped !== id) {
        nextHops ??= [...hops];
        nextHops[i] = { ...hop, connectionId: mapped };
      }
    });
    if (nextHops) {
      next ??= { ...settings };
      next[key] = nextHops;
    }
  }
  return (next ?? settings) as T;
}

/**
 * Re-key the persistent-session map (and each entry's `connectionId`) after a
 * batch of id changes (#3595), mirroring the backend registry's re-key: the
 * batch applies simultaneously (a swap exchanges the two entries), and an entry
 * whose new id is held by an entry that does not move away keeps its old id —
 * the backend keeps it there too. Returns `null` when no entry moved.
 */
export function remapPersistentSessions(
  sessions: Readonly<Record<string, PersistentSessionEntry>>,
  changes: readonly ConnectionIdChange[]
): Record<string, PersistentSessionEntry> | null {
  const remap = connectionIdRemapper(changes);
  const moving = Object.keys(sessions).filter((id) => remap(id) !== id);
  if (moving.length === 0) return null;
  const vacated = new Set(moving);
  const taken = new Set(Object.keys(sessions).filter((id) => !vacated.has(id)));
  const movable = moving.filter((id) => {
    const to = remap(id);
    if (taken.has(to)) return false;
    taken.add(to);
    return true;
  });
  if (movable.length === 0) return null;
  const next: Record<string, PersistentSessionEntry> = { ...sessions };
  for (const id of movable) delete next[id];
  for (const id of movable) {
    const to = remap(id);
    next[to] = { ...sessions[id], connectionId: to };
  }
  return next;
}
