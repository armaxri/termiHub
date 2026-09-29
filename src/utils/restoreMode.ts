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
import type { RestorePrompt } from "@/types/generated/RestorePrompt";
import type { RestoreTabInfo } from "@/types/generated/RestoreTabInfo";
import type { RestoreTabTarget } from "@/types/generated/RestoreTabTarget";

// The restore-dialog DTOs returned by `restore_summarize_last_session` are
// generated via ts-rs from `core/src/restore_mode.rs` (#3088).
export type { RestorePrompt, RestoreTabInfo, RestoreTabTarget };

/** The three restore modes (generated from the Rust settings enum, #3802). */
export type RestoreLastSessionMode = NonNullable<AppSettings["restoreLastSessionMode"]>;

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
export type RestoreReachability = NonNullable<RestoreTabInfo["reachability"]>;

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
