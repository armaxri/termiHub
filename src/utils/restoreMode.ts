/**
 * Startup session-restore mode: how the previously-open tabs are handled when
 * the app launches.
 *
 * - `"never"` — never restore; start with a fresh empty session.
 * - `"ask"` — show a dialog offering to restore the previous session.
 * - `"always"` — restore the previous session silently.
 */

import { invoke } from "@tauri-apps/api/core";

import type { AppSettings, SavedConnection } from "@/types/connection";
import type { LastSession } from "@/types/lastSession";

/** The three restore modes. */
export type RestoreLastSessionMode = "never" | "ask" | "always";

/**
 * Reachability of a restorable tab's connection target, resolved by an
 * asynchronous probe after the restore dialog opens.
 *
 * - `"reachable"` — the target answered (host port open / serial device present).
 * - `"unreachable"` — the target is down (host unreachable / device offline);
 *   the dialog flags it with a warning icon.
 * - `"unknown"` — not probed or the probe was inconclusive (the default before
 *   the probe resolves, and for targets with nothing meaningful to probe).
 */
export type RestoreReachability = "reachable" | "unreachable" | "unknown";

/**
 * The connection target derived from a stored tab, used to drive the
 * reachability probe. `kind` selects how the probe checks it; `local` and
 * `agent` targets are not network-probed (they resolve to `"unknown"`).
 */
export interface RestoreTabTarget {
  /** How the tab connects, selecting the reachability check to run. */
  kind: "host" | "serial" | "local" | "agent";
  /** Target host for `host` targets (SSH/telnet). */
  host?: string;
  /** Target TCP port for `host` targets. */
  port?: number;
  /** Serial device path for `serial` targets. */
  device?: string;
  /** Remote agent id for `agent` targets. */
  agentId?: string;
}

/** A single restorable tab, described for the restore dialog. */
export interface RestoreTabInfo {
  /** Human-readable tab title. */
  title: string;
  /** Short connection-type label (e.g. "SSH", "Serial", "Local"). */
  typeLabel: string;
  /**
   * The probe target derived from the stored tab. Optional so display-only
   * callers (and tests) need not construct it; {@link summarizeLastSession}
   * always populates it so the reachability probe can run.
   */
  target?: RestoreTabTarget;
  /**
   * Reachability of {@link target}, set asynchronously once the probe resolves.
   * Absent until then (treated as `"unknown"`).
   */
  reachability?: RestoreReachability;
  /**
   * Short human-readable reason shown beside the warning icon when the target is
   * unreachable (e.g. `"device offline"`, `"host unreachable"`).
   */
  unreachableReason?: string;
}

/** Summary of a stored last session for the restore dialog. */
export interface RestorePrompt {
  /** Total number of restorable tabs across all groups. */
  tabCount: number;
  /** Per-tab descriptors for display. */
  tabs: RestoreTabInfo[];
}

/**
 * Resolve the effective restore mode from settings, migrating the legacy
 * boolean `restoreLastSessionOnStartup` when the explicit mode is unset.
 *
 * - explicit {@link AppSettings.restoreLastSessionMode} wins when valid;
 * - otherwise the legacy boolean `=== false` maps to `"never"`;
 * - otherwise the default is `"ask"` (the concept default).
 *
 * The decision logic lives in `core::restore_mode` (Rust); this delegates to the
 * `restore_resolve_mode` command so there is a single source of truth (#2200).
 */
export async function resolveRestoreMode(settings: AppSettings): Promise<RestoreLastSessionMode> {
  return await invoke<RestoreLastSessionMode>("restore_resolve_mode", { settings });
}

/**
 * Flatten a stored {@link LastSession} into a per-tab summary for the restore
 * dialog. Iterates groups → leaves → tabs in a stable order; that same order is
 * the tab index space used by {@link filterSessionBySelection}.
 *
 * `connections` (optional) lets `connectionRef` tabs resolve their host/serial
 * target for the reachability probe; pass the loaded connections when available.
 *
 * The summarisation is pure and runs in `core::restore_mode` (#2200): each tab
 * carries the {@link RestoreTabTarget} the probe needs, but the **asynchronous
 * reachability probe itself stays client-side** ({@link RestoreTabInfo.reachability}
 * is populated afterwards by `probeRestoreTargets`). That is the async-probe
 * seam — pure decision server-side, network I/O on the client.
 */
export async function summarizeLastSession(
  session: LastSession,
  connections: SavedConnection[] = []
): Promise<RestorePrompt> {
  return await invoke<RestorePrompt>("restore_summarize_last_session", { session, connections });
}

/**
 * Prune a stored {@link LastSession} down to the tabs the user chose to restore.
 *
 * `selected` holds the flat tab indices to keep, in the same order
 * {@link summarizeLastSession} produced. Leaves left with no tabs are dropped,
 * splits collapse when only one child survives (redistributing sizes), and tab
 * groups whose layout empties out are removed. `activeGroupIndex` is remapped to
 * the surviving group nearest the original active one; `windows` are preserved
 * untouched (an emptied window still round-trips, per #1902).
 *
 * Delegates to the `restore_filter_session_by_selection` core command (#2200).
 */
export async function filterSessionBySelection(
  session: LastSession,
  selected: ReadonlySet<number>
): Promise<LastSession> {
  return await invoke<LastSession>("restore_filter_session_by_selection", {
    session,
    selected: [...selected],
  });
}
