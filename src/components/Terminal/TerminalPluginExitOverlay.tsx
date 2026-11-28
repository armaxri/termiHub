import { useCallback, useId } from "react";
import { MonitorX, RotateCcw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { getComposedLayout } from "@/store/layoutHelpers";
import type { PluginSessionExit } from "@/store/sessionBridge";
import { usePluginSandbox } from "@/store/usePluginSandbox";
import { findLeafByTab } from "@/utils/panelTree";
import { Button, ContentOverlay } from "@/components/ui";
import { DisconnectStrip } from "./DisconnectStrip";
import { ICON_SIZE } from "@/components/ui/iconSize";
import "./TerminalDisconnectOverlay.css";

/** Props for {@link TerminalPluginExitOverlay}. */
export interface TerminalPluginExitOverlayProps {
  tabId: string;
  /** Why the plugin process failed (from the tab's lifecycle region entry). */
  exit: PluginSessionExit;
  /**
   * Whether this tab is the active (visible) one. Moves focus to the first
   * enabled action when the overlay appears (#4514); background tabs never
   * steal focus.
   */
  isActive?: boolean;
}

/** The overlay heading per failure kind (concept "Failure modes"). */
const HEADINGS: Record<PluginSessionExit["kind"], string> = {
  crashed: "The plugin stopped unexpectedly",
  notResponding: "The plugin stopped responding",
  outOfMemory: "The plugin used too much memory",
  invalidData: "The plugin sent invalid data",
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The crash overlay of a plugin tab (#4188, concept `plugin-os-sandbox.html`):
 * shown when the session ended because its sandboxed plugin process crashed,
 * stopped responding, used too much memory or sent invalid data. Names the
 * plugin, says termiHub and the other sessions are unaffected, reports the
 * restart count from the `plugin-sandbox` region and shows the exit reason.
 * Plugin types have no auto-reconnect (PLG-004), so the user decides:
 * **Restart session** or **Close tab**.
 *
 * It is the session-end strip of #5908 (#5916): a full-width strip at the top
 * of the slot that pushes the terminal down below it, so the scrollback stays
 * fully visible; only the strip is a toast keep-clear zone.
 */
export function TerminalPluginExitOverlay({
  tabId,
  exit,
  isActive = false,
}: TerminalPluginExitOverlayProps) {
  const reasonId = useId();
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal);
  const dismissTerminalDisconnect = useAppStore((s) => s.dismissTerminalDisconnect);
  const closeTab = useAppStore((s) => s.closeTab);
  const sandbox = usePluginSandbox();
  const process = sandbox.plugins[exit.pluginId]?.process;

  const handleRestart = useCallback(() => {
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  const handleDismiss = useCallback(() => {
    dismissTerminalDisconnect(tabId);
  }, [tabId, dismissTerminalDisconnect]);

  const handleClose = useCallback(() => {
    const leaf = findLeafByTab(getComposedLayout(useAppStore.getState()).rootPanel, tabId);
    if (leaf) closeTab(tabId, leaf.id);
  }, [tabId, closeTab]);

  let restartNote = "";
  if (process?.autoDisabled) {
    restartNote = ` ${process.autoDisabled}: re-enable it in Settings → Plugins to use it again.`;
  } else if (process && process.crashes > 0) {
    restartNote = ` termiHub restarted the plugin (${process.crashes} of ${process.maxRestarts}).`;
  }
  const heading = HEADINGS[exit.kind] ?? HEADINGS.crashed;
  const reason = capitalize(exit.message);
  const subheading = `"${exit.pluginName}" ran in its own sandboxed process, so termiHub and your other sessions are not affected.${restartNote}`;

  return (
    <DisconnectStrip
      variant="plugin-exit"
      tone="error"
      onDismiss={handleDismiss}
      dismissLabel="Dismiss and view scrollback"
    >
      <ContentOverlay
        className="terminal-disconnect-overlay__body"
        data-testid="terminal-plugin-exit"
        icon={
          <MonitorX
            size={ICON_SIZE.md}
            className="terminal-disconnect-overlay__icon terminal-disconnect-overlay__icon--error"
          />
        }
        heading={heading}
        subheading={subheading}
        // A failure the user must act on (#4514): the reason lives in children.
        announce="assertive"
        announcement={`${heading}. ${reason}`}
        describedBy={reasonId}
        autoFocusPrimaryAction={isActive}
        actions={
          <>
            <Button
              variant="primary"
              size="sm"
              icon={<RotateCcw size={ICON_SIZE.sm} />}
              onClick={handleRestart}
              disabled={process?.autoDisabled !== undefined}
              data-testid="terminal-plugin-exit-restart-btn"
            >
              Restart session
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleClose}
              data-testid="terminal-plugin-exit-close-btn"
            >
              Close tab
            </Button>
          </>
        }
      >
        <div
          className="terminal-disconnect-overlay__error-box"
          data-testid="terminal-plugin-exit-reason"
        >
          <span id={reasonId} className="terminal-disconnect-overlay__error-text">
            {reason}
          </span>
        </div>
      </ContentOverlay>
    </DisconnectStrip>
  );
}
