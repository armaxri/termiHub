/**
 * The remote-desktop tab's controls (#5836): Abort on the waiting-for-the-
 * first-frame overlay, the toolbar shown briefly once the desktop paints,
 * where the keyboard goes, the named scale mode, and a Disconnect that
 * really disconnects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import type { RemoteDesktopSession } from "@/hooks/useRemoteDesktopSession";
import { RemoteDesktopTab, TOOLBAR_REVEAL_MS } from "./RemoteDesktopTab";

const hoisted = vi.hoisted(() => ({
  session: null as unknown as RemoteDesktopSession,
  onDimensions: null as ((w: number, h: number) => void) | null,
  onFirstFrame: null as (() => void) | null,
  onCaptureChange: null as ((captured: boolean) => void) | null,
}));

vi.mock("@/hooks/useRemoteDesktopSession", () => ({
  useRemoteDesktopSession: () => hoisted.session,
}));

vi.mock("./RemoteDesktopCanvas", () => ({
  RemoteDesktopCanvas: (props: {
    onDimensions?: (w: number, h: number) => void;
    onFirstFrame?: () => void;
    onCaptureChange?: (captured: boolean) => void;
  }) => {
    hoisted.onDimensions = props.onDimensions ?? null;
    hoisted.onFirstFrame = props.onFirstFrame ?? null;
    hoisted.onCaptureChange = props.onCaptureChange ?? null;
    return <div data-testid="remote-desktop-canvas" />;
  },
}));

vi.mock("@/services/api", () => ({
  claimSession: vi.fn(() => Promise.resolve(null)),
  releaseSession: vi.fn(() => Promise.resolve(true)),
  remoteDesktopGetClipboard: vi.fn(() => Promise.resolve(null)),
  remoteDesktopFileChannel: vi.fn(() =>
    Promise.resolve({ status: "unavailable", reason: "noRoute" })
  ),
  remoteDesktopMonitorLayout: vi.fn(() => Promise.resolve([])),
}));

const SID = "rd-1";

function fakeSession(over: Partial<RemoteDesktopSession> = {}): RemoteDesktopSession {
  return {
    sessionId: SID,
    state: "active",
    reconnectAttempt: 0,
    message: null,
    errorKind: "other",
    aborted: false,
    remoteClipboard: null,
    certPrompt: null,
    respondCert: vi.fn(),
    viewOnly: false,
    scaleMode: "fit",
    fixedResolution: true,
    multiMonitor: false,
    monitorLayoutVersion: 0,
    sendInput: vi.fn(),
    releaseInput: vi.fn(),
    resize: vi.fn(),
    sendClipboard: vi.fn(),
    remoteClipboardFiles: vi.fn(async () => []),
    bindClipboardFiles: vi.fn(async () => 0),
    reconnect: vi.fn(),
    cancelConnect: vi.fn(),
    cancelReconnect: vi.fn(),
    disconnect: vi.fn(),
    awaitingFirstFrame: false,
    noteFirstFrame: vi.fn(),
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
let tabId: string;

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  vi.useFakeTimers();
  useAppStore.setState(useAppStore.getInitialState());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  hoisted.onDimensions = null;
  hoisted.onFirstFrame = null;
  hoisted.onCaptureChange = null;
  tabId = useAppStore
    .getState()
    .addTab(
      "Desk",
      "vnc",
      { type: "vnc", config: { host: "desk", port: 5900 } },
      { contentType: "remote-desktop" }
    );
  act(() => useAppStore.getState().setTabSessionId(tabId, SID));
  useAppStore.setState({ windowLabel: "main", sessionOwners: { [SID]: "main" } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(session: RemoteDesktopSession = fakeSession()) {
  hoisted.session = session;
  act(() => root.render(withTooltip(<RemoteDesktopTab tabId={tabId} isVisible />)));
}

const toolbar = () => q("remote-desktop-toolbar");

describe("RemoteDesktopTab — controls (#5836)", () => {
  it("aborts the wait for the first frame from the waiting overlay", () => {
    const session = fakeSession();
    render(session);
    act(() => q("remote-desktop-first-frame-abort")?.click());
    expect(session.cancelReconnect).toHaveBeenCalledTimes(1);
    expect(session.reconnect).not.toHaveBeenCalled();
  });

  it("shows the toolbar on its own once the desktop paints, then hides it again", () => {
    render();
    expect(toolbar()?.classList.contains("rd-toolbar--revealed")).toBe(false);
    act(() => hoisted.onFirstFrame?.());
    expect(toolbar()?.classList.contains("rd-toolbar--revealed")).toBe(true);
    act(() => vi.advanceTimersByTime(TOOLBAR_REVEAL_MS + 10));
    expect(toolbar()?.classList.contains("rd-toolbar--revealed")).toBe(false);
  });

  it("says where the keyboard goes as the canvas captures and releases it", () => {
    render();
    const state = () => q("remote-desktop-release-hint")?.getAttribute("data-state");
    expect(state()).toBe("released");
    act(() => hoisted.onCaptureChange?.(true));
    expect(state()).toBe("captured");
    act(() => hoisted.onCaptureChange?.(false));
    expect(state()).toBe("released");
  });

  it("names the scale mode and the one a click switches to", () => {
    render(fakeSession({ scaleMode: "fit", fixedResolution: true }));
    const scale = q("remote-desktop-scale");
    expect(scale?.textContent).toBe("Fit to tab");
    expect(scale?.getAttribute("title")).toBe("Scaling: Fit to tab — click for 1:1 pixel");
    act(() => scale?.click());
    expect(q("remote-desktop-scale")?.textContent).toBe("1:1 pixel");
  });

  it("disconnects from the toolbar without dialling again", () => {
    const session = fakeSession();
    render(session);
    act(() => q("remote-desktop-disconnect")?.click());
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(session.reconnect).not.toHaveBeenCalled();
  });
});
