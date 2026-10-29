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
    X: icon("icon-x"),
    Check: icon("icon-check"),
    CircleAlert: icon("icon-circlealert"),
    Clock: icon("icon-clock"),
    Cable: icon("icon-cable"),
    Container: icon("icon-container"),
    Globe: icon("icon-globe"),
    Monitor: icon("icon-monitor"),
    Terminal: icon("icon-terminal"),
    Wifi: icon("icon-wifi"),
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
    terminalConnectDeadline: {},
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
    // The connect deadline the store arms on entry to Connecting (#1263).
    useAppStore.setState({
      terminalConnectDeadline: { [TAB_ID]: { kind: "connecting", at: Date.now() + 86_000 } },
    });
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

  // #5068: the connect surface's motion is CSS-only — the ring fill is a CSS
  // animation and the comet a compositor `transform` — so it can never wait on a
  // stalled JS timer. jsdom runs no animations; assert the wiring here. The live
  // animation is checked in the visual lane (tests/visual/connectOverlay.spec.ts).
  it("renders the progress ring with its CSS-driven timeout fill and comet", async () => {
    await renderConnecting();
    const ring = container.querySelector<HTMLElement>(".ui-connect-progress__ring");
    expect(ring).not.toBeNull();
    expect(ring?.style.getPropertyValue("--cp-duration")).toBe("90000ms");
    expect(ring?.style.getPropertyValue("--cp-delay")).toMatch(/^-\d+ms$/);
    expect(container.querySelector(".ui-connect-progress__ring-fill")).not.toBeNull();
    expect(container.querySelector(".ui-connect-progress__comet")).not.toBeNull();
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

    it("reduced motion: no comet, a static ring beside a steady, announced 'Connecting…' label", async () => {
      motion = mockReducedMotion(true);
      await renderConnecting();
      expect(container.querySelector(".ui-connect-progress__comet")).toBeNull();
      const ring = container.querySelector<HTMLElement>(".ui-connect-progress__ring");
      expect(ring?.style.getPropertyValue("--cp-progress")).not.toBe("");
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
      // Adjacent: the label is the ring's next sibling in the overlay body.
      expect(ring?.nextElementSibling).toBe(label);
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

    it("full motion: adds the orbiting comet, same label", async () => {
      motion = mockReducedMotion(false);
      await renderConnecting();
      expect(container.querySelector(".ui-connect-progress__comet")).not.toBeNull();
      expect(statusLabel()?.textContent).toBe("Connecting…");
    });
  });
});
