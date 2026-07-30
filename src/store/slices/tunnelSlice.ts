import { StateCreator } from "zustand";

import { toast } from "@/components/ui";
import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type IntentAck,
  type Transport,
} from "@/services/transport";
import { TunnelConfig, TunnelState } from "@/types/tunnel";
import { frontendLog } from "@/utils/frontendLog";

import type { AppState } from "../appStore";

/** The projection region id for the SSH-tunnels domain (twin of the Rust const). */
const TUNNELS_REGION = "tunnels";

/**
 * The projected `tunnels` region view model — the twin of the Rust
 * `tunnel_view_from` (`src-tauri/src/tunnel/projection.rs`): the saved config
 * list plus live per-id state. The slice splits it back into the `tunnels` /
 * `tunnelStates` shape the UI has always rendered from.
 */
interface TunnelsView {
  tunnels: TunnelConfig[];
  states: Record<string, TunnelState>;
}

// In-flight guards for tunnel start/stop (GAP 4, #1141). A rapid double-click on
// Start/Stop for a tunnel that is already `connecting` must not fire a second
// intent — that produces spurious "already active/connecting" error toasts and
// can flip the visible state. We track the id of each tunnel whose start/stop
// intent has not yet been acked and no-op any re-entrant call for the same id.
const _tunnelStartInFlight = new Set<string>();
const _tunnelStopInFlight = new Set<string>();

// First-connect failure-toast tracking (#2169). After the projection migration
// (#2150) `tunnel.start` / `tunnel.reconnect` are fire-and-forget: the ack only
// confirms the start was *accepted*, and a failure during the SSH handshake now
// arrives as a projected `error` status rather than the old synchronous red
// toast. To restore that immediate failure feedback for parity — without
// re-serialising the blocking handshake onto the dispatcher — we remember each
// tunnel THIS client just dispatched a start/reconnect for, and raise a transient
// failure toast when its projected state *transitions into* `error`.
//
// Keyed by tunnel id → the verb for the message ("start" | "reconnect"). The map
// is intentionally per-client (module-local), so only the initiating client sees
// the toast — a mid-session death or another client's start (which this client
// never dispatched) surfaces only as the Error status badge, never a toast here.
const _awaitingFirstConnect = new Map<string, "start" | "reconnect">();

// The projection transport + `tunnels` region client, shared across the slice.
// Both are created lazily on first use (`loadTunnels` / the first intent) so the
// slice imports cleanly in a non-Tauri context (e.g. unit tests), where
// `createTransport` throws and the failure is caught and logged.
let _transport: Transport | null = null;
let _client: ProjectionClient | null = null;
// A stable per-session identity for dispatched intents (fan-out / audit only;
// the diff is fanned out to every subscriber regardless of who dispatched it).
const _clientId = newClientId();

function transport(): Transport {
  if (!_transport) {
    _transport = createTransport();
  }
  return _transport;
}

/** Dispatch a `tunnel.*` intent and resolve with its ack receipt. */
async function dispatchTunnelIntent(kind: string, payload: unknown): Promise<IntentAck> {
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId: _clientId });
}

