import { StateCreator } from "zustand";

import { toast } from "@/components/ui";
import {
  getWorkspaces as apiGetWorkspaces,
  saveWorkspace as apiSaveWorkspace,
  deleteWorkspace as apiDeleteWorkspace,
  duplicateWorkspace as apiDuplicateWorkspace,
} from "@/services/workspaceApi";
import type { WorkspaceSummary, WorkspaceDefinition } from "@/types/workspace";
import { frontendLog } from "@/utils/frontendLog";

import type { AppState } from "../appStore";

/**
 * Workspaces domain slice — a cut of the appStore god-module split
 * (ARCH-001 / FES-011), following the earlier slices PR #2880 (file-browser),
 * #2890 (transfers), #2902 (monitoring) and #2909 (connection-tree).
 *
 * Only the cleanly-separable **workspace list / CRUD** surface lives here: the
 * saved-workspace summaries the WorkspaceSidebar lists plus the load / save /
 * delete / duplicate actions that talk to the workspace backend and refresh the
 * list. These have no coupling to the tab / panel-tree / session-lifecycle
 * layout machinery — they only drive `@/services/workspaceApi` and re-read the
 * summaries.
 *
 * The layout-entangled workspace actions stay in `appStore` on purpose and are
 * NOT part of this slice: `launchWorkspace`, `saveCurrentAsWorkspace` and
 * `openWorkspaceEditorTab` depend on module-private layout helpers (session
 * teardown, panel-tree reseeding, `curLayout()`, tab-group capture / window
 * restore, restore-cohort bookkeeping) that belong to the tab/panel-tree +
 * session-lifecycle domain — a dedicated future cut (#2881). Those actions
 * still write {@link WorkspacesSlice.activeWorkspaceName} and call
 * `loadWorkspaces` via `get()`, which works unchanged because they run inside
 * the same composed `AppState`.
 */
export interface WorkspacesSlice {
  /** Saved workspace summaries, as listed by the WorkspaceSidebar. */
  workspaces: WorkspaceSummary[];
  /** Name of the workspace currently reflected by the live layout, or `null`. */
  activeWorkspaceName: string | null;
  /** Load the saved-workspace summaries from the backend into `workspaces`. */
  loadWorkspaces: () => Promise<void>;
  /** Persist a full workspace definition, then refresh the summaries list. */
  saveWorkspaceToBackend: (definition: WorkspaceDefinition) => Promise<void>;
  /** Delete a workspace by id, mutating local state only after the backend delete resolves. */
  deleteWorkspaceFromBackend: (workspaceId: string) => Promise<void>;
  /** Duplicate a workspace by id, then refresh the summaries list. */
  duplicateWorkspaceInBackend: (workspaceId: string) => Promise<void>;
}

export const createWorkspacesSlice: StateCreator<AppState, [], [], WorkspacesSlice> = (
  set,
  get
) => ({
  workspaces: [],
  activeWorkspaceName: null,

  loadWorkspaces: async () => {
    try {
      const workspaces = await apiGetWorkspaces();
      set({ workspaces });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to load workspaces: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },

  saveWorkspaceToBackend: async (definition) => {
    try {
      await apiSaveWorkspace(definition);
      await get().loadWorkspaces();
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to save workspace: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }
  },

  deleteWorkspaceFromBackend: async (workspaceId) => {
    // Only mutate local state after the backend delete resolves, and rethrow
    // on failure so the caller can surface the error (GAP G7). A swallowed
    // failure would optimistically remove the item, then silently "un-delete"
    // it on the next loadWorkspaces with no explanation.
    await apiDeleteWorkspace(workspaceId);
    set((state) => ({
      workspaces: state.workspaces.filter((ws) => ws.id !== workspaceId),
    }));
  },

  duplicateWorkspaceInBackend: async (workspaceId) => {
    try {
      await apiDuplicateWorkspace(workspaceId);
      await get().loadWorkspaces();
      toast.success("Duplicated workspace");
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to duplicate workspace: ${err instanceof Error ? err.message : String(err)}`
      );
      toast.error(
        `Failed to duplicate workspace: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },
});
