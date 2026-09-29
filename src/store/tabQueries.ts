/**
 * Tab lookups over the composed layout (ARCH-001/FES-011, #2881): editor-tab
 * identity, broadcast target resolution, the connected-terminal filter and the
 * monitor key. Moved verbatim out of `appStore.ts` (which re-exports them) so
 * slices import them without pulling in the root store.
 */

import type {
  BroadcastScope,
  EditorSessionRef,
  EditorTabMeta,
  PanelNode,
  TabGroup,
  TerminalTab,
} from "@/types/terminal";
import { deriveTabStatus, type TabStatusMaps } from "@/utils/tabStatus";
import { findLeafByTab, getAllLeaves } from "@/utils/panelTree";
import {
  currentSessionView,
  effectiveConnectingMap,
  effectiveDisconnectErrorMap,
  effectiveExitedMap,
  effectiveEvictedMap,
  effectiveReconnectingMap,
} from "@/store/sessionBridge";
import type { AppState } from "./appStore";
import { collectLiveTabs, getComposedLayout, type LayoutViewState } from "./layoutHelpers";

/**
 * Resolve the stable identity of the remote session backing an editor tab, used
 * as part of the {@link AppState.openEditorTab} dedup key (#1599).
 *
 * The raw session id is deliberately *not* used: it changes when a connection
 * reconnects, which would spawn a duplicate tab instead of refreshing the
 * existing one. Instead this returns a value that stays constant across a
 * reconnect of the same logical connection but differs between distinct
 * connections, so opening the same path on two different hosts yields two tabs
 * while reconnecting one host refreshes its tab:
 *
 * - Session layer (`sessionBrowser`) → the id of the terminal tab that owns the
 *   session. A reconnect swaps the session id but keeps the same tab.
 *
 * Returns `undefined` for local tabs and for remote tabs whose identity cannot
 * be resolved (no owning tab found); callers then fall back to path-only dedup,
 * preserving the pre-#1599 behaviour.
 */
export function resolveEditorSessionKey(
  state: { rootPanel: PanelNode },
  isRemote: boolean,
  sessionBrowser?: EditorSessionRef
): string | undefined {
  if (!isRemote) return undefined;
  if (sessionBrowser) {
    const owner = getAllLeaves(state.rootPanel)
      .flatMap((l) => l.tabs)
      .find((t) => t.sessionId === sessionBrowser.sessionId);
    return owner ? `session:${owner.id}` : undefined;
  }
  return undefined;
}

/**
 * Derive the sudo host label (`user@host:port`) for a session-backed remote
 * editor tab, or `null` when none applies.
 *
 * The file editor's sudo flow uses this label to (a) name the host in the
 * sudo-password prompt and (b) namespace the optional credential-store entry for
 * a remembered sudo password. Two properties are load-bearing (#2424 / #2426):
 *
 * - **Reconnect-stable** — the saved sudo password must keep resolving after the
 *   owning terminal reconnects. The owning tab is therefore located by its
 *   *stable id* (encoded in the editor tab's reconnect-stable `sessionKey`,
 *   `session:<owningTabId>`), falling back to the live `sessionBrowser.sessionId`
 *   only when no `sessionKey` is present. A reconnect swaps the session id but
 *   keeps the tab (and its connection config), so the label value is unchanged.
 * - **Byte-identical to the legacy SFTP label** — before SSH file editing
 *   converged onto the session path (#2420 / #2421) and the `sftpSessionId` model
 *   was retired (#2422), this label came from `sftpSessions[id].hostLabel`, built
 *   as `${username}@${host}:${port}` from the connection config. Reproducing that
 *   exact string here means sudo passwords saved before the convergence still
 *   resolve — the migration does not orphan them.
 *
 * Returns `null` for local tabs, tabs whose owning terminal cannot be found, and
 * non-labelable backends (e.g. Docker / FTP / agent, which carry no
 * `user@host:port`); callers then fall back to the file path, preserving the
 * pre-convergence graceful-degradation behaviour.
 */
export function deriveEditorHostLabel(
  state: LayoutViewState,
  meta: Pick<EditorTabMeta, "isRemote" | "sessionBrowser" | "sessionKey">
): string | null {
  if (!meta.isRemote || !meta.sessionBrowser) return null;
  const tabs = getAllLeaves(getComposedLayout(state).rootPanel).flatMap((l) => l.tabs);
  const owningTabId = meta.sessionKey?.startsWith("session:")
    ? meta.sessionKey.slice("session:".length)
    : undefined;
  const owner =
    (owningTabId ? tabs.find((t) => t.id === owningTabId) : undefined) ??
    tabs.find((t) => t.sessionId === meta.sessionBrowser?.sessionId);
  if (!owner) return null;
  const cfg = owner.config.config;
  const { username, host, port } = cfg;
  // A labelable connection (SSH) carries all three; byte-based backends
  // (Docker / FTP / agent) don't, so they fall through to the path fallback.
  if (typeof host !== "string" || host === "" || typeof username !== "string" || port == null) {
    return null;
  }
  return `${username}@${host}:${port}`;
}

