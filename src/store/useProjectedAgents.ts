/**
 * `useProjectedAgents` — the agent sidebar & Open Connections cut to the projected
 * `agents` region (#2226 render cut, part of #2139).
 *
 * The agent sidebar renders the ordered remote-agent list (each agent's connection
 * status plus its live sessions, saved definitions and folders) and Open
 * Connections renders one row per connected/establishing agent and its sessions.
 * Through the shadow step both read `appStore`'s agents slice (`remoteAgents` /
 * `agentSessions` / `agentDefinitions` / `agentFolders`) directly. This hook makes
 * them source that slice from the shared `agents` projection region instead — the
 * direct analog of {@link import("./useProjectedMonitors").useProjectedMonitors}
 * (#2224) and {@link import("./useSessionLifecycle").useSessionAutoReconnect}
 * (#2204).
 *
 * # Safety (strangler)
 *
 * - **Gated** by {@link agentRenderFromProjectionEnabled} (on by default). Flag
 *   off ⇒ the hook returns `appStore`'s slice verbatim.
 * - **Faithful-mirror gate.** The projection sources the render only when it
 *   deep-equals the `appStore` slice ({@link agentsViewMirrors}); otherwise the
 *   hook falls back to `appStore` (never a stale view). While `appStore` stays
 *   authoritative (the mutation cut is a later step) the region is kept a mirror
 *   by {@link seedAgentsRegion}, so it is always populated — making the cut
 *   parity-safe and independent of the mutation flag.
 */

import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "@/store/appStore";
import {
  agentRenderFromProjectionEnabled,
  agentsViewMirrors,
  currentAgentsView,
  ensureAgentsSubscribed,
  logAgentBridgeFallback,
  onAgentsView,
  seedAgentsRegion,
  type AgentsView,
} from "@/store/agentsBridge";

/**
 * The effective agents slice for rendering: the ordered `remoteAgents` list plus
 * the per-agent `agentSessions` / `agentDefinitions` / `agentFolders` maps, sourced
 * from the projected `agents` region when it faithfully mirrors `appStore`,
 * otherwise `appStore`'s slice verbatim (flag off, region not yet caught up, or a
 * transport that cannot subscribe).
 */
export function useProjectedAgents(): AgentsView {
  const remoteAgents = useAppStore((s) => s.remoteAgents);
  const agentSessions = useAppStore((s) => s.agentSessions);
  const agentDefinitions = useAppStore((s) => s.agentDefinitions);
  const agentFolders = useAppStore((s) => s.agentFolders);

  // Read the flag once at mount: it flips only via dev tooling, and the
  // subscription lifecycle is keyed off it below.
  const [enabled] = useState(() => agentRenderFromProjectionEnabled());

  const [view, setView] = useState<AgentsView | undefined>(undefined);

  // Subscribe to the shared agents region while enabled; a transport that cannot
  // subscribe (non-Tauri without a socket) just leaves the UI on the appStore
  // fallback.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unsubscribe = onAgentsView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureAgentsSubscribed` builds the transport eagerly, so a non-Tauri env
    // without a socket throws synchronously (not just a rejection) — guard both so
    // the UI silently stays on the appStore fallback.
    try {
      ensureAgentsSubscribed()
        .then(() => {
          if (!cancelled) setView(currentAgentsView());
        })
        .catch((err) => logAgentBridgeFallback("subscribe", err));
    } catch (err) {
      logAgentBridgeFallback("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);

  const matches =
    enabled && agentsViewMirrors(view, remoteAgents, agentSessions, agentDefinitions, agentFolders);

  // Keep the region a faithful mirror of appStore's slice. Only once a view has
  // arrived (so we are subscribed) and it is not already a mirror; de-duped inside
  // `seedAgentsRegion` so a settled slice is not re-seeded on every render.
  useEffect(() => {
    if (!enabled || matches || view === undefined) return;
    seedAgentsRegion(remoteAgents, agentSessions, agentDefinitions, agentFolders).catch((err) =>
      logAgentBridgeFallback("seed", err)
    );
  }, [enabled, matches, view, remoteAgents, agentSessions, agentDefinitions, agentFolders]);

  return useMemo(() => {
    if (matches && view) return view;
    return { remoteAgents, agentSessions, agentDefinitions, agentFolders };
  }, [matches, view, remoteAgents, agentSessions, agentDefinitions, agentFolders]);
}
