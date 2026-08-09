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
 * # Safety (strangler)
 *
 * - **Gated** by {@link sessionRenderFromProjectionEnabled} (on by default). Flag
 *   off ⇒ the hook returns `appStore`'s record verbatim.
 * - **Faithful-mirror gate.** The projection sources the render only when its
 *   `reconnect` detail mirrors the local record ({@link projectedReconnectMirrors});
 *   otherwise the hook falls back to the local record (never a stale one). The
 *   local record always seeds the effective view, so it is populated even when
 *   nothing has written the backend region ({@link sessionIntentsEnabled} off) —
 *   making the cut parity-safe and independent of the mutation flag.
 */

import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "@/store/appStore";
import {
  currentSessionView,
  effectiveAutoReconnect,
  effectiveConnecting,
  effectiveConnectingMap,
  effectiveDisconnectError,
  effectiveDisconnectErrorMap,
  effectiveReconnecting,
  effectiveReconnectingMap,
  effectiveReconnectTriggerError,
  ensureSessionSubscribed,
  logSessionBridgeFallback,
  onSessionView,
  type ProjectedSessionLifecycle,
  type SessionLifecycleView,
  sessionRenderFromProjectionEnabled,
} from "@/store/sessionBridge";
import type { TerminalAutoReconnectState } from "@/types/terminal";

/**
 * The auto-reconnect display record for one tab: loop numbers sourced from the
 * projected `session-lifecycle` region when it faithfully mirrors `appStore`,
 * otherwise `appStore`'s `terminalAutoReconnect` record verbatim (flag off, region
 * not yet populated / mirroring, or a transport that cannot subscribe).
 * `undefined` when no auto-reconnect loop is active for the tab.
 */
export function useSessionAutoReconnect(tabId: string): TerminalAutoReconnectState | undefined {
  const record = useAppStore((s) => s.terminalAutoReconnect[tabId]);

  // Read the flag once at mount: it flips only via dev tooling, and the
  // subscription lifecycle is keyed off it below.
  const [enabled] = useState(() => sessionRenderFromProjectionEnabled());

  const [projected, setProjected] = useState<ProjectedSessionLifecycle | undefined>(undefined);

  // Subscribe to the shared session-lifecycle region while enabled; a transport
  // that cannot subscribe (non-Tauri without a socket) just leaves the overlay on
  // the appStore fallback.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unsubscribe = onSessionView((next) => {
      if (!cancelled) setProjected(next[tabId]);
    });
    // `ensureSessionSubscribed` builds the transport eagerly, so a non-Tauri env
    // without a socket throws synchronously (not just a rejection) — guard both so
    // the overlay silently stays on the appStore fallback.
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
  }, [enabled, tabId]);

  return effectiveAutoReconnect(record, enabled ? projected : undefined);
}

/**
 * The per-tab session-status slice the terminal overlays render: the connect /
 * reconnect flags and the disconnect error, sourced from the projected
 * `session-lifecycle` region when it faithfully mirrors `appStore` and otherwise
 * from `appStore` verbatim (#2205 PR-A render cut).
 */
export interface ProjectedSessionLifecycleSlice {
  /** True while an initial connect is in flight (mirrors `terminalConnecting`). */
  connecting: boolean;
  /** True while the agent is actively reconnecting (mirrors `terminalReconnectingTabs`). */
  reconnecting: boolean;
  /** The failed-(re)connect error, if any (mirrors `terminalDisconnectErrors`). */
  disconnectError: string | undefined;
  /** The reconnect-trigger cause shown while reconnecting, if any (mirrors
   * `terminalReconnectTriggerErrors`, #2442). */
  reconnectTriggerError: string | undefined;
  /** True when the projected status is the terminal `sessionLost` state (#2512):
   * a resilient agent tab reconnected its transport but its live agent session
   * could not be recovered. Sourced directly from the region (no `appStore` twin —
   * the state is only ever emitted server-side, behind `sessionBackendReattach`). */
  sessionLost: boolean;
  /** The backend-supplied "why the session could not be recovered" message shown
   * in the session-lost notice, if any (#2512). `undefined` unless `sessionLost`. */
  sessionLostError: string | undefined;
}

/**
 * `useProjectedSessionLifecycle` — the per-tab render cut for the terminal
 * lifecycle overlays (#2205 PR-A). Returns the connect / reconnect flags and the
 * disconnect error for one tab, sourced from the shared `session-lifecycle`
 * projection region under the faithful-mirror gate, with an `appStore` fallback so
 * the rendered output is byte-identical to the pre-cut path. The direct analog of
 * {@link useSessionAutoReconnect} for the coarse status fields.
 *
 * `appStore` remains the authoritative writer (its slices, the
 * `driveAutoReconnect` engine and the client `session.*` dispatch are untouched by
 * PR-A) — this hook only changes where components *read*.
 */
