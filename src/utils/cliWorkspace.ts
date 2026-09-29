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
}

/**
 * Launch the saved workspace whose name matches `name` (case-insensitive).
 * Returns `true` when a workspace was found and launched.
 */
export async function launchWorkspaceByName(
  name: string,
  { reload = false }: LaunchWorkspaceByNameOptions = {}
): Promise<boolean> {
  if (reload) {
    await useAppStore.getState().loadWorkspaces();
  }
  const { workspaces, launchWorkspace } = useAppStore.getState();
  const wanted = name.toLowerCase();
  const ws = workspaces.find((w) => w.name.toLowerCase() === wanted);
  if (!ws) {
    return false;
  }
  await launchWorkspace(ws.id);
  return true;
}
