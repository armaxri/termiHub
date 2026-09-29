/**
 * Connect / resilient-reconnect helpers (ARCH-001/FES-011, #2881): the aborted
 * connect message, reconnect eligibility and the on-reconnect command. Moved
 * verbatim out of `appStore.ts` (which re-exports them) so slices import them
 * without pulling in the root store; the live store is read through
 * {@link import("./appStoreHandle").useAppStore}.
 */

import type { TerminalTab } from "@/types/terminal";
import { isAutoReconnectEnabled } from "@/utils/autoReconnect";
import { getTerminalInputInjector } from "@/services/macroPlayback";
import { frontendLog } from "@/utils/frontendLog";
import { getAllLeaves } from "@/utils/panelTree";
import { useAppStore } from "./appStoreHandle";
import { collectLiveTabs, getComposedLayout } from "./layoutHelpers";

/**
 * Failed-state message shown when the user aborts an in-flight connect from the
 * connecting / waiting / auto-retry overlay. The tab stays open on a retryable
 * Failed state rather than closing (#1128).
 */
export const ABORTED_CONNECT_MESSAGE = "Connection aborted.";

// ── Resilient reconnect eligibility + on-reconnect command (#1962 / #2205) ──
//
// The resilient-reconnect *loop* is owned entirely by the backend redrive since
// #2205 PR-B — the client no longer runs a backoff timer or a `driveAutoReconnect`
// engine. What survives on the client is the pure eligibility classification (fed
// to the backend at connect time so it knows which tabs to redrive) and the
// on-reconnect command the overlay announces and `setTabSessionId` runs.

/**
 * Whether a tab is eligible for resilient reconnect. Two distinct populations,
 * both excluding persistent sessions (those have their own continuity machinery):
 *
 * - **Agentless direct SSH (#1962):** a plain SSH terminal whose connection has the
 *   unified "Auto-Reconnect" setting enabled — on by default (PARITY-008), so only
 *   an explicit opt-out excludes it. Backend-driven backoff loop.
 * - **Agent-hosted (#2476):** a shell session on a remote agent — always
 *   resilient. The agent reconnect is backend-driven (park + retry + new-sessionId
 *   re-attach), and backend-reattach is now unconditional (#2560), so every
 *   agent-hosted tab is eligible.
 *
 * Reads the auto-reconnect setting / agent marker from the tab's connection config.
 */
export function isResilientReconnectTab(tab: TerminalTab | undefined): boolean {
  if (!tab) return false;
  if (tab.contentType !== "terminal") return false;
  if (tab.persistentConnectionId) return false;
  const cfg = tab.config?.config as Record<string, unknown> | undefined;
  if (!cfg) return false;
  if (cfg.agentId) {
    // Agent-hosted tab (#2476): always resilient — the backend redrive is the sole
    // reconnect authority and backend-reattach is unconditional (#2560).
    return true;
  }
  if (tab.connectionType !== "ssh") return false;
  return isAutoReconnectEnabled(cfg);
}

/**
 * Whether the tab identified by `tabId` is a resilient-reconnect tab, resolved
 * from the live store exactly as `setTerminalExited`'s drop classification does
 * (#2439). Passed to the backend at connect time (via `createTerminal`) so a
 * genuine drop can be folded server-side — `session.reconnect` for a resilient
 * tab, `session.dropped` otherwise — converging with the client mirror. An
 * unknown/closed tab is not resilient.
 */
export function isResilientReconnectTabId(tabId: string): boolean {
  const tab = collectLiveTabs(useAppStore.getState()).find((t) => t.id === tabId);
  return isResilientReconnectTab(tab);
}

/**
 * Whether `tabId` is an **agent-hosted** tab whose reconnect is driven entirely
 * by the backend redrive (#2476), as opposed to an agentless direct-SSH resilient
 * tab (#1962/#2457) whose reconnect the client still drives (with the
 * backend-reattach id as a fast path).
 *
 * This is the discriminator for the two agent-specific cuts of the reconnect path:
 *  - `Terminal.tsx` routes only these tabs through the give-up-aware wait that
 *    stays deferred to the backend loop across a prolonged drop (never falling
 *    through to the non-idempotent client agent engine — the double-drive fix);
 *  - `reconnectTerminal` skips arming the fixed 90 s "connecting" deadline for
 *    these tabs, since the backend park/retry legitimately outlasts it and the
 *    give-up fold — not a client wall-clock timeout — is what settles the tab.
 */
export function isBackendDrivenAgentReconnectTabId(tabId: string): boolean {
  const tab = collectLiveTabs(useAppStore.getState()).find((t) => t.id === tabId);
  if (!tab) return false;
  if (tab.persistentConnectionId) return false;
  const cfg = tab.config?.config as { agentId?: unknown } | undefined;
  const isAgentTab = tab.config?.type === "remote-session" || !!cfg?.agentId;
  return isAgentTab && isResilientReconnectTab(tab);
}

/**
 * The trimmed on-reconnect command configured for a tab's connection (#1978), or
 * `undefined` when none is set. This is the command run once in the fresh remote
 * shell after a *successful* automatic reconnect to recover some server-side
 * context (e.g. `tmux attach`) that an agentless reconnect otherwise loses.
 * Empty/whitespace-only values are treated as "no command".
 */
function onReconnectCommandForTab(tab: TerminalTab | undefined): string | undefined {
  if (!tab) return undefined;
  const cfg = tab.config?.config as { onReconnectCommand?: unknown } | undefined;
  const raw = cfg?.onReconnectCommand;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The trimmed on-reconnect command for a tab id (#1978), or `undefined` when none
 * is set / the tab is gone. The exported entry the reconnect-countdown overlay
 * uses to re-attach the per-client presentation onto the projected loop record
 * ({@link import("./useSessionLifecycle").useSessionAutoReconnect}) now that the
 * region — not a local `appStore` record — is the source of the loop (#2205).
 */
export function onReconnectCommandForTabId(tabId: string): string | undefined {
  return onReconnectCommandForTab(findTabById(tabId));
}

/**
 * Find a terminal tab by id across the active panel tree (#1978 helper). Used by
 * the auto-reconnect loop to read a tab's live connection config when settling.
 */
function findTabById(tabId: string): TerminalTab | undefined {
  return getAllLeaves(getComposedLayout(useAppStore.getState()).rootPanel)
    .flatMap((l) => l.tabs)
    .find((t) => t.id === tabId);
}

/**
 * Send the configured on-reconnect command once into a tab after its resilient
 * reconnect settled (#1978). Routes through the shared terminal-input injector —
 * the same `send_input` choke point interactive typing and macros use — so the
 * command is delivered to the fresh remote shell exactly as if typed, with a
 * trailing newline to execute it. A missing command or absent injector is a
 * silent no-op; delivery failures are logged, never thrown.
 */
export function runOnReconnectCommand(tabId: string): void {
  const command = onReconnectCommandForTab(findTabById(tabId));
  if (!command) return;
  const injector = getTerminalInputInjector();
  if (!injector) {
    frontendLog(
      "disconnect",
      `auto-reconnect tab=${tabId}: on-reconnect command skipped (no injector)`
    );
    return;
  }
  void Promise.resolve(injector(tabId, command + "\n"))
    .then((delivered) => {
      frontendLog(
        "disconnect",
        `auto-reconnect tab=${tabId}: on-reconnect command ${delivered ? "sent" : "not delivered"}`
      );
    })
    .catch(() => {
      frontendLog("disconnect", `auto-reconnect tab=${tabId}: on-reconnect command failed`);
    });
}
