import { useCallback, useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import { onSpawnPickerRequested, onSpawnRequest, SpawnRequestPayload } from "@/services/events";
import {
  rememberSpawnChoice,
  resolveContainerSpawn,
  resolveShellSpawn,
  storeCredential,
  takePendingSpawn,
} from "@/services/api";
import { currentConnectionsView } from "@/store/connectionsBridge";
import type { ShellSpawn } from "@/types/generated/ShellSpawn";
import type { ContainerRuntime, SpawnChoice } from "@/types/spawn";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";
import { resolveConnectSecret } from "@/utils/resolveConnectSecret";

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
 * Resolve the password / key passphrase a spawned SSH session needs before its
 * tab opens, the way a sidebar connect does: the stored credential of the saved
 * connection (behind the credential-store unlock gate), else the password
 * prompt. A spawn carries only the saved connection's settings, which never hold
 * the secret, so without this step the connect sent an empty password and the
 * tab landed in "authentication failed".
 *
 * Returns the spawn with the secret spliced into its settings, the spawn
 * unchanged when it needs none (not SSH, key without a passphrase, a password
 * already present), or `null` when the user dismissed the unlock dialog or the
 * prompt. A prompt-entered secret is stored when the prompt's Save box is
 * ticked. The secret is never logged.
 */
export async function resolveSpawnSecret(
  spawn: ShellSpawn,
  connectionRef: string | undefined
): Promise<ShellSpawn | null> {
  const store = useAppStore.getState();
  const schema = store.connectionTypes.find((ct) => ct.typeId === "ssh")?.schema;
  // The spawn's `--connection` names the saved connection; the credential
  // store keys its secret by that connection's id and source file.
  const saved = connectionRef
    ? currentConnectionsView().connections.find((c) => c.id === connectionRef)
    : undefined;
  const sourceFile = saved?.sourceFile ?? null;
  const secret = await resolveConnectSecret({
    schema,
    settings: spawn.settings,
    connectionId: saved?.id ?? null,
    sourceFile,
    requestPassword: store.requestPassword,
  });
  if (secret.status === "canceled") return null;
  if (secret.status === "none") return spawn;
  if (secret.source === "prompt" && saved && useAppStore.getState().passwordPromptShouldSave) {
    await storeCredential(saved.id, secret.credentialType, secret.secret, sourceFile).catch(
      (err: unknown) => frontendLog("spawn", `Failed to store credential: ${errorMessage(err)}`)
    );
  }
  return { ...spawn, settings: { ...spawn.settings, [secret.passwordKey]: secret.secret } };
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
        testId: "spawn-toast-success",
      });
    } catch (err) {
      frontendLog("spawn", `Failed to resolve container spawn: ${errorMessage(err)}`);
      toast.error(`Failed to open spawned container: ${errorMessage(err)}`, {
        testId: "spawn-toast-error",
      });
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
    // An SSH spawn may need its password before it can connect. Skipped when no
    // SSH schema is registered (nothing could decide what the connect needs).
    const needsSecretStep =
      spawn.type === "ssh" &&
      useAppStore.getState().connectionTypes.some((ct) => ct.typeId === "ssh");
    const ready = needsSecretStep ? await resolveSpawnSecret(spawn, req.connection) : spawn;
    if (ready === null) {
      toast.info("Connect canceled");
      return;
    }
    open.openSpawnedShell(ready);
    if (ready.missing) {
      toast.info(`Path not found — opened a shell in your home directory instead`, {
        duration: SPAWN_TOAST_DURATION_MS,
        testId: "spawn-toast-missing",
      });
    } else {
      toast.success(`Opened a shell at ${req.location || "."}`, {
        duration: SPAWN_TOAST_DURATION_MS,
        testId: "spawn-toast-success",
      });
    }
  } catch (err) {
    frontendLog("spawn", `Failed to resolve shell spawn: ${errorMessage(err)}`);
    toast.error(`Failed to open spawned shell: ${errorMessage(err)}`, {
      testId: "spawn-toast-error",
    });
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
        frontendLog("spawn", `Failed to drain pending spawn: ${errorMessage(err)}`);
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
 * Persist a "Remember this choice" selection onto the entry that triggered the
 * spawn (#1561), so a later context-menu click opens the picked target directly
 * instead of prompting again.
 *
 * A no-op unless the user actually ticked the box *and* the spawn came from a
 * context-menu entry — a bare `termiHub spawn --pick` from a terminal has no
 * entry to remember onto.
 *
 * Remembering is a side effect of the spawn, not a precondition for it: a failed
 * save is logged and toasted but never blocks opening the session the user asked
 * for.
 */
async function persistRememberedChoice(
  req: SpawnRequestPayload,
  choice: SpawnChoice
): Promise<void> {
  if (!choice.remember || !req.entry_id) return;
  try {
    await rememberSpawnChoice(req.entry_id, choice.target);
  } catch (err) {
    frontendLog("spawn", `Failed to remember spawn choice: ${errorMessage(err)}`);
    toast.error(`Opened the session, but could not remember the choice: ${errorMessage(err)}`);
  }
}

/**
 * The confirm handler for the Session Picker (SI-3, #1366): fold the choice back
 * into its request, persist it when "Remember this choice" was ticked (#1561),
 * and open the session through the same path every other spawn takes.
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
      await persistRememberedChoice(req, choice);
      await handleSpawnRequest(request, { openSpawnedContainer, openSpawnedShell }, picked);
    },
    [openSpawnedContainer, openSpawnedShell]
  );
}
