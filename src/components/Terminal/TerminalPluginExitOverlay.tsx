import { useCallback } from "react";
import { MonitorX, RotateCcw, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { getComposedLayout } from "@/store/layoutHelpers";
import type { PluginSessionExit } from "@/store/sessionBridge";
import { usePluginSandbox } from "@/store/usePluginSandbox";
import { findLeafByTab } from "@/utils/panelTree";
import { Button, ContentOverlay, Tooltip } from "@/components/ui";
import "./TerminalDisconnectOverlay.css";

/** Props for {@link TerminalPluginExitOverlay}. */
export interface TerminalPluginExitOverlayProps {
  tabId: string;
  /** Why the plugin process failed (from the tab's lifecycle region entry). */
  exit: PluginSessionExit;
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
 * **Restart session** or **Close tab**. The scrollback stays below.
 */
export function TerminalPluginExitOverlay({ tabId, exit }: TerminalPluginExitOverlayProps) {
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
  const subheading = `"${exit.pluginName}" ran in its own sandboxed process, so termiHub and your other sessions are not affected.${restartNote}`;

  return (
    <div
      className="terminal-disconnect-overlay terminal-disconnect-overlay--error"
      data-testid="terminal-disconnect-overlay"
    >
      <Tooltip content="View scrollback" side="bottom">
        <button
          className="terminal-disconnect-overlay__dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss and view scrollback"
          data-testid="terminal-disconnect-dismiss-btn"
        >
          <X size={14} />
        </button>
      </Tooltip>
      <ContentOverlay
        className="terminal-disconnect-overlay__body"
        data-testid="terminal-plugin-exit"
        icon={
          <MonitorX
            size={32}
            className="terminal-disconnect-overlay__icon terminal-disconnect-overlay__icon--error"
          />
        }
        heading={HEADINGS[exit.kind] ?? HEADINGS.crashed}
        subheading={subheading}
        actions={
          <>
            <Button
              variant="primary"
              size="sm"
              icon={<RotateCcw size={14} />}
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
          <span className="terminal-disconnect-overlay__error-text">
            {capitalize(exit.message)}
          </span>
        </div>
      </ContentOverlay>
    </div>
  );
}