/**
 * Resolve the terminal tab ids that belong to a broadcast {@link BroadcastScope}
 * given the tab that owns input (the source). Only *terminal* tabs are eligible
 * — non-terminal tabs (editors, SFTP/file browsers, ...) are never broadcast
 * targets, matching the concept's "Non-terminal tabs never appear" rule.
 *
 * - `"all"` — every terminal tab in the source tab's own group.
 * - `"panel"` — every terminal tab in the same split panel as the source.
 * - `"custom"` — `[]`; membership comes from the user's picker, not the scope.
 *
 * Exported for the scope dropdown's live counts and the dynamic-membership tests
 * (#1956). Resolves within the **source tab's own group tree** — not the active
 * group — so broadcast never silently retargets to a terminal in a different,
 * possibly invisible tab group when the source is not in the active group
 * (#1980). The active group's live tree is `state.rootPanel`; every other
 * group keeps its tree in `group.rootPanel`.
 */
export function resolveBroadcastTargetTabIds(
  state: { tabGroups: TabGroup[]; activeTabGroupId: string; rootPanel: PanelNode },
  scope: BroadcastScope,
  sourceTabId: string
): string[] {
  if (scope === "custom") return [];
  const isTerminal = (t: TerminalTab): boolean => t.contentType === "terminal";
  // Find the source's own group tree (active group's live tree is `rootPanel`;
  // inactive groups keep theirs in `group.rootPanel`). Fall back to the active
  // tree if the source cannot be located (shouldn't happen for a live source).
  const trees = state.tabGroups.map((g) =>
    g.id === state.activeTabGroupId ? state.rootPanel : g.rootPanel
  );
  const sourceTree = trees.find((tree) => findLeafByTab(tree, sourceTabId)) ?? state.rootPanel;
  if (scope === "panel") {
    const leaf = findLeafByTab(sourceTree, sourceTabId);
    if (!leaf) return [];
    return leaf.tabs.filter(isTerminal).map((t) => t.id);
  }
  // "all" — every terminal tab in the source's group
  return getAllLeaves(sourceTree)
    .flatMap((leaf) => leaf.tabs)
    .filter(isTerminal)
    .map((t) => t.id);
}

/**
 * The subset of `tabIds` that are *connected* terminal tabs able to receive
 * input right now — live, terminal content, backed by a session, status
 * `connected`, and not taken over by another desktop/window (SM-003 / #3368).
 * Order follows `tabIds`. The single connected-terminal filter shared by the
 * broadcast fan-out ({@link AppState.getBroadcastTargetTabIds}) and multi-target
 * macro playback (PROD-042, #3443), so both skip exactly the same tabs.
 */
export function filterConnectedTerminalTabIds(state: AppState, tabIds: Iterable<string>): string[] {
  // Connect / reconnect / disconnect-error / exited status is sourced from the
  // shared `session-lifecycle` region — the sole authority since the `appStore`
  // twins were removed (#2205 PR-B / #2625); only spawn errors stay per-client.
  const sessionView = currentSessionView();
  const statusMaps: TabStatusMaps = {
    terminalConnecting: effectiveConnectingMap(sessionView),
    terminalReconnectingTabs: effectiveReconnectingMap(sessionView),
    terminalSpawnErrors: state.terminalSpawnErrors,
    terminalDisconnectErrors: effectiveDisconnectErrorMap(sessionView),
    terminalExitedTabs: effectiveExitedMap(sessionView),
    // SM-003: a tab another desktop took over must never receive input.
    terminalEvicted: effectiveEvictedMap(sessionView),
  };
  const tabsById = new Map(collectLiveTabs(state).map((t) => [t.id, t]));
  const result: string[] = [];
  for (const tabId of tabIds) {
    const tab = tabsById.get(tabId);
    // Only connected terminal sessions receive input. Disconnected/
    // connecting sessions and non-terminal tabs are skipped silently.
    if (!tab || tab.contentType !== "terminal" || !tab.sessionId) continue;
    if (deriveTabStatus(statusMaps, tabId) !== "connected") continue;
    // #3368: nor a tab whose session another window took over.
    if (state.isSessionWindowEvicted(tab.sessionId)) continue;
    result.push(tabId);
  }
  return result;
}

/**
 * Derive the monitor key for a tab: the id of the terminal session that owns the
 * monitor. Every monitor — desktop-direct SSH and remote-session alike — routes
 * through the session-based `MonitoringProvider` push path (#1232), so the key is
 * uniformly the session id. Returns `null` when the tab has no session yet (so it
 * cannot be monitored).
 *
 * Monitor entries themselves live in the authoritative `system-monitors` region
 * (#2224), not in `appStore`: read them with
 * {@link import("./useProjectedMonitors").useProjectedMonitors} (components) or
 * {@link import("./systemMonitorBridge").currentMonitorsView} (store-side), then
 * index by this key.
 */
export function monitorKeyForTab(tab: TerminalTab | null | undefined): string | null {
  return tab?.sessionId ?? null;
}
