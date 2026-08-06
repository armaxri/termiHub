/**
 * `useProjectedAgents` — the agent sidebar & Open Connections read the
 * **authoritative** `agents` projection region (#2226 hook-authoritative cut / PR A,
 * part of #2139).
 *
 * The agent sidebar renders the ordered remote-agent list (each agent's connection
 * status plus its live sessions, saved definitions and folders) and Open
 * Connections renders one row per connected/establishing agent and its sessions.
 * They source that slice from the shared `agents` projection region, which is now
 * **authoritative**: the backend {@link import("../../src-tauri/src/agents_projection/store").AgentsStore}
 * is fed at the source — agent status / CRUD streams fold every transition (#2388)
 * and the server owns agent entry-creation + the startup list-load (#2403) — so the
 * region is populated from boot and reflects every backend transition. The direct
 * analog of {@link import("./useProjectedConnections").useProjectedConnections}
 * (#2225) and {@link import("./useProjectedSettings").useProjectedSettings} (#2227).
 *
 * The hook subscribes to the region (one shared subscription, fanned out by the
 * bridge) and returns the latest projected view, re-rendering on every diff. It
 * seeds from {@link currentAgentsView} so a consumer mounting after the first diff
 * already has the current picture, and from {@link EMPTY_AGENTS_VIEW} before any
 * diff has arrived. There is no `appStore` seed, mirror gate, or fallback — the
 * region is the source of truth.
 */

import { useEffect, useState } from "react";

import {
  currentAgentsView,
  EMPTY_AGENTS_VIEW,
  ensureAgentsSubscribed,
  logAgentBridgeFallback,
  onAgentsView,
  type AgentsView,
} from "@/store/agentsBridge";

/**
 * The current agents slice for rendering — the ordered `remoteAgents` list plus the
 * per-agent `agentSessions` / `agentDefinitions` / `agentFolders` maps — sourced
 * from the authoritative `agents` projection region.
 */
export function useProjectedAgents(): AgentsView {
  const [view, setView] = useState<AgentsView>(() => currentAgentsView() ?? EMPTY_AGENTS_VIEW);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onAgentsView((next) => {
      if (!cancelled) setView(next);
    });
    // `ensureAgentsSubscribed` builds the transport eagerly, so a non-Tauri env
    // without a socket throws synchronously (not just a rejection) — guard both so
    // the hook silently stays on the last-known (or empty) view.
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
  }, []);

  return view;
}
