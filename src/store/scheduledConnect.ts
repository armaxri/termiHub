/**
 * "Connect if not connected" for scheduled runs (#3527).
 *
 * A schedule that opts in names one window in its fire (`connectWindow`). That
 * window connects each target saved connection that has **no connected
 * terminal** in it — through the shared saved-connection connect flow in its
 * **unattended** mode, which never prompts: a target that would need input is
 * refused with the reason instead. The run then includes the tabs it opened,
 * and closes exactly those tabs when it ends, successfully or not. Tabs that
 * were already open are never touched.
 *
 * A target connected in **another** window is not connected again (#3878):
 * every window acknowledges the fire with the targets it runs on itself, and
 * the connect window asks the backend for those ({@link awaitRunCoverage})
 * before connecting, so each target runs once — in the window holding it.
 */
import { t, tf } from "@/i18n/catalog";
import { closeTerminal } from "@/services/api";
import { isTerminalReady } from "@/services/macroPlayback";
import type { SavedConnection } from "@/types/connection";
import type { RunCoverage } from "@/types/schedule";
import type { ConnectSavedConnectionResult } from "@/utils/connectSavedConnection";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { findLeafByTab } from "@/utils/panelTree";

import type { AppState } from "./appStore";
import { currentConnectionsView } from "./connectionsBridge";
import { collectLiveTabs, getComposedLayout } from "./layoutHelpers";
import { filterConnectedTerminalTabIds } from "./tabQueries";
import { runWithConcurrency, WORKFLOW_FANOUT_CONCURRENCY } from "./slices/workflowFanout";

/** How long an opened tab may take to attach before the run gives up on it. */
const TERMINAL_READY_TIMEOUT_MS = 10_000;

/** How often the readiness of an opened tab is polled. */
const TERMINAL_READY_POLL_MS = 50;

/**
 * Connects one saved connection unattended — the shared flow in its
 * never-prompt mode, injected by the caller (the flow reads the root store,
 * which this store-layer module must not import, #2881), or a test double.
 */
export type UnattendedConnector = (
  connection: SavedConnection
) => Promise<ConnectSavedConnectionResult>;

/** A tab a scheduled run opened, which it must close again. */
export interface OpenedRunTab {
  tabId: string;
  sessionId: string | null;
}

/** What connecting a run's missing targets produced. */
export interface MissingTargetsResult {
  /** Tabs opened and attached — run on these, then close them. */
  opened: OpenedRunTab[];
  /** Tabs opened but closed again already (never attached). */
  abandoned: OpenedRunTab[];
  /** One `"<target>: <reason>"` line per target that was not connected. */
  skipped: string[];
}

/** The saved-connection ids with a connected terminal tab in this window. */
function connectedHere(state: AppState): Set<string | undefined> {
  const live = collectLiveTabs(state);
  const connectedTabs = new Set(
    filterConnectedTerminalTabIds(
      state,
      live.map((tab) => tab.id)
    )
  );
  return new Set(live.filter((tab) => connectedTabs.has(tab.id)).map((tab) => tab.connectionId));
}

/** The connection ids among `connectionIds` with no connected tab here. */
function unconnectedIds(state: AppState, connectionIds: readonly string[]): string[] {
  const connected = connectedHere(state);
  return [...new Set(connectionIds)].filter((id) => !connected.has(id));
}

/** The connection ids among `connectionIds` with a connected tab here (#3878). */
export function connectedIds(state: AppState, connectionIds: readonly string[]): string[] {
  const connected = connectedHere(state);
  return [...new Set(connectionIds)].filter((id) => connected.has(id));
}

/** How long the connect window waits for the other windows to acknowledge. */
const COVERAGE_TIMEOUT_MS = 5_000;

/** How often the connect window asks again while they have not. */
const COVERAGE_POLL_MS = 50;

/**
 * The targets the run's other windows run on themselves (#3878): asks
 * `fetchCoverage` until every other window acknowledged the fire, or the
 * timeout passes (then with what is known — a window that never acknowledges
 * is dropped from the run anyway). A failed query covers nothing, so the run
 * falls back to connecting what is not connected here.
 */
