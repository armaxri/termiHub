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

import { useEffect, useState } from "react";

import { useAppStore } from "@/store/appStore";
import {
  effectiveAutoReconnect,
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
