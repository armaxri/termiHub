/**
 * `useSessionAutoReconnect` — the terminal overlays' cut to the projected
 * session-lifecycle status (#2204 step 3, part of #2152 / #2139).
 *
 * The agentless auto-reconnect countdown overlay renders the loop's live detail
 * (phase, attempt, backoff countdown). Through step 2 that detail came straight
 * from `appStore.terminalAutoReconnect` (the local display record the imperative
 * backoff timer maintains). Step 3 makes the overlay source that detail from the
 * shared `session-lifecycle` projection region instead — the direct analog of the
 * layout render cut ({@link import("./useLayoutRenderTree").useLayoutRenderTree},
 * #2151 step 3).
 *
 * The hook returns the {@link TerminalAutoReconnectState} the overlay renders:
 * the loop numbers from the projection, the per-client presentation (wall-clock
 * anchor, on-reconnect command) re-attached from the local record — the
 * partial-projection seam ({@link effectiveAutoReconnect}).
 *
 * # Safety
 *
 * - **Faithful-mirror gate.** The projection sources the render only when its
 *   `reconnect` detail mirrors the local record ({@link projectedReconnectMirrors});
 *   otherwise the hook falls back to the local record (never a stale one). The
 *   local record always seeds the effective view, so it is populated even before
 *   anything has written the backend region — making the cut parity-safe.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { onReconnectCommandForTabId } from "@/store/appStore";
import {
  currentSessionView,
  effectiveAutoReconnect,
  effectiveConnecting,
  effectiveConnectingMap,
  effectiveDisconnectError,
  effectiveDisconnectErrorMap,
  effectiveExited,
  effectiveExitedMap,
  effectiveExitInfo,
  effectiveReconnecting,
  effectiveReconnectingMap,
  effectiveReconnectTriggerError,
  ensureSessionSubscribed,
  logSessionBridgeFallback,
  onSessionView,
  type ProjectedSessionLifecycle,
  type SessionLifecycleView,
} from "@/store/sessionBridge";
import type { TerminalAutoReconnectState, TerminalExitInfo } from "@/types/terminal";

/**
 * The auto-reconnect display record for one tab: loop numbers sourced from the
 * projected `session-lifecycle` region when it faithfully mirrors `appStore`,
 * otherwise `appStore`'s `terminalAutoReconnect` record verbatim (region not yet
 * populated / mirroring, or a transport that cannot subscribe).
 * `undefined` when no auto-reconnect loop is active for the tab.
 */