export async function awaitRunCoverage(
  fetchCoverage: () => Promise<RunCoverage>,
  { timeoutMs = COVERAGE_TIMEOUT_MS, pollMs = COVERAGE_POLL_MS } = {}
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const coverage = await fetchCoverage();
      if (coverage.settled || Date.now() >= deadline) {
        if (!coverage.settled) {
          frontendLog("schedules", "not every window acknowledged the run; connecting anyway");
        }
        return coverage.connectedElsewhere;
      }
      await delay(pollMs);
    }
  } catch (err) {
    frontendLog("schedules", `run coverage query failed: ${errorMessage(err)}`);
    return [];
  }
}

/** Resolve after `ms`. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `tabId` can take input, or the timeout passes. */
async function waitUntilReady(tabId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!isTerminalReady(tabId)) {
    if (Date.now() >= deadline) return false;
    await delay(TERMINAL_READY_POLL_MS);
  }
  return true;
}

/**
 * Connect, unattended, every target in `connectionIds` that has no connected
 * terminal in this window. Never prompts, never throws: each target that is
 * not connected is reported in `skipped` with its reason.
 */
export async function connectMissingTargets(
  getState: () => AppState,
  connectionIds: readonly string[],
  connect: UnattendedConnector,
  readyTimeoutMs: number = TERMINAL_READY_TIMEOUT_MS
): Promise<MissingTargetsResult> {
  const result: MissingTargetsResult = { opened: [], abandoned: [], skipped: [] };
  const missing = unconnectedIds(getState(), connectionIds);
  if (missing.length === 0) return result;
  const saved = currentConnectionsView().connections;
  const skip = (target: string, reason: string) =>
    result.skipped.push(tf("schedule.connect.skip.target", { target, reason }));

  await runWithConcurrency(missing, WORKFLOW_FANOUT_CONCURRENCY, async (id) => {
    const connection = saved.find((c) => c.id === id);
    if (!connection) {
      skip(id, t("schedule.connect.skip.missing"));
      return;
    }
    let outcome: ConnectSavedConnectionResult;
    try {
      outcome = await connect(connection);
    } catch (err) {
      outcome = {
        status: "failed",
        reason: tf("schedule.connect.skip.failed", { error: errorMessage(err) }),
      };
    }
    if (outcome.status !== "opened") {
      const reason =
        outcome.status === "canceled" ? t("schedule.connect.skip.cancelled") : outcome.reason;
      frontendLog("schedules", `not connecting ${connection.name}: ${reason}`);
      skip(connection.name, reason);
      return;
    }
    const tab = { tabId: outcome.tabId, sessionId: outcome.sessionId };
    if (await waitUntilReady(tab.tabId, readyTimeoutMs)) {
      result.opened.push(tab);
    } else {
      result.abandoned.push(tab);
      skip(connection.name, t("schedule.connect.skip.notReady"));
    }
  });
  return result;
}

/** The panel holding `tabId`, or `null` when it is gone. */
function panelOfTab(state: AppState, tabId: string): string | null {
  for (const group of getComposedLayout(state).tabGroups) {
    const leaf = findLeafByTab(group.rootPanel, tabId);
    if (leaf) return leaf.id;
  }
  return null;
}

/**
 * Close the tabs a scheduled run opened. Closing a tab tears its session
 * down; a tab that never attached has no terminal to do that, so its session
 * is closed directly. Best effort — a tab the user already closed is skipped.
 */
export function closeRunTabs(
  getState: () => AppState,
  tabs: readonly OpenedRunTab[],
  attached: boolean
): void {
  for (const tab of tabs) {
    const panelId = panelOfTab(getState(), tab.tabId);
    if (panelId) getState().closeTab(tab.tabId, panelId);
    if (!attached && tab.sessionId) {
      closeTerminal(tab.sessionId).catch((err: unknown) =>
        frontendLog("schedules", `closing session ${tab.sessionId} failed: ${errorMessage(err)}`)
      );
    }
  }
}
