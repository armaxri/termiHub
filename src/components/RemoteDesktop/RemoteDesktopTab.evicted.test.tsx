/**
 * Window takeover on a graphical tab (#3388, SM-003 single-attach for windows):
 * when another window of this app controls the tab's remote-desktop session, the
 * tab shows the shared "Taken over by another window" overlay with Reclaim over
 * its frozen canvas, suppresses input, and hides every surface that could drive
 * the session (reconnect overlay, cert prompt, toolbar). Nothing reclaims on its
 * own; Reclaim is the explicit button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import type { RemoteDesktopSession } from "@/hooks/useRemoteDesktopSession";
import type { GraphicalSessionState } from "@/types/remoteDesktop";
import { RemoteDesktopTab } from "./RemoteDesktopTab";

const hoisted = vi.hoisted(() => ({
  session: null as unknown as RemoteDesktopSession,
  canvasProps: [] as Array<{ viewOnly: boolean; onReleaseAll?: () => void }>,
}));

vi.mock("@/hooks/useRemoteDesktopSession", () => ({
  useRemoteDesktopSession: () => hoisted.session,
}));

vi.mock("./RemoteDesktopCanvas", () => ({
  RemoteDesktopCanvas: (props: { viewOnly: boolean; onReleaseAll?: () => void }) => {
    hoisted.canvasProps.push({ viewOnly: props.viewOnly, onReleaseAll: props.onReleaseAll });
    return <div data-testid="remote-desktop-canvas" data-view-only={String(props.viewOnly)} />;
  },
}));

vi.mock("@/services/api", () => ({
  claimSession: vi.fn(() => Promise.resolve(null)),
  releaseSession: vi.fn(() => Promise.resolve(true)),
  remoteDesktopGetClipboard: vi.fn(() => Promise.resolve(null)),
}));

const SID = "rd-1";

function fakeSession(state: GraphicalSessionState): RemoteDesktopSession {
  return {
    sessionId: SID,
    state,
    reconnectAttempt: 1,
    message: null,
    remoteClipboard: null,
    certPrompt: {
      session_id: SID,
      host: "mock.local:3389",
      fingerprint: "AA:BB",
      changed: false,
    },
    respondCert: vi.fn(),
    viewOnly: false,
    scaleMode: "fit",
    fixedResolution: false,
    sendInput: vi.fn(),
    releaseInput: vi.fn(),
    resize: vi.fn(),
    sendClipboard: vi.fn(),
    remoteClipboardFiles: vi.fn(async () => []),
    bindClipboardFiles: vi.fn(async () => 0),
    reconnect: vi.fn(),
    cancelReconnect: vi.fn(),
    awaitingFirstFrame: true,
    noteFirstFrame: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;
let tabId: string;
const originalReclaim = useAppStore.getState().reclaimWindowSession;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  hoisted.canvasProps.length = 0;
  tabId = useAppStore
    .getState()
    .addTab(
      "Mock RD",
      "mock-remote-desktop",
      { type: "mock-remote-desktop", config: { host: "mock.local" } },
      { contentType: "remote-desktop" }
    );
  act(() => useAppStore.getState().setTabSessionId(tabId, SID));
  useAppStore.setState({ windowLabel: "main" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAppStore.setState({ reclaimWindowSession: originalReclaim });
});

function render(state: GraphicalSessionState) {
  hoisted.session = fakeSession(state);
  act(() => root.render(withTooltip(<RemoteDesktopTab tabId={tabId} isVisible />)));
}

const q = (id: string) => container.querySelector(`[data-testid='${id}']`);

describe("RemoteDesktopTab — window takeover (#3388)", () => {
  it("renders normally while this window controls the session", () => {
    act(() => useAppStore.setState({ sessionOwners: { [SID]: "main" } }));
    render("reconnecting");
    expect(q("terminal-evicted-overlay")).toBeNull();
    expect(q("remote-desktop-overlay-reconnecting")).not.toBeNull();
    expect(q("remote-desktop-canvas")?.getAttribute("data-view-only")).toBe("false");
    // The owner answers the cert prompt (portalled dialog).
    expect(document.body.textContent).toContain("AA:BB");
  });

  it("shows the Taken-over overlay over a frozen, input-inert canvas", () => {
    act(() => useAppStore.setState({ sessionOwners: { [SID]: "win-2" } }));
    render("active");
    const overlay = q("terminal-evicted-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute("data-evicted-by")).toBe("window");
    expect(overlay?.textContent).toContain("Taken over by another window");
    expect(overlay?.textContent).toContain("Window 2");
    // The canvas stays mounted (frozen last frame) but suppresses input.
    expect(q("remote-desktop-canvas")?.getAttribute("data-view-only")).toBe("true");
    expect(q("remote-desktop-tab")?.getAttribute("data-window-evicted")).toBe("true");
    // Nothing that could drive the session another window controls.
    expect(q("remote-desktop-toolbar")).toBeNull();
    expect(q("remote-desktop-reconnecting-view")).toBeNull();
    // The cert prompt (a portalled dialog) is not rendered by the evicted window.
    expect(document.body.textContent).not.toContain("AA:BB");
  });

  it("the evicted overlay takes precedence over the reconnecting overlay", () => {
    act(() => useAppStore.setState({ sessionOwners: { [SID]: "win-2" } }));
    render("reconnecting");
    expect(q("terminal-evicted-overlay")).not.toBeNull();
    expect(q("remote-desktop-overlay-reconnecting")).toBeNull();

    // Reclaim lands (this window owns it again): the reconnect overlay returns.
    act(() => useAppStore.setState({ sessionOwners: { [SID]: "main" } }));
    expect(q("terminal-evicted-overlay")).toBeNull();
    expect(q("remote-desktop-overlay-reconnecting")).not.toBeNull();
  });

  it("reclaims only on the explicit Reclaim click, never on its own", async () => {
    const reclaimWindowSession = vi.fn(async () => true);
    useAppStore.setState({ reclaimWindowSession, sessionOwners: { [SID]: "win-2" } });
    render("active");
    await act(async () => {
      await Promise.resolve();
    });
    expect(reclaimWindowSession).not.toHaveBeenCalled();

    const btn = container.querySelector<HTMLButtonElement>(
      "[data-testid='terminal-evicted-reclaim-btn']"
    );
    await act(async () => {
      btn?.click();
      await Promise.resolve();
    });
    expect(reclaimWindowSession).toHaveBeenCalledTimes(1);
    expect(reclaimWindowSession).toHaveBeenCalledWith(SID);
  });

  it("wires the canvas's focus-loss release to the session's release-all (#3402)", () => {
    act(() => useAppStore.setState({ sessionOwners: { [SID]: "main" } }));
    render("active");
    expect(hoisted.canvasProps[hoisted.canvasProps.length - 1]?.onReleaseAll).toBe(
      hoisted.session.releaseInput
    );
  });

  it("a session mid-move to another window is not shown as taken over", () => {
    act(() => useAppStore.setState({ sessionOwners: { [SID]: "win-2" }, movingSessionIds: [SID] }));
    render("active");
    expect(q("terminal-evicted-overlay")).toBeNull();
  });
});
