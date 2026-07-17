import { useCallback, useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import { onSpawnPickerRequested, onSpawnRequest, SpawnRequestPayload } from "@/services/events";
import { resolveContainerSpawn, resolveShellSpawn, takePendingSpawn } from "@/services/api";
import type { ContainerRuntime, SpawnChoice } from "@/types/spawn";
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
 * The parts of a Session Picker choice that steer resolution rather than the
 * request itself (SI-3, #1366): the specific shell / WSL distribution to open,
 * and the container runtime to use. Empty for every non-picked spawn, which
 * keeps the pre-picker fallbacks.
 */
interface PickedTarget {
  /** Local shell name or WSL distribution the user picked. */
  shell?: string;
  /** Container runtime the user picked. */
  runtime?: ContainerRuntime;
}

/**
 * Fold a confirmed {@link SpawnChoice} back into the request it decided (SI-3,
 * #1366), producing the request the normal spawn path can handle plus the
 * {@link PickedTarget} steering its resolution.
 *
 * The choice only ever *narrows* the request: it pins the `kind` the user chose
 * (so the `auto` inference never second-guesses them), carries the container
 * image/mount for a container pick, and applies the picker's new-window toggle.
 */
export function applySpawnChoice(
  req: SpawnRequestPayload,
  choice: SpawnChoice
): { request: SpawnRequestPayload; picked: PickedTarget } {
  const base: SpawnRequestPayload = { ...req, new_window: choice.newWindow };
  switch (choice.target.kind) {
    case "local":
      return {
        request: { ...base, kind: "local" },
        picked: { shell: choice.target.shell },
      };
    case "wsl":
      return {
        request: { ...base, kind: "wsl" },
        picked: { shell: choice.target.distro },
      };
    case "container":
      return {
        request: {
          ...base,
          kind: "container",
          container_image: choice.target.image,
          container_mount: choice.target.mount,
        },
        picked: { runtime: choice.target.runtime },
      };
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
  },
  picked: PickedTarget = {}
): Promise<void> {
  if (isContainerSpawn(req)) {
    const location = req.location ?? "";
    try {
      const spawn = await resolveContainerSpawn(
        location,
        req.entry_id,
        req.container_image,
        req.container_mount,
        picked.runtime
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
    const spawn = await resolveShellSpawn(
      req.location,
      req.connection,
      req.entry_id,
      req.kind,
      picked.shell
    );
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
 * App-scoped hook that consumes spawn requests (#1364/#1446/#1465/#1365) and
 * raises the Session Picker for those that ask for one (SI-3, #1366).
 *
 * Subscribes to the live `spawn-request` and `spawn-picker-requested` events
 * and, once subscribed, drains any cold-start pending spawn (parked by a
 * freshly-launched instance before the UI was ready) via `take_pending_spawn`.
 * All three feed the same routing — spawn now, or ask first — so a request
 * behaves identically no matter how it arrives. A drained pending request is
 * routed on its own `pick` flag, since the cold-start path carries the request
 * itself rather than the event that would have classified it.
 *
 * Registered once at app scope; the subscriptions are torn down on unmount.
 */
export function useSpawnRequests(): void {
  const openSpawnedContainer = useAppStore((s) => s.openSpawnedContainer);
  const openSpawnedShell = useAppStore((s) => s.openSpawnedShell);
  const showSpawnPicker = useAppStore((s) => s.showSpawnPicker);

  useEffect(() => {
    const offs: (() => void)[] = [];
    let disposed = false;
    const open = { openSpawnedContainer, openSpawnedShell };

    /** Spawn straight away, or defer to the picker when the request asks to. */
    const route = (req: SpawnRequestPayload) => {
      if (req.pick) {
        showSpawnPicker(req);
      } else {
        void handleSpawnRequest(req, open);
      }
    };

    const setup = async () => {
      const [offSpawn, offPicker] = await Promise.all([
        onSpawnRequest((req) => {
          void handleSpawnRequest(req, open);
        }),
        onSpawnPickerRequested((req) => {
          showSpawnPicker(req);
        }),
      ]);
      // If the effect was cleaned up before the async listen() resolved, tear
      // the listeners down immediately so they do not leak.
      if (disposed) {
        offSpawn();
        offPicker();
        return;
      }
      offs.push(offSpawn, offPicker);

      // The subscriptions are live — safe to drain a cold-start pending spawn
      // now without racing the event. `take_pending_spawn` removes it from the
      // backend, so once drained it must be processed even if this effect was
      // torn down meanwhile (e.g. StrictMode remount) — otherwise it is lost.
      try {
        const pending = await takePendingSpawn();
        if (pending) {
          route(pending);
        }
      } catch (err) {
        frontendLog("spawn", `Failed to drain pending spawn: ${err}`);
      }
    };

    void setup();

    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, [openSpawnedContainer, openSpawnedShell, showSpawnPicker]);
}

/**
 * The confirm handler for the Session Picker (SI-3, #1366): fold the choice back
 * into its request and open the session through the same path every other spawn
 * takes.
 */
export function useSpawnChoiceHandler(): (
  req: SpawnRequestPayload,
  choice: SpawnChoice
) => Promise<void> {
  const openSpawnedContainer = useAppStore((s) => s.openSpawnedContainer);
  const openSpawnedShell = useAppStore((s) => s.openSpawnedShell);

  return useCallback(
    async (req, choice) => {
      const { request, picked } = applySpawnChoice(req, choice);
      await handleSpawnRequest(request, { openSpawnedContainer, openSpawnedShell }, picked);
    },
    [openSpawnedContainer, openSpawnedShell]
  );
}
