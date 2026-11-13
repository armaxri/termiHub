/**
 * A graphical tab whose session is up but has painted nothing yet (#5626):
 * it shows the "waiting for the first frame" overlay instead of a blank pane,
 * falls back to a "No picture" error after the timeout, and surfaces the
 * framebuffer resolution to the status bar only once a frame has painted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import type { RemoteDesktopSession } from "@/hooks/useRemoteDesktopSession";
import { FIRST_FRAME_TIMEOUT_MS, RemoteDesktopTab } from "./RemoteDesktopTab";

const hoisted = vi.hoisted(() => ({
  session: null as unknown as RemoteDesktopSession,
  onDimensions: null as ((w: number, h: number) => void) | null,
  onFirstFrame: null as (() => void) | null,
}));

vi.mock("@/hooks/useRemoteDesktopSession", () => ({
  useRemoteDesktopSession: () => hoisted.session,
}));

vi.mock("./RemoteDesktopCanvas", () => ({
  RemoteDesktopCanvas: (props: {
    onDimensions?: (w: number, h: number) => void;
    onFirstFrame?: () => void;
  }) => {
    hoisted.onDimensions = props.onDimensions ?? null;
    hoisted.onFirstFrame = props.onFirstFrame ?? null;
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

describe("RemoteDesktopTab — first frame (#5626)", () => {
  it("shows the waiting overlay over an active session until the first frame paints", () => {
    render();
    expect(q("remote-desktop-overlay-first-frame")).not.toBeNull();
    act(() => hoisted.onFirstFrame?.());
    expect(q("remote-desktop-overlay-first-frame")).toBeNull();
    expect(q("remote-desktop-overlay-no-frame")).toBeNull();
  });

  it("still tells the session hook about the first frame", () => {
    const session = fakeSession();
    render(session);
    act(() => hoisted.onFirstFrame?.());
    expect(session.noteFirstFrame).toHaveBeenCalledTimes(1);
  });

  it("rests on the no-picture error after the timeout, and Retry reconnects", () => {
    const session = fakeSession();
    render(session);
    act(() => vi.advanceTimersByTime(FIRST_FRAME_TIMEOUT_MS + 10));
    expect(q("remote-desktop-overlay-first-frame")).toBeNull();
    expect(q("remote-desktop-overlay-no-frame")).not.toBeNull();
    act(() => q("remote-desktop-first-frame-retry")?.click());
    expect(session.reconnect).toHaveBeenCalledTimes(1);
  });

  it("never times out once a frame has painted", () => {
    render();
    act(() => hoisted.onFirstFrame?.());
    act(() => vi.advanceTimersByTime(FIRST_FRAME_TIMEOUT_MS * 2));
    expect(q("remote-desktop-overlay-no-frame")).toBeNull();
  });

  it("keeps the cross-window reconnecting-view placeholder instead while adopting", () => {
    render(fakeSession({ awaitingFirstFrame: true }));
    expect(q("remote-desktop-reconnecting-view")).not.toBeNull();
    expect(q("remote-desktop-overlay-first-frame")).toBeNull();
  });

  it("shows no waiting overlay while the session is still connecting", () => {
    render(fakeSession({ state: "connecting" }));
    expect(q("remote-desktop-overlay-connecting")).not.toBeNull();
    expect(q("remote-desktop-overlay-first-frame")).toBeNull();
  });

  it("surfaces the resolution to the status bar only once a frame has painted", () => {
    render();
    act(() => hoisted.onDimensions?.(1024, 768));
    expect(useAppStore.getState().remoteDesktopResolutions[SID]).toBeUndefined();
    act(() => hoisted.onFirstFrame?.());
    expect(useAppStore.getState().remoteDesktopResolutions[SID]).toEqual({
      width: 1024,
      height: 768,
    });
    // Later size changes go straight through.
    act(() => hoisted.onDimensions?.(1280, 800));
    expect(useAppStore.getState().remoteDesktopResolutions[SID]).toEqual({
      width: 1280,
      height: 800,
    });
  });
});
