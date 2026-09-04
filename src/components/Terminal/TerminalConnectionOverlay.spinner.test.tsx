import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalConnectionOverlay } from "./TerminalConnectionOverlay";
import { useAppStore } from "@/store/appStore";
import {
  connecting,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";

// Render the lucide icons as inspectable spans so the spinner's className is
// visible in the DOM (the real SVG is not needed to assert the motion wiring).
vi.mock("lucide-react", () => {
  const icon =
    (testid: string) =>
    ({ className }: { className?: string }) => <span data-testid={testid} className={className} />;
  return {
    ServerCrash: icon("icon-server-crash"),
    RefreshCw: icon("icon-refresh"),
    Loader2: icon("icon-loader"),
    Zap: icon("icon-zap"),
    Ban: icon("icon-ban"),
    Copy: icon("icon-copy"),
  };
});

const TAB_ID = "tab-test";
const PANEL_ID = "panel-test";

const harness = installSessionLifecycleHarness();

function resetStore() {
  useAppStore.setState({
    terminalSpawnErrors: {},
    terminalAutoRetryCount: {},
    terminalWaitingForAgent: {},
    terminalRetryCounters: {},
    terminalReattaching: {},
  });
}

describe("TerminalConnectionOverlay — connecting spinner motion", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderConnecting() {
    harness.transport.setSession(TAB_ID, connecting());
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    await flushSessionRegion();
  }

  // Regression for #2601: the connecting spinner is the sole "work in progress"
  // cue. Under `prefers-reduced-motion: reduce` the global backstop collapses
  // every animation to a single 0.01ms frame, which froze this spinner into a
  // static icon (reads as "hung"). The `motion-essential-spinner` marker opts the
  // element out of that freeze into a gentle opacity pulse, so the spinner keeps
  // signalling progress. jsdom does not run animations, so assert the wiring
  // (the marker class + the spin class both present) rather than a computed frame.
  it("marks the spinner as essential motion so reduced-motion pulses instead of freezing", async () => {
    await renderConnecting();
    const spinner = container.querySelector("[data-testid='icon-loader']");
    expect(spinner).not.toBeNull();
    expect(spinner?.className).toContain("terminal-connection-overlay__icon--spin");
    expect(spinner?.className).toContain("motion-essential-spinner");
  });
});
