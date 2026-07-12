import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import { onSpawnRequest, SpawnRequestPayload } from "@/services/events";
import { resolveContainerSpawn } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Whether a spawn request targets a "new container" spawn (#1446). The CLI
 * container path (`termiHub spawn --location … --container-image …`) always
 * carries an image; a mount override alone also signals container intent. All
 * other spawns (local / WSL / SSH) are owned by SI-2 and ignored here.
 */
function isContainerSpawn(req: SpawnRequestPayload): boolean {
  return (
    (req.container_image?.trim() ?? "").length > 0 || (req.container_mount?.trim() ?? "").length > 0
  );
}

/**
 * App-scoped hook that consumes `spawn-request` events (#1364/#1446). For a
 * container spawn it resolves the Docker settings via `resolve_container_spawn`
 * and opens a Docker session tab (badged "Spawned" and tracked separately from
 * configured connections), confirming with a toast. Non-container spawns are
 * short-circuited with a log — the local/WSL/SSH open path is SI-2's scope.
 *
 * Registered once at app scope; the subscription is torn down on unmount.
 */
export function useSpawnRequests(): void {
  const openSpawnedContainer = useAppStore((s) => s.openSpawnedContainer);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    const setup = async () => {
      const off = await onSpawnRequest(async (req) => {
        if (!isContainerSpawn(req)) {
          // TODO(SI-2): local / WSL / SSH spawns are resolved and opened by a
          // separate work item. Ignore them here rather than half-opening a
          // session with the wrong backend.
          frontendLog(
            "spawn",
            `Ignoring non-container spawn-request (SI-2 owns local/WSL/SSH): ${JSON.stringify(req)}`
          );
          return;
        }

        const location = req.location ?? "";
        try {
          const spawn = await resolveContainerSpawn(
            location,
            req.container_image,
            req.container_mount
          );
          openSpawnedContainer(spawn);
          toast.success(`Spawned container at ${location || "."}`);
        } catch (err) {
          frontendLog("spawn", `Failed to resolve container spawn: ${err}`);
          toast.error(`Failed to open spawned container: ${err}`);
        }
      });
      // If the effect was cleaned up before the async listen() resolved, tear
      // the listener down immediately so it does not leak.
      if (disposed) {
        off();
        return;
      }
      unlisten = off;
    };

    void setup();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openSpawnedContainer]);
}
