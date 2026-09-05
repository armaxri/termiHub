import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import { setSessionTransportForTest, stopSessionSubscription } from "@/store/sessionBridge";
import {
  connected,
  failed,
  FakeSessionTransport,
  sessionLost,
  withExit,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { TerminalExitInfo } from "@/types/terminal";

// Stub lucide-react icons used in the overlay.
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

/**
 * #2615 PR-A: the disconnect overlay derives its clean / dropped heading +
 * subheading from the region's `exit` cause under the faithful-mirror gate,
 * byte-identical to the pre-cut `appStore.terminalExitInfo` read.
 *
 * As with the #2204 render-cut tests, a PR-A test seeds *both* the region (the
 * value the render should source) and `appStore` (the authoritative slice the gate
 * compares against) — the gate sources the region value only when it faithfully
 * mirrors the local slice, so the rendered wording is provably byte-identical.
 */
describe("TerminalDisconnectOverlay — region-derived exit cause (#2615)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let transport: FakeSessionTransport;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    transport = new FakeSessionTransport();
    setSessionTransportForTest(transport);
    useAppStore.setState({
      terminalExitedTabs: { [TAB]: true },
      terminalExitInfo: {},
      terminalDisconnectErrors: {},
      terminalViewMode: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stopSessionSubscription();
    setSessionTransportForTest(null);
  });

  /** Render the overlay with the region + appStore seeded to `exit`. */
  async function renderWithExit(exit: TerminalExitInfo): Promise<Element | null> {
    useAppStore.setState({ terminalExitInfo: { [TAB]: exit } });
    // A clean exit leaves the region status `connected` (only a metadata
    // `session.exited` fires); a dropped exit lands `disconnected`. Either way the
    // overlay's higher-priority branches (sessionLost / reconnecting / failed) are
    // not taken, so it renders the default clean/dropped variant from `exit`.
    transport.setSession(TAB, withExit(connected(), exit));
    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();
    return container.querySelector("[data-testid='terminal-disconnect-overlay']");
  }

  it("renders the clean-exit wording (with exit code) from the region", async () => {
    const overlay = await renderWithExit({ reason: "clean", code: 0 });
    expect(transport.subscribeCount).toBeGreaterThan(0);
    expect(overlay?.textContent).toContain("Session ended");
    expect(overlay?.textContent).toContain("exit code 0");
  });

  it("renders the dropped wording with a non-zero exit code from the region", async () => {
    const overlay = await renderWithExit({ reason: "dropped", code: 137 });
    expect(overlay?.textContent).toContain("Session disconnected");
    expect(overlay?.textContent).toContain("exit code 137");
  });

  it("renders the codeless dropped wording when the region carries no exit code", async () => {
    const overlay = await renderWithExit({ reason: "dropped", code: null });
    expect(overlay?.textContent).toContain("Session disconnected");
    expect(overlay?.textContent).toContain("The connection was lost");
  });

  it("falls back to the local slice when the region exit diverges (byte-identical safety)", async () => {
    // The faithful-mirror gate never sources a region exit that disagrees with the
    // local slice: the overlay renders the local wording, not the divergent region
    // one — the same guarantee `effectiveDisconnectError` gives.
    useAppStore.setState({ terminalExitInfo: { [TAB]: { reason: "clean", code: 0 } } });
    transport.setSession(TAB, withExit(connected(), { reason: "dropped", code: 137 }));
    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const overlay = container.querySelector("[data-testid='terminal-disconnect-overlay']");
    expect(overlay?.textContent).toContain("Session ended");
    expect(overlay?.textContent).not.toContain("exit code 137");
  });

  it("still renders the reconnect-failed variant from the region regardless of exit cause", async () => {
    // The failed (reconnect-exhausted) variant is region-sourced (#2205 PR-B) and
    // takes precedence over the exit-cause wording — unchanged by this PR.
    useAppStore.setState({ terminalDisconnectErrors: { [TAB]: "host unreachable" } });
    transport.setSession(TAB, failed("host unreachable"));
    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const overlay = container.querySelector("[data-testid='terminal-disconnect-overlay']");
    expect(overlay?.textContent).toContain("Reconnect failed");
    expect(overlay?.textContent).toContain("host unreachable");
  });

  it("still renders the session-lost variant from the region regardless of exit cause", async () => {
    // Session-lost (#2512) is terminal and region-only; it takes precedence over
    // the exit-cause wording — unchanged by this PR.
    transport.setSession(TAB, sessionLost("the live agent session could not be recovered"));
    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const lost = container.querySelector("[data-testid='terminal-session-lost']");
    expect(lost).not.toBeNull();
    expect(lost?.textContent).toContain("Session lost");
  });
});
