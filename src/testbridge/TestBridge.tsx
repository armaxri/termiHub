import { useEffect } from "react";
import { useTerminalRegistry } from "@/components/Terminal/TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { findLeaf } from "@/utils/panelTree";
import { frontendLog } from "@/utils/frontendLog";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import { isTestBridgeEnabled } from "./testMode";

/** Protocol revision exposed via `window.__termihubTestBridge.version`. */
const BRIDGE_VERSION = 1;

/**
 * Installs the in-app test bridge on `window` when test mode is active.
 *
 * Must render inside {@link TerminalPortalProvider} so it can read terminal
 * buffers through the registry. When test mode is off this renders nothing and
 * installs nothing, keeping the bridge inert in normal use.
 *
 * The bridge runs in-process, so it drives and introspects the UI identically on
 * every platform — including macOS, where no WKWebView WebDriver exists (ADR-5).
 */
export function TestBridge() {
  const { getTerminalContent } = useTerminalRegistry();

  useEffect(() => {
    if (!isTestBridgeEnabled()) return;

    const deps: BridgeDeps = {
      root: document,
      readTerminal: (tabId, joinFullWidthRows) => getTerminalContent(tabId, joinFullWidthRows),
      getActiveTabId: () => {
        const { rootPanel, activePanelId } = useAppStore.getState();
        const leaf = activePanelId ? findLeaf(rootPanel, activePanelId) : null;
        return leaf?.activeTabId ?? undefined;
      },
      getState: () => useAppStore.getState() as unknown as Record<string, unknown>,
    };

    window.__termihubTestBridge = {
      ready: true,
      version: BRIDGE_VERSION,
      dispatch: (command) => dispatchCommand(command, deps),
    };
    frontendLog("test_bridge", `installed (v${BRIDGE_VERSION})`);

    return () => {
      delete window.__termihubTestBridge;
      frontendLog("test_bridge", "removed");
    };
  }, [getTerminalContent]);

  return null;
}
