import { useCallback } from "react";

/**
 * Who owns a right-click in a terminal (#3801).
 *
 * - `"app"`: the program running in the terminal enabled mouse reporting
 *   (`CSI ?1000h` and friends), so xterm already encodes the right-click as a
 *   mouse report for it. termiHub must NOT also act on it — Claude Code, for
 *   example, pastes on right-click itself (conhost-style), so termiHub's own
 *   quick-action paste on top inserted the clipboard twice.
 * - `"termihub"`: termiHub's own right-click behaviour (quick copy/paste or the
 *   context menu).
 *
 * Follows the common terminal convention (Windows Terminal, GNOME Terminal,
 * iTerm2): with mouse reporting on, a plain right-click belongs to the app and
 * Shift+right-click is the terminal's own. With reporting off nothing changes.
 */
export type TerminalRightClickRoute = "app" | "termihub";

export function routeTerminalRightClick(
  mouseReportingActive: boolean,
  shiftKey: boolean
): TerminalRightClickRoute {
  return mouseReportingActive && !shiftKey ? "app" : "termihub";
}

/**
 * Whether a `mousedown` must be kept away from xterm so it is not encoded as a
 * mouse report: a Shift+right-button press while the app has reporting on (that
 * gesture is termiHub's). xterm itself already skips Shift-modified presses on
 * Windows/Linux, but on macOS it only honours Option (and only with
 * `macOptionClickForcesSelection`), so without this the app would still get the
 * report there.
 */
export function shouldHoldBackRightClickReport(
  e: { button: number; shiftKey: boolean },
  mouseReportingActive: boolean
): boolean {
  return e.button === 2 && e.shiftKey && mouseReportingActive;
}

/** The two event hooks a terminal's right-click trigger wires up (#3801). */
export interface TerminalRightClickRouting {
  /**
   * `onMouseDownCapture` for the trigger wrapping the terminal. Runs before
   * xterm's own (target-phase) `mousedown` listener and stops a Shift+right
   * press from reaching it while reporting is on.
   */
  onMouseDownCapture: (e: React.MouseEvent, tabId: string) => void;
  /**
   * Call first in the trigger's `onContextMenu`. Returns `true` when termiHub
   * owns this right-click and should run its quick action / open its menu;
   * `false` when it belongs to the app — the native browser menu is then
   * suppressed and termiHub does nothing else.
   */
  claimRightClick: (e: React.MouseEvent, tabId: string) => boolean;
}

export function useTerminalRightClickRouting(
  isMouseReportingActive: (tabId: string) => boolean
): TerminalRightClickRouting {
  const onMouseDownCapture = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      if (shouldHoldBackRightClickReport(e, isMouseReportingActive(tabId))) {
        e.stopPropagation();
      }
    },
    [isMouseReportingActive]
  );

  const claimRightClick = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      if (routeTerminalRightClick(isMouseReportingActive(tabId), e.shiftKey) === "app") {
        e.preventDefault();
        return false;
      }
      return true;
    },
    [isMouseReportingActive]
  );

  return { onMouseDownCapture, claimRightClick };
}