export function useProjectedSessionLifecycle(tabId: string): ProjectedSessionLifecycleSlice {
  const connectingLocal = useAppStore((s) => s.terminalConnecting[tabId] ?? false);
  const reconnectingLocal = useAppStore((s) => s.terminalReconnectingTabs[tabId] ?? false);
  const disconnectErrorLocal = useAppStore((s) => s.terminalDisconnectErrors[tabId]);
  const reconnectTriggerErrorLocal = useAppStore((s) => s.terminalReconnectTriggerErrors[tabId]);

  // Read the flag once at mount: it flips only via dev tooling, and the
  // subscription lifecycle is keyed off it below.
  const [enabled] = useState(() => sessionRenderFromProjectionEnabled());

  const [projected, setProjected] = useState<ProjectedSessionLifecycle | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unsubscribe = onSessionView((next) => {
      if (!cancelled) setProjected(next[tabId]);
    });
    // `ensureSessionSubscribed` builds the transport eagerly, so a non-Tauri env
    // without a socket throws synchronously (not just a rejection) — guard both so
    // the reader silently stays on the appStore fallback.
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
  }, [enabled, tabId]);

  const p = enabled ? projected : undefined;
  // `sessionLost` has no `appStore` twin to gate against (it is emitted only
  // server-side, behind `sessionBackendReattach`), so it is read straight from the
  // region: present ⇒ terminal session-lost, absent ⇒ false. When the render cut
  // is off `p` is `undefined`, so it stays `false` — inert on the pre-cut path.
  const lost = p?.status === "sessionLost";
  return {
    connecting: effectiveConnecting(connectingLocal, p),
    reconnecting: effectiveReconnecting(reconnectingLocal, p),
    disconnectError: effectiveDisconnectError(disconnectErrorLocal, p),
    reconnectTriggerError: effectiveReconnectTriggerError(reconnectTriggerErrorLocal, p),
    sessionLost: lost,
    sessionLostError: lost ? p?.error : undefined,
  };
}

/**
 * The tab-id-keyed session-status maps the list consumers render: the tab-strip
 * status dot ({@link import("@/utils/tabStatus").deriveTabStatus}), Open
 * Connections' connecting filter and the split-panel overlay gates all read the
 * whole maps rather than a single tab. Same fields, same faithful-mirror gate as
 * {@link useProjectedSessionLifecycle}, sourced from the region view.
 */
export interface ProjectedSessionLifecycleMaps {
  terminalConnecting: Record<string, boolean>;
  terminalReconnectingTabs: Record<string, boolean>;
  terminalDisconnectErrors: Record<string, string>;
}

/**
 * `useProjectedSessionLifecycleMaps` — the map-level render cut for the list
 * consumers (#2205 PR-A). Subscribes to the shared `session-lifecycle` region once
 * and returns the connect / reconnect / disconnect-error maps sourced through the
 * faithful-mirror gate, falling back to `appStore` per key. Byte-identical to the
 * pre-cut `appStore` reads; the analog of
 * {@link import("./useLayoutRenderTree").useLayoutRenderTree} for the lifecycle
 * status maps.
 */
export function useProjectedSessionLifecycleMaps(): ProjectedSessionLifecycleMaps {
  const connectingLocal = useAppStore((s) => s.terminalConnecting);
  const reconnectingLocal = useAppStore((s) => s.terminalReconnectingTabs);
  const disconnectErrorsLocal = useAppStore((s) => s.terminalDisconnectErrors);

  const [enabled] = useState(() => sessionRenderFromProjectionEnabled());

  const [view, setView] = useState<Record<string, ProjectedSessionLifecycle>>(() =>
    currentSessionView()
  );

  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled]);

  return useMemo(() => {
    if (!enabled) {
      return {
        terminalConnecting: connectingLocal,
        terminalReconnectingTabs: reconnectingLocal,
        terminalDisconnectErrors: disconnectErrorsLocal,
      };
    }
    return {
      terminalConnecting: effectiveConnectingMap(connectingLocal, view),
      terminalReconnectingTabs: effectiveReconnectingMap(reconnectingLocal, view),
      terminalDisconnectErrors: effectiveDisconnectErrorMap(disconnectErrorsLocal, view),
    };
  }, [enabled, connectingLocal, reconnectingLocal, disconnectErrorsLocal, view]);
}
