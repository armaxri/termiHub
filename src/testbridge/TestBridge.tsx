import { useEffect } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { useTerminalRegistry } from "@/components/Terminal/TerminalRegistry";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { frontendLog } from "@/utils/frontendLog";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import { isTestBridgeEnabled, getTestBridgePort } from "./testMode";
import { runBridgeWebSocketClient } from "./wsClient";

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
  const { getTerminalContent, scrollTerminal, getTerminalViewport, sendInputToTerminal } =
    useTerminalRegistry();

  useEffect(() => {
    if (!isTestBridgeEnabled()) return;

    const deps: BridgeDeps = {
      root: document,
      readTerminal: (tabId, joinFullWidthRows) => getTerminalContent(tabId, joinFullWidthRows),
      scrollTerminal: (tabId, lines, toBottom) => scrollTerminal(tabId, lines, toBottom),
      getTerminalViewport: (tabId) => getTerminalViewport(tabId),
      getActiveTabId: () => getActiveTab(useAppStore.getState())?.id ?? undefined,
      getState: () => useAppStore.getState() as unknown as Record<string, unknown>,
      sendTerminalInput: (tabId, text) => sendInputToTerminal(tabId, text),
      // Drive the real Tauri window so resize-triggered behavior (xterm fit →
      // PTY resize) runs exactly as it does for an interactive window drag.
      resizeWindow: (width, height) => getCurrentWindow().setSize(new LogicalSize(width, height)),
      // Rasterize the live DOM to a PNG data URL. Lazy-imported so html-to-image
      // is a test-mode-only chunk that never weighs down the normal bundle. The
      // DOM path captures layout/theme but not the xterm GPU canvas or native
      // dialogs (terminal text is read via readTerminal instead).
      screenshot: async () => {
        const { toPng } = await import("html-to-image");
        return toPng(document.body, { cacheBust: true });
      },
    };

    const dispatch = (command: Parameters<typeof dispatchCommand>[0]) =>
      dispatchCommand(command, deps);

    window.__termihubTestBridge = {
      ready: true,
      version: BRIDGE_VERSION,
      dispatch,
    };
    frontendLog("test_bridge", `installed (v${BRIDGE_VERSION})`);

    // When the backend supplied a runner port, also connect out over WebSocket so
    // an external test runner can drive the app on every platform — including
    // macOS, where no WKWebView WebDriver exists (ADR-5).
    const port = getTestBridgePort();
    // Loopback by design: the runner launches the app on the same host, so the
    // server it hosts is always reachable at 127.0.0.1 — no host config needed.
    const wsClient = port
      ? runBridgeWebSocketClient({
          url: `ws://127.0.0.1:${port}`,
          dispatch,
          onOpen: () => frontendLog("test_bridge", `ws connected to runner on :${port}`),
          onClose: () => frontendLog("test_bridge", "ws disconnected from runner"),
          onError: () => frontendLog("test_bridge", `ws error connecting to runner on :${port}`),
        })
      : undefined;
    if (port) frontendLog("test_bridge", `ws client connecting to runner on :${port}`);

    return () => {
      wsClient?.close();
      delete window.__termihubTestBridge;
      frontendLog("test_bridge", "removed");
    };
  }, [getTerminalContent, scrollTerminal, getTerminalViewport, sendInputToTerminal]);

  return null;
}
