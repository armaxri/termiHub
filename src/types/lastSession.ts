import { WorkspaceTabGroupDef } from "@/types/workspace";

/**
 * The automatically persisted "last session": the open tab groups and their
 * panel layout captured on every change and restored on the next startup.
 *
 * Reuses the {@link WorkspaceTabGroupDef} format so the existing workspace
 * capture/restore utilities apply unchanged. Unlike a workspace it has no
 * name/id and never appears in the workspace list.
 */
export interface LastSession {
  /** Schema version for forward compatibility. */
  version: string;
  /** The captured tab groups (panel trees) of the session. */
  tabGroups: WorkspaceTabGroupDef[];
  /** Index into {@link tabGroups} of the group that was active. */
  activeGroupIndex: number;
}