/** Throw a rejected intent's error so the caller's toast/catch path fires. */
function throwIfRejected(ack: IntentAck, what: string): void {
  if (ack.status === "rejected") {
    throw new Error(ack.error?.message ?? `Failed to ${what}`);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Raise the first-connect failure toast (#2169) for any tunnel THIS client
 * dispatched a start/reconnect for whose projected status just transitioned into
 * `error`, then stop tracking it.
 *
 * Driven purely from the projected status diff (never from re-serialising the
 * handshake): we compare the previously cached states against the freshly pushed
 * ones and only fire on a genuine `→ error` transition, so a repeated/coalesced
 * diff that still shows `error` cannot re-toast, and a stale pre-dispatch `error`
 * (from an earlier failed attempt) is not mistaken for the new outcome. A tunnel
 * that instead reaches `connected` is a success — its "Started/Reconnected …"
 * toast already fired on the ack — so we simply stop tracking it, leaving a
 * later mid-session death to surface only as the Error badge.
 */
function raiseFirstConnectFailureToasts(
  prevStates: Record<string, TunnelState>,
  nextStates: Record<string, TunnelState>,
  tunnels: TunnelConfig[]
): void {
  if (_awaitingFirstConnect.size === 0) return;
  for (const [id, verb] of _awaitingFirstConnect) {
    const nextStatus = nextStates[id]?.status;
    if (nextStatus === "error" && prevStates[id]?.status !== "error") {
      const name = tunnels.find((t) => t.id === id)?.name ?? "tunnel";
      const detail = nextStates[id]?.error ?? "connection failed";
      toast.error(`Failed to ${verb} ${name}: ${detail}`);
      _awaitingFirstConnect.delete(id);
    } else if (nextStatus === "connected") {
      // Resolved successfully — the ack already toasted success. Stop watching so
      // a later mid-session drop to `error` is a badge, not a first-connect toast.
      _awaitingFirstConnect.delete(id);
    }
  }
}

/**
 * SSH tunnel domain slice — migrated onto the stateless-UI projection substrate
 * (#2150, the Phase-2 pilot of #2139).
 *
 * The authoritative tunnel state and lifecycle live in the Rust `TunnelManager`,
 * projected as the shared, versioned `tunnels` region. This slice is now a dumb
 * cache: `loadTunnels` subscribes to the region and mirrors each pushed view
 * model into `tunnels` / `tunnelStates`; the UI renders from those exactly as
 * before. User actions dispatch `tunnel.*` intents (pessimistic — the resulting
 * status/config change is reflected only when its projection diff arrives, never
 * optimistically), keeping toasts as immediate feedback on the intent ack.
 */
export interface TunnelSlice {
  tunnels: TunnelConfig[];
  tunnelStates: Record<string, TunnelState>;
  loadTunnels: () => Promise<void>;
  saveTunnel: (config: TunnelConfig) => Promise<void>;
  deleteTunnel: (tunnelId: string) => Promise<void>;
  startTunnel: (tunnelId: string) => Promise<void>;
  stopTunnel: (tunnelId: string) => Promise<void>;
  /** Force-reconnect a connected tunnel (stop + start), for a stale-but-green tunnel (#1243). */
  reconnectTunnel: (tunnelId: string) => Promise<void>;
}

export const createTunnelSlice: StateCreator<AppState, [], [], TunnelSlice> = (set, get) => ({
  tunnels: [],
  tunnelStates: {},

  loadTunnels: async () => {
    try {
      // Re-subscribing (e.g. a re-init) drops the previous region client first,
      // and any pending first-connect watches with it (they belong to the old
      // session's dispatches).
      _client?.stop();
      _awaitingFirstConnect.clear();
      const client = new ProjectionClient(transport(), TUNNELS_REGION);
      client.onChange((state) => {
        const view = (state.view ?? {}) as Partial<TunnelsView>;
        const nextStates = view.states ?? {};
        // Detect first-connect failures against the previously cached states
        // BEFORE overwriting them (#2169).
        raiseFirstConnectFailureToasts(get().tunnelStates, nextStates, view.tunnels ?? []);
        set({ tunnels: view.tunnels ?? [], tunnelStates: nextStates });
      });
      await client.start();
      _client = client;
    } catch (err) {
      frontendLog("app_store", `Failed to subscribe to tunnels projection: ${errMessage(err)}`);
    }
  },

  saveTunnel: async (config) => {
    // Create or edit: `tunnel.create` upserts. The updated list arrives as a
    // projection diff — no optimistic local mutation.
    try {
      const ack = await dispatchTunnelIntent("tunnel.create", config);
      throwIfRejected(ack, "save tunnel");
    } catch (err) {
      frontendLog("app_store", `Failed to save tunnel: ${errMessage(err)}`);
      throw err;
    }
  },

  deleteTunnel: async (tunnelId) => {
    const name = get().tunnels.find((t) => t.id === tunnelId)?.name ?? "tunnel";
    const toastId = toast.loading(`Deleting ${name}…`);
    try {
      const ack = await dispatchTunnelIntent("tunnel.remove", { id: tunnelId });
      throwIfRejected(ack, "delete tunnel");
      toast.success(`Deleted ${name}`, { id: toastId });
    } catch (err) {
      toast.error(`Failed to delete ${name}: ${errMessage(err)}`, { id: toastId });
      throw err;
    }
  },

  startTunnel: async (tunnelId) => {
    // GAP 4 (#1141): ignore a re-entrant start while a prior start for the same
    // tunnel is still in flight, so a rapid double-click can't fire a second
    // intent (spurious "already connecting/active" toast).
    if (_tunnelStartInFlight.has(tunnelId)) return;
    _tunnelStartInFlight.add(tunnelId);
    const name = get().tunnels.find((t) => t.id === tunnelId)?.name ?? "tunnel";
    const toastId = toast.loading(`Starting ${name}…`);
    try {
      // Fire-and-forget backend intent: the ack confirms the start was accepted;
      // the connecting → connected / error transitions arrive as status diffs
      // and render on the tunnel row.
      const ack = await dispatchTunnelIntent("tunnel.start", { id: tunnelId });
      throwIfRejected(ack, "start tunnel");
      toast.success(`Started ${name}`, { id: toastId });
      // Accepted — now watch for a handshake failure arriving as a projected
      // `error` transition and re-raise the failure toast then (#2169).
      _awaitingFirstConnect.set(tunnelId, "start");
    } catch (err) {
      frontendLog("app_store", `Failed to start tunnel: ${errMessage(err)}`);
      toast.error(`Failed to start ${name}: ${errMessage(err)}`, { id: toastId });
      throw err;
    } finally {
      _tunnelStartInFlight.delete(tunnelId);
    }
  },

  stopTunnel: async (tunnelId) => {
    // GAP 4 (#1141): ignore a re-entrant stop while a prior stop for the same
    // tunnel is still in flight (see startTunnel).
    if (_tunnelStopInFlight.has(tunnelId)) return;
    _tunnelStopInFlight.add(tunnelId);
    const name = get().tunnels.find((t) => t.id === tunnelId)?.name ?? "tunnel";
    const toastId = toast.loading(`Stopping ${name}…`);
    try {
      const ack = await dispatchTunnelIntent("tunnel.stop", { id: tunnelId });
      throwIfRejected(ack, "stop tunnel");
      toast.success(`Stopped ${name}`, { id: toastId });
    } catch (err) {
      frontendLog("app_store", `Failed to stop tunnel: ${errMessage(err)}`);
      toast.error(`Failed to stop ${name}: ${errMessage(err)}`, { id: toastId });
      throw err;
    } finally {
      _tunnelStopInFlight.delete(tunnelId);
    }
  },

  reconnectTunnel: async (tunnelId) => {
    // Force-reconnect a connected tunnel: tear it down and start it again, even
    // if the backend supervisor's liveness has not fired yet — covers a
    // stale-but-green tunnel (#1243). Guarded by the same in-flight sets as
    // start/stop so a rapid double-click cannot overlap the sequence.
    if (_tunnelStartInFlight.has(tunnelId) || _tunnelStopInFlight.has(tunnelId)) return;
    _tunnelStopInFlight.add(tunnelId);
    _tunnelStartInFlight.add(tunnelId);
    const name = get().tunnels.find((t) => t.id === tunnelId)?.name ?? "tunnel";
    const toastId = toast.loading(`Reconnecting ${name}…`);
    try {
      const ack = await dispatchTunnelIntent("tunnel.reconnect", { id: tunnelId });
      throwIfRejected(ack, "reconnect tunnel");
      toast.success(`Reconnected ${name}`, { id: toastId });
      // Accepted — watch for the stop→start sequence failing during its
      // handshake, arriving as a projected `error` transition (#2169).
      _awaitingFirstConnect.set(tunnelId, "reconnect");
    } catch (err) {
      frontendLog("app_store", `Failed to reconnect tunnel: ${errMessage(err)}`);
      toast.error(`Failed to reconnect ${name}: ${errMessage(err)}`, { id: toastId });
      throw err;
    } finally {
      _tunnelStopInFlight.delete(tunnelId);
      _tunnelStartInFlight.delete(tunnelId);
    }
  },
});
