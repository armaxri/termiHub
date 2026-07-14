import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import { onSpawnRequest, SpawnRequestPayload } from "@/services/events";
import { resolveContainerSpawn, resolveShellSpawn, takePendingSpawn } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";

/** Auto-dismiss duration (ms) for the spawn confirmation toast (#1365). */
const SPAWN_TOAST_DURATION_MS = 3000;

/**
 * Whether a spawn request targets a "new container" spawn (#1446/#1465).
 *
 * The authoritative signal is the explicit `kind` discriminator: `"container"`
 * is ours, and the SI-2-owned kinds (`"local"`/`"wsl"`/`"ssh"`) are not. Older
 * payloads (and CLI invocations with no discriminating flags) carry `"auto"`
 * (or no `kind`); for those we fall back to the legacy presence-based inference
 * — a container iff a `container_image`/`container_mount` is set — so behaviour
 * is byte-for-byte identical during the SI-2 transition.
 */
function isContainerSpawn(req: SpawnRequestPayload): boolean {
  switch (req.kind) {
    case "container":
      return true;
    case "local":
    case "wsl":
    case "ssh":
      return false;
    case "auto":
    case undefined:
    default:
      return !!req.container_image?.trim() || !!req.container_mount?.trim();
  }
}

/**
 * Handle a single resolved spawn request, whether it arrived over the live
 * `spawn-request` event or was drained from the cold-start pending slot.
 *
 * A container spawn resolves Docker settings via `resolve_container_spawn` and
 * opens a Docker session tab (#1446). A local/WSL/SSH spawn resolves the target
 * directory via `resolve_shell_spawn` and opens a shell tab `cd`'d there (#1365,
 * SI-2). Either way a toast confirms the action; a missing path warns.
 */
async function handleSpawnRequest(
  req: SpawnRequestPayload,
  open: {
    openSpawnedContainer: ReturnType<typeof useAppStore.getState>["openSpawnedContainer"];
    openSpawnedShell: ReturnType<typeof useAppStore.getState>["openSpawnedShell"];
  }
): Promise<void> {
  if (isContainerSpawn(req)) {
    const location = req.location ?? "";
    try {
      const spawn = await resolveContainerSpawn(
        location,
        req.entry_id,
        req.container_image,
        req.container_mount
      );
      open.openSpawnedContainer(spawn);
      toast.success(`Spawned container at ${location || "."}`, {
        duration: SPAWN_TOAST_DURATION_MS,
      });
    } catch (err) {
      frontendLog("spawn", `Failed to resolve container spawn: ${err}`);
      toast.error(`Failed to open spawned container: ${err}`);
    }
    return;
  }

  // Local / WSL / SSH spawn: open a shell tab at the resolved target (SI-2).
  try {
    const spawn = await resolveShellSpawn(req.location, req.connection, req.entry_id, req.kind);
    open.openSpawnedShell(spawn);
    if (spawn.missing) {
      toast.info(`Path not found — opened a shell in your home directory instead`, {
        duration: SPAWN_TOAST_DURATION_MS,
      });
    } else {
      toast.success(`Opened a shell at ${req.location || "."}`, {
        duration: SPAWN_TOAST_DURATION_MS,
      });
    }
  } catch (err) {
    frontendLog("spawn", `Failed to resolve shell spawn: ${err}`);
    toast.error(`Failed to open spawned shell: ${err}`);
  }
}

/**
 * App-scoped hook that consumes spawn requests (#1364/#1446/#1465/#1365).
 *
 * Subscribes to the live `spawn-request` event and, once subscribed, drains any
 * cold-start pending spawn (parked by a freshly-launched instance before the UI
 * was ready) via `take_pending_spawn`. Both feed the same {@link
 * handleSpawnRequest} routing so container and local/WSL/SSH spawns behave
 * identically no matter how they arrive.
 *
 * Registered once at app scope; the subscription is torn down on unmount.
 */
export function useSpawnRequests(): void {
  const openSpawnedContainer = useAppStore((s) => s.openSpawnedContainer);
  const openSpawnedShell = useAppStore((s) => s.openSpawnedShell);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const open = { openSpawnedContainer, openSpawnedShell };

    const setup = async () => {
      const off = await onSpawnRequest((req) => {
        void handleSpawnRequest(req, open);
      });
      // If the effect was cleaned up before the async listen() resolved, tear
      // the listener down immediately so it does not leak.
      if (disposed) {
        off();
        return;
      }
      unlisten = off;

      // The subscription is live — safe to drain a cold-start pending spawn now
      // without racing the event. `take_pending_spawn` removes it from the
      // backend, so once drained it must be processed even if this effect was
      // torn down meanwhile (e.g. StrictMode remount) — otherwise it is lost.
      try {
        const pending = await takePendingSpawn();
        if (pending) {
          void handleSpawnRequest(pending, open);
        }
      } catch (err) {
        frontendLog("spawn", `Failed to drain pending spawn: ${err}`);
      }
    };

    void setup();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openSpawnedContainer, openSpawnedShell]);
}
