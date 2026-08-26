import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { useTerminalRegistry } from "@/components/Terminal/TerminalRegistry";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { frontendLog } from "@/utils/frontendLog";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import { ProjectionRecorder } from "./projectionRecorder";
import { isTestBridgeEnabled, getTestBridgePort } from "./testMode";
import { runBridgeWebSocketClient, type BridgeWebSocketClient } from "./wsClient";

/** Protocol revision exposed via `window.__termihubTestBridge.version`. */
const BRIDGE_VERSION = 1;

/** A command dispatched in-process; resolves to a {@link BridgeResponse}. */
type BridgeDispatch = (
  command: Parameters<typeof dispatchCommand>[0]
) => ReturnType<typeof dispatchCommand>;

/**
 * The runner WebSocket is scoped to the **page**, not to this component.
 *
 * `TestBridge` renders inside `TerminalView`, which can remount during startup
 * (the layout subtree re-mounts once as the persisted config settles). Tying the
 * socket to the component lifecycle meant a remount ran the effect cleanup —
 * closing the runner's connection — and then opened a fresh one, so a test runner
 * bound to the first connection saw it drop ("bridge connection closed") moments
 * after the app appeared. On a slow WebView2 cold start the socket connects
 * before the layout settles, so the drop is reliable on Windows (issue #1019).
 *
 * Keeping one module-level client for the page's lifetime fixes that: a transient
 * remount no longer touches the socket. `latestDispatch` is swapped to the
 * current mount's dispatch on every (re)mount, so commands always run against the
 * live terminal registry even though the socket itself is created only once.
 */
let runnerClient: BridgeWebSocketClient | undefined;
let latestDispatch: BridgeDispatch | undefined;

/**
 * The projection recorder is page-scoped like the runner socket, not per-mount:
 * it holds live per-region subscriptions (Tauri channels + {@link ProjectionClient}
 * caches) that a transient `TerminalView` remount must not tear down. Created
 * lazily on first use so a run that never drives the substrate pays nothing.
 */
let projectionRecorder: ProjectionRecorder | undefined;

function getProjectionRecorder(): ProjectionRecorder {
  projectionRecorder ??= new ProjectionRecorder();
  return projectionRecorder;
}

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
      // Inject a backend-originated event so UI reachable only via the event
      // path (the deferred-update banner, #1520) can be driven by a test. The
      // effect above already returns early outside test mode, but this is the
      // one verb that reaches past the DOM into the Tauri backend, so re-check
      // at the call site: the guarantee "inert outside the harness" then holds
      // locally, independent of how the deps object was obtained.
      emitEvent: async (event, payload) => {
        if (!isTestBridgeEnabled()) throw new Error("test bridge is not enabled");
        await emit(event, payload);
      },
      // Abruptly sever an agent's transport in-process (#2573) so the automated
      // agent-reconnect grade (#2574) can drive a genuine transport break without
      // an operator or a fragile shell drop. Like emitEvent this reaches past the
      // DOM into the backend, so re-check test mode at the call site — the Tauri
      // command itself also refuses unless the test bridge is enabled, so a
      // production launch can never reach the sever.
      severAgentTransport: async (agentId) => {
        if (!isTestBridgeEnabled()) throw new Error("test bridge is not enabled");
        return await invoke<boolean>("test_sever_agent_transport", { agentId });
      },
      // Drive the projection substrate for the assertion harness (#2164) over the
      // real transport + ProjectionClient cache. Lazily created and page-scoped
      // so a remount never drops live subscriptions.
      projection: {
        subscribe: (region) => getProjectionRecorder().subscribe(region),
        dispatch: (request) => getProjectionRecorder().dispatch(request),
        state: (subscriptionId) => getProjectionRecorder().state(subscriptionId),
        dropNext: (subscriptionId, count) =>
          getProjectionRecorder().dropNext(subscriptionId, count),
        resync: (subscriptionId) => getProjectionRecorder().resync(subscriptionId),
        unsubscribe: (subscriptionId) => getProjectionRecorder().unsubscribe(subscriptionId),
      },
    };

    const dispatch: BridgeDispatch = (command) => dispatchCommand(command, deps);

    // Point the page-lifetime runner socket at this mount's dispatch, so commands
    // always reach the current terminal registry even across a remount.
    latestDispatch = dispatch;

    window.__termihubTestBridge = {
      ready: true,
      version: BRIDGE_VERSION,
      dispatch,
    };
    frontendLog("test_bridge", `installed (v${BRIDGE_VERSION})`);

    // When the backend supplied a runner port, also connect out over WebSocket so
    // an external test runner can drive the app on every platform — including
    // macOS, where no WKWebView WebDriver exists (ADR-5). The socket is opened
    // once per page load and reused across remounts (see the module note above),
    // so a transient remount never drops the runner's connection.
    const port = getTestBridgePort();
    if (port && !runnerClient) {
      // Loopback by design: the runner launches the app on the same host, so the
      // server it hosts is always reachable at 127.0.0.1 — no host config needed.
      runnerClient = runBridgeWebSocketClient({
        url: `ws://127.0.0.1:${port}`,
        // Indirect through the holder so the live (latest) dispatch is used.
        dispatch: (command) => latestDispatch!(command),
        onOpen: () => frontendLog("test_bridge", `ws connected to runner on :${port}`),
        onClose: () => frontendLog("test_bridge", "ws disconnected from runner"),
        onError: () => frontendLog("test_bridge", `ws error connecting to runner on :${port}`),
      });
      // Close the socket only when the page itself goes away.
      window.addEventListener("beforeunload", () => runnerClient?.close());
      frontendLog("test_bridge", `ws client connecting to runner on :${port}`);
    }

    return () => {
      // Only the in-process global is per-mount; the runner socket lives for the
      // whole page (closed on unload above), so a transient remount never drops it.
      delete window.__termihubTestBridge;
      frontendLog("test_bridge", "removed");
    };
  }, [getTerminalContent, scrollTerminal, getTerminalViewport, sendInputToTerminal]);

  return null;
}
