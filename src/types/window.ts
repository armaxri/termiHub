/**
 * Multi-window foundation types (#1900, epic #1899).
 *
 * termiHub can host multiple native windows and move a live session tab between
 * them without tearing down the backend session. These types describe the
 * frontend seam the backend `session_id → owning_window` ownership map and the
 * tab hand-off queue expose. See `docs/concepts/implemented/multi-window.html`.
 */

import type { ConnectionConfig, TabContentType } from "@/types/terminal";
import type { WorkspaceTabGroupDef } from "@/types/workspace";
import type { WindowInfo } from "./generated/WindowInfo";

/** Runtime label of the primary application window. */
export const MAIN_WINDOW_LABEL = "main";

/**
 * A native window known to the app, for the window picker (#1901/#1902).
 * `tabCount` is `null`/absent until the window reports one (#1910). Generated
 * from `src-tauri/src/commands/window.rs` via ts-rs (#3088).
 */
export type { WindowInfo };

/**
 * The subset of a `TerminalTab` view-model carried across a native-window
 * boundary during a re-parent.
 *
 * Placement (`panelId`, `isActive`) is deliberately excluded — it is re-assigned
 * by the destination window's store when the tab is hydrated. `sessionId` is the
 * anchor: the backend session keyed by it keeps running, so the destination
 * re-attaches to the same live session rather than starting a new one.
 */
export interface HandoffTab {
  sessionId: string | null;
  title: string;
  connectionType: string;
  contentType: TabContentType;
  config: ConnectionConfig;
  initialCommand?: string;
  /** A held imported command (#4434); stays held in the destination window. */
  pendingImportedCommand?: string;
  /** Held on an unconfirmed imported inline config (#4434); stays held. */
  pendingImportedConnection?: boolean;
  persistentConnectionId?: string;
  connectionId?: string;
  spawned?: boolean;
}

/**
 * A serialized tab hand-off, queued by the backend for a destination window to
 * drain on boot or on a `window-handoff` nudge. The `tab` payload is opaque to
 * the backend (`serde_json::Value`).
 */
export interface TabHandoffRecord {
  tab: HandoffTab;
}

/**
 * Where a "move tab to window" targets: a brand-new window, or an existing one
 * addressed by its label. The command/menu UI that picks the target is #1901;
 * the foundation only provides the store action and the seam.
 */
export type MoveWindowTarget = { kind: "new" } | { kind: "existing"; label: string };

/**
 * One window's captured layout slice, reported to the backend aggregation
 * authority and read back when the main window assembles the full multi-window
 * last-session / workspace document (#1925). See
 * `src/utils/windowPersistence.ts`. Generated from `src-tauri/src/window/mod.rs`
 * via ts-rs (#3088).
 */
export type { WindowLayoutReport } from "./generated/WindowLayoutReport";

/**
 * The tab groups a restore-spawned secondary window hydrates on boot (#1925).
 *
 * A multi-window restore spawns one native window per saved secondary window and
 * seeds each with its assigned groups via the backend pending-restore queue; the
 * new window drains this payload (`take_pending_window_restore`) and rebuilds its
 * layout from it, exactly as the main window rebuilds its own on restore.
 */
export interface WindowRestorePayload {
  tabGroups: WorkspaceTabGroupDef[];
}

/**
 * What would happen to one live session owned by a window being closed (#1903):
 * a persistent/agent session `detach`es (its backend process keeps running and
 * can be re-attached later), while a non-persistent one would be `terminate`d.
 */
export type WindowCloseOutcome = "detach" | "terminate";

/**
 * One live session owned by a closing window, with the outcome its close would
 * have — the per-session row rendered in the detach-vs-terminate decision
 * dialog (#1903).
 */
export interface WindowCloseSessionRow {
  /** Owning tab id (used to detach/move the exact tab). */
  tabId: string;
  /** The live backend session id. */
  sessionId: string;
  /** Tab title, for display. */
  title: string;
  /** Connection type (`local`, `ssh`, `serial`, …), for display/icon. */
  connectionType: string;
  /** The tab's content type, for the row icon. */
  contentType: TabContentType;
  /** Whether this session detaches (survives) or would be terminated. */
  outcome: WindowCloseOutcome;
}

/**
 * A pending close-with-live-tabs decision (#1903). Raised only when at least one
 * owned session would actually be lost (a non-persistent `terminate`); an empty
 * or all-persistent window closes without a dialog.
 */
export interface WindowCloseRequest {
  /** The live sessions owned by the window being closed, and their outcomes. */
  sessions: WindowCloseSessionRow[];
  /** Other open windows this window's tabs could be moved to (excludes self). */
  otherWindows: WindowInfo[];
  /**
   * Editor tabs with unsaved changes that closing the window would discard
   * (UX2-003). Absent or empty when no editor is dirty.
   */
  dirtyEditors?: WindowCloseDirtyEditor[];
  /**
   * Why the dialog is up (#4296). `"close"` (the default when absent) closes
   * this window; `"quit"` answers an app-wide quit (Cmd+Q / menu Quit), which
   * the backend completes once every window agreed, so moving tabs to another
   * window is not offered.
   */
  mode?: "close" | "quit";
}

/** One unsaved editor tab listed in the window-close decision dialog. */
export interface WindowCloseDirtyEditor {
  tabId: string;
  title: string;
}

/**
 * A friendly display name for a window label (`main` → "Main window",
 * `win-3` → "Window 3"). The richer window picker is #1901/#1902; this is the
 * minimal label formatter the close-decision dialog needs.
 */
export function windowDisplayName(label: string): string {
  if (label === MAIN_WINDOW_LABEL) return "Main window";
  const match = /^win-(\d+)$/.exec(label);
  return match ? `Window ${match[1]}` : label;
}
