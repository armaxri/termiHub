import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import {
  setSessionIntentsEnabled,
  setSessionRenderFromProjectionEnabled,
  setSessionTransportForTest,
  stopSessionSubscription,
} from "@/store/sessionBridge";
import {
  connected,
  FakeSessionTransport,
  sessionLost,
} from "@/test/sessionLifecycleRegionTestHarness";

// Stub lucide-react icons used in the overlay (incl. the session-lost variant's
// Unplug + Plus).
vi.mock("lucide-react", () => ({
  WifiOff: () => null,
  RefreshCw: () => null,
  X: () => null,
  AlertTriangle: () => null,
  Loader2: () => null,
  CheckCircle2: () => null,
  Unplug: () => null,
  Plus: () => null,
}));

const TAB = "tab-1";

/** Flush the bridge's async subscribe + fan-out so the projected snapshot lands. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalDisconnectOverlay — session-lost variant (#2512)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let transport: FakeSessionTransport;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    transport = new FakeSessionTransport();
    setSessionTransportForTest(transport);
    setSessionRenderFromProjectionEnabled(true);
    setSessionIntentsEnabled(true);
    useAppStore.setState({
      terminalExitedTabs: { [TAB]: true },
      terminalDisconnectErrors: {},
      terminalViewMode: {},
      terminalReconnectingTabs: {},
      terminalReconnectTriggerErrors: {},
      terminalAutoReconnect: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stopSessionSubscription();
    setSessionTransportForTest(null);
    setSessionRenderFromProjectionEnabled(null);
    setSessionIntentsEnabled(null);
  });

  it("renders the session-lost notice with the backend error from the region", async () => {
    transport.setSession(TAB, sessionLost("the live agent session could not be recovered"));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    expect(transport.subscribeCount).toBeGreaterThan(0);
    const body = container.querySelector("[data-testid='terminal-session-lost']");
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain("Session lost");
    const errorBox = container.querySelector("[data-testid='terminal-session-lost-error-box']");
    expect(errorBox?.textContent).toContain("could not be recovered");
    // The explicit "start new shell" action is offered; no auto-reconnect.
    expect(
      container.querySelector("[data-testid='terminal-session-lost-new-shell-btn']")
    ).not.toBeNull();
  });

  it("renders the notice without an error box when the region carries no message", async () => {
    transport.setSession(TAB, sessionLost());

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    expect(container.querySelector("[data-testid='terminal-session-lost']")).not.toBeNull();
    expect(container.querySelector("[data-testid='terminal-session-lost-error-box']")).toBeNull();
  });

  it("'start new shell' triggers startFreshShellForTab for the tab", async () => {
    const startFreshShellForTab = vi.fn();
    useAppStore.setState({ startFreshShellForTab });
    transport.setSession(TAB, sessionLost("gone"));

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const btn = container.querySelector<HTMLButtonElement>(
      "[data-testid='terminal-session-lost-new-shell-btn']"
    );
    expect(btn).not.toBeNull();
    act(() => btn!.click());

    expect(startFreshShellForTab).toHaveBeenCalledWith(TAB);
  });

  it("does not render the session-lost variant for a non-lost (connected) session", async () => {
    transport.setSession(TAB, connected());

    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    // The exited tab still shows the standard disconnect overlay, but not the
    // session-lost variant.
    expect(container.querySelector("[data-testid='terminal-session-lost']")).toBeNull();
    expect(
      container.querySelector("[data-testid='terminal-session-lost-new-shell-btn']")
    ).toBeNull();
  });
});
