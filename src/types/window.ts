/**
 * Multi-window foundation types (#1900, epic #1899).
 *
 * termiHub can host multiple native windows and move a live session tab between
 * them without tearing down the backend session. These types describe the
 * frontend seam the backend `session_id → owning_window` ownership map and the
 * tab hand-off queue expose. See `docs/concepts/backlog/multi-window.html`.
 */

import type { ConnectionConfig, TabContentType } from "@/types/terminal";

/** Runtime label of the primary application window. */
export const MAIN_WINDOW_LABEL = "main";

/** A native window known to the app, for the window picker (#1901/#1902). */
export interface WindowInfo {
  /** The window's runtime label (`main`, `win-1`, …). */
  label: string;
}

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
