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
import { mockReducedMotion, type ReducedMotionMock } from "@/test/reducedMotion";

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
  // every animation to a single 0.01ms frame. The `motion-essential-spinner`
  // marker opts the element out of that collapse into a deliberate *static* icon
  // (#4039 — the earlier opacity pulse read as blinking). jsdom does not run
  // animations, so assert the wiring (marker class + spin class) here; the CSS
  // contract itself is pinned in `styles/animations.reducedMotion.test.ts`.
  it("marks the spinner as essential motion so reduced motion renders it static", async () => {
    await renderConnecting();
    const spinner = container.querySelector("[data-testid='icon-loader']");
    expect(spinner).not.toBeNull();
    expect(spinner?.className).toContain("terminal-connection-overlay__icon--spin");
    expect(spinner?.className).toContain("motion-essential-spinner");
  });

  describe("steady status label (#4039)", () => {
    let motion: ReducedMotionMock;

    afterEach(() => motion.restore());

    function statusLabel() {
      return container.querySelector(".ui-content-overlay__heading");
    }

    function liveRegion() {
      return container.querySelector("[data-testid='content-overlay-live']");
    }

    it("reduced motion: static spinner sits beside a steady, announced 'Connecting…' label", async () => {
      motion = mockReducedMotion(true);
      await renderConnecting();
      const spinner = container.querySelector("[data-testid='icon-loader']");
      expect(spinner?.className).toContain("motion-essential-spinner");
      const label = statusLabel();
      expect(label?.textContent).toBe("Connecting…");
      // #4512: the steady label is announced by the overlay's always-mounted
      // polite live region (mounted empty, then filled); the heading itself
      // carries no live attributes, so the state is spoken exactly once.
      expect(label?.getAttribute("role")).toBeNull();
      expect(label?.getAttribute("aria-live")).toBeNull();
      const region = liveRegion();
      expect(region?.getAttribute("role")).toBe("status");
      expect(region?.getAttribute("aria-live")).toBe("polite");
      expect(region?.textContent).toBe("Connecting… my-server");
      // Adjacent: the label is the spinner's next sibling in the overlay body.
      expect(spinner?.nextElementSibling).toBe(label);
      expect(label?.parentElement?.getAttribute("aria-busy")).toBe("true");
    });

    it("the steady label does not re-announce on every render", async () => {
      motion = mockReducedMotion(true);
      await renderConnecting();
      const mutations: MutationRecord[] = [];
      const observer = new MutationObserver((recs) => mutations.push(...recs));
      observer.observe(liveRegion() as HTMLElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      for (let i = 0; i < 3; i++) {
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
      }
      await flushSessionRegion();
      observer.disconnect();
      expect(mutations).toHaveLength(0);
    });

    it("full motion: renders the same spinner and label (nothing changes)", async () => {
      motion = mockReducedMotion(false);
      await renderConnecting();
      const spinner = container.querySelector("[data-testid='icon-loader']");
      expect(spinner?.className).toContain("terminal-connection-overlay__icon--spin");
      expect(spinner?.className).toContain("motion-essential-spinner");
      expect(statusLabel()?.textContent).toBe("Connecting…");
    });
  });
});
