/**
 * Launching a workspace named on the command line (`--workspace` /
 * `--workspace-file`), both at startup and when a second launch forwards its
 * arguments to the already-running instance (#3101).
 */
import { useAppStore } from "@/store/appStore";

/** Backend event carrying a workspace name forwarded by a second launch. */
export const CLI_WORKSPACE_REQUESTED_EVENT = "cli-workspace-requested";

/** Options for {@link launchWorkspaceByName}. */
export interface LaunchWorkspaceByNameOptions {
  /**
   * Reload the workspace list from the backend first. Needed for a forwarded
   * `--workspace-file`, which the backend saved after this window loaded.
   */
  reload?: boolean;
  /**
   * Route through the guarded `requestLaunchWorkspace`, which asks before ending
   * live sessions (UX2-002). Set for a forwarded launch into a running instance;
   * the startup path leaves it off, since nothing is live at boot.
   */
  confirmIfLive?: boolean;
}

/**
 * Launch the saved workspace whose name matches `name` (case-insensitive).
 * Returns `true` when a workspace was found and launched (or, with
 * `confirmIfLive`, its launch was handed to the confirm-first entry point).
 */
export async function launchWorkspaceByName(
  name: string,
  { reload = false, confirmIfLive = false }: LaunchWorkspaceByNameOptions = {}
): Promise<boolean> {
  if (reload) {
    await useAppStore.getState().loadWorkspaces();
  }
  const { workspaces, launchWorkspace, requestLaunchWorkspace } = useAppStore.getState();
  const wanted = name.toLowerCase();
  const ws = workspaces.find((w) => w.name.toLowerCase() === wanted);
  if (!ws) {
    return false;
  }
  if (confirmIfLive) {
    requestLaunchWorkspace(ws.id);
  } else {
    await launchWorkspace(ws.id);
  }
  return true;
}