export function useSessionAutoReconnect(tabId: string): TerminalAutoReconnectState | undefined {
  const [projected, setProjected] = useState<ProjectedSessionLifecycle | undefined>(undefined);

  // Subscribe to the shared session-lifecycle region — the sole source of the
  // reconnect loop (#2205 PR-B). A transport that cannot subscribe (non-Tauri
  // without a socket) simply leaves the overlay with no active loop.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onSessionView((next) => {
      if (!cancelled) setProjected(next[tabId]);
    });
    // `ensureSessionSubscribed` builds the transport eagerly, so a non-Tauri env
    // without a socket throws synchronously (not just a rejection) — guard both.
    try {
      ensureSessionSubscribed()
        .then((client) => {
          if (cancelled) return;
          const view = client.state.view as SessionLifecycleView | undefined;
          setProjected(view?.sessions?.[tabId]);
        })
        .catch((err) => logSessionBridgeFallback("subscribe", err));
    } catch (err) {
      logSessionBridgeFallback("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [tabId]);

  // The wall-clock anchor for the countdown: `nextAttemptAt = now0 + delayMs`.
  // Fixed once per backoff window (keyed by attempt + delay) so the live
  // countdown keeps a stable deadline instead of re-anchoring on every render —
  // the per-client presentation the region does not carry. Re-anchors when the
  // loop advances to a new attempt; cleared when no `waiting` window is active.
  const anchorRef = useRef<{ key: string; now0: number } | null>(null);
  const onReconnectCommand = onReconnectCommandForTabId(tabId);

  if (projected?.reconnect.phase === "waiting") {
    const key = `${projected.reconnect.attempt}:${projected.reconnect.delayMs}`;
    if (anchorRef.current?.key !== key) {
      anchorRef.current = { key, now0: Date.now() };
    }
    return effectiveAutoReconnect(projected, anchorRef.current.now0, onReconnectCommand);
  }
  anchorRef.current = null;
  return effectiveAutoReconnect(projected, Date.now(), onReconnectCommand);
}

/**
 * The per-tab session-status slice the terminal overlays render: the connect /
 * reconnect flags, the disconnect error, the exit cause and the exited mount gate,
 * all sourced purely from the projected `session-lifecycle` region (#2625 — the
 * per-client `appStore` twins were deleted once the region became authoritative).
 */
export interface ProjectedSessionLifecycleSlice {
  /** True while an initial connect is in flight (region `status: connecting`). */
  connecting: boolean;
  /** True while the agent is actively reconnecting (region `status: reconnecting`). */
  reconnecting: boolean;
  /** The failed-(re)connect error, if any (region `status: failed` + `error`). */
  disconnectError: string | undefined;
  /** The reconnect-trigger cause shown while reconnecting, if any (mirrors
   * `terminalReconnectTriggerErrors`, #2442). */
  reconnectTriggerError: string | undefined;
  /** True when the projected status is the terminal `sessionLost` state (#2512):
   * a resilient agent tab reconnected its transport but its live agent session
   * could not be recovered. Sourced directly from the region (no `appStore` twin —
   * the state is only ever emitted server-side by the backend redrive). */
  sessionLost: boolean;
  /** The backend-supplied "why the session could not be recovered" message shown
   * in the session-lost notice, if any (#2512). `undefined` unless `sessionLost`. */
  sessionLostError: string | undefined;
  /** How the session ended (#2615): the exit cause + code the disconnect overlay
   * derives its heading / subheading wording from. Sourced purely from the
   * projected region's `exit` metadata (#2625). `undefined` when no exit recorded. */
  exitInfo: TerminalExitInfo | undefined;
  /** True when the session has **exited** (#2621): the overlay/view-mode **mount**
   * gate, derived purely from the region's terminal statuses / `exit` metadata
   * ({@link effectiveExited}, #2625). */
  exited: boolean;
}

/**
 * `useProjectedSessionLifecycle` — the per-tab render cut for the terminal
 * lifecycle overlays (#2205 PR-A). Returns the connect / reconnect flags, the
 * disconnect error, the exit cause and the exited mount gate for one tab, sourced
 * purely from the shared `session-lifecycle` projection region (#2625 — the
 * per-client `appStore` twins were deleted). The direct analog of
 * {@link useSessionAutoReconnect} for the coarse status fields.
 */
export function useProjectedSessionLifecycle(tabId: string): ProjectedSessionLifecycleSlice {
  // The connect / reconnect / trigger status, the disconnect error, the exit cause
  // and the exited mount gate are all sourced purely from the region now the
  // per-client `terminalDisconnectErrors` / `terminalExitInfo` / `terminalExitedTabs`
  // slices are deleted (#2625).
  const [projected, setProjected] = useState<ProjectedSessionLifecycle | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onSessionView((next) => {
      if (!cancelled) setProjected(next[tabId]);
    });
    // `ensureSessionSubscribed` builds the transport eagerly, so a non-Tauri env
    // without a socket throws synchronously (not just a rejection) — guard both.
    try {
      ensureSessionSubscribed()
        .then((client) => {
          if (cancelled) return;
          const view = client.state.view as SessionLifecycleView | undefined;
          setProjected(view?.sessions?.[tabId]);
        })
        .catch((err) => logSessionBridgeFallback("subscribe", err));
    } catch (err) {
      logSessionBridgeFallback("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [tabId]);

  const p = projected;
  const lost = p?.status === "sessionLost";
  return {
    connecting: effectiveConnecting(p),
    reconnecting: effectiveReconnecting(p),
    disconnectError: effectiveDisconnectError(p),
    reconnectTriggerError: effectiveReconnectTriggerError(p),
    sessionLost: lost,
    sessionLostError: lost ? p?.error : undefined,
    exitInfo: effectiveExitInfo(p),
    exited: effectiveExited(p),
  };
}

/**
 * The tab-id-keyed session-status maps the list consumers render: the tab-strip
 * status dot ({@link import("@/utils/tabStatus").deriveTabStatus}), Open
 * Connections' connecting filter and the split-panel overlay gates all read the
 * whole maps rather than a single tab. Same fields as
 * {@link useProjectedSessionLifecycle}, sourced purely from the region view (#2625).
 */
export interface ProjectedSessionLifecycleMaps {
  terminalConnecting: Record<string, boolean>;
  terminalReconnectingTabs: Record<string, boolean>;
  terminalDisconnectErrors: Record<string, string>;
  /**
   * Tabs whose live session is terminally lost (#2512). Region-only (no `appStore`
   * twin), so this is empty on the pre-cut path. It drives the tab-strip dot away
   * from a stale-green "connected" when the session could not be recovered (#2524).
   */
  terminalSessionLost: Record<string, boolean>;
  /** Tabs whose session has **exited** (#2621): the overlay/view-mode mount gate,
   * derived purely from the region ({@link effectiveExitedMap}, #2625). Drives the
   * tab-strip status dot and the close-confirmation live count. */
  terminalExitedTabs: Record<string, boolean>;
}

/** Build the `tabId → true` session-lost map from the projected region view. */
function sessionLostMap(view: Record<string, ProjectedSessionLifecycle>): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const [tabId, life] of Object.entries(view)) {
    if (life.status === "sessionLost") map[tabId] = true;
  }
  return map;
}

/**
 * `useProjectedSessionLifecycleMaps` — the map-level render cut for the list
 * consumers (#2205 PR-A). Subscribes to the shared `session-lifecycle` region once
 * and returns the connect / reconnect / disconnect-error / exited maps sourced
 * purely from the region view (#2625); the analog of
 * {@link import("./useLayoutRenderTree").useLayoutRenderTree} for the lifecycle
 * status maps.
 */
export function useProjectedSessionLifecycleMaps(): ProjectedSessionLifecycleMaps {
  // Connect / reconnect / disconnect-error and the exited map are all sourced
  // purely from the region now the per-client `terminalDisconnectErrors` /
  // `terminalExitedTabs` slices are deleted (#2625).
  const [view, setView] = useState<Record<string, ProjectedSessionLifecycle>>(() =>
    currentSessionView()
  );

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onSessionView((next) => {
      if (!cancelled) setView(next);
    });
    try {
      ensureSessionSubscribed()
        .then((client) => {
          if (cancelled) return;
          const clientView = client.state.view as SessionLifecycleView | undefined;
          setView(clientView?.sessions ?? {});
        })
        .catch((err) => logSessionBridgeFallback("subscribe", err));
    } catch (err) {
      logSessionBridgeFallback("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return useMemo(
    () => ({
      terminalConnecting: effectiveConnectingMap(view),
      terminalReconnectingTabs: effectiveReconnectingMap(view),
      terminalDisconnectErrors: effectiveDisconnectErrorMap(view),
      terminalSessionLost: sessionLostMap(view),
      terminalExitedTabs: effectiveExitedMap(view),
    }),
    [view]
  );
}
