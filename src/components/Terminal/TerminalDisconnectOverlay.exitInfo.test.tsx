import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  RotateCcw: () => null,
  SquareTerminal: () => null,
  Usb: () => null,
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
 * #2615 / #2625: the disconnect overlay derives its clean / dropped heading +
 * subheading purely from the region's `exit` cause (the per-client
 * `appStore.terminalExitInfo` slice was deleted, so the region is the sole source).
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
      terminalViewMode: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stopSessionSubscription();
    setSessionTransportForTest(null);
  });

  /** Render the overlay with the region seeded to `exit`. */
  async function renderWithExit(exit: TerminalExitInfo): Promise<Element | null> {
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
    // #5955: a local process reads "Process exited (code N)" for every code.
    expect(overlay?.textContent).toContain("Process exited (code 0)");
    expect(overlay?.textContent).not.toContain("Session ended");
  });

  it("renders the dropped wording with a non-zero exit code from the region", async () => {
    const overlay = await renderWithExit({ reason: "dropped", code: 137 });
    // #5910: a process exit is not a lost connection.
    expect(overlay?.textContent).toContain("Process exited (code 137)");
    expect(overlay?.textContent).not.toContain("Session ended");
  });

  it("renders the codeless dropped wording when the region carries no exit code", async () => {
    const overlay = await renderWithExit({ reason: "dropped", code: null });
    expect(overlay?.textContent).toContain("Session ended");
    expect(overlay?.textContent).toContain("The connection was lost");
  });

  it("still renders the reconnect-failed variant from the region regardless of exit cause", async () => {
    // The failed (reconnect-exhausted) variant is region-sourced (#2205 PR-B) and
    // takes precedence over the exit-cause wording — unchanged by this PR.
    transport.setSession(TAB, failed("host unreachable"));
    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();

    const overlay = container.querySelector("[data-testid='terminal-disconnect-overlay']");
    expect(overlay?.textContent).toContain("Connection failed");
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

  // #5904: a pane-sized keep-clear zone docked the toast stack and held back
  // every success toast (the tab's "Closed … · Reopen" undo among them) while
  // an ended session showed. #5908 made the notice a strip across the pane
  // top: the strip itself is the one keep-clear zone, and it is only as tall as
  // its content, never pane-sized.
  it("marks only the strip, never a pane-sized element, as a toast keep-clear zone", async () => {
    const strip = await renderWithExit({ reason: "clean", code: 0 });
    const avoid = container.querySelectorAll("[data-toast-avoid]");
    expect(avoid).toHaveLength(1);
    expect(avoid[0]).toBe(strip);
    expect(avoid[0].classList.contains("terminal-disconnect-strip")).toBe(true);

    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "TerminalDisconnectOverlay.css"), "utf8");
    const rule = css.match(/\n\.terminal-disconnect-strip \{([^}]*)\}/)?.[1] ?? "";
    // Pinned to the top edge only: no bottom / inset that would stretch it
    // over the pane.
    expect(rule).toMatch(/top:\s*0/);
    expect(rule).not.toMatch(/(^|\s)(bottom|inset|height):/);
  });

  it("the failed strip is the one keep-clear zone too", async () => {
    transport.setSession(TAB, failed("host unreachable"));
    act(() => root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} />)));
    await flush();
    const avoid = container.querySelectorAll("[data-toast-avoid]");
    expect(avoid).toHaveLength(1);
    expect((avoid[0] as HTMLElement).dataset.variant).toBe("failed");
    expect(avoid[0].classList.contains("terminal-disconnect-strip")).toBe(true);
  });
});
