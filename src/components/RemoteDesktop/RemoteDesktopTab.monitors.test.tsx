/**
 * Multi-monitor viewport selection on a graphical tab (#3696): the tab reads
 * the session's monitors once the framebuffer size is known, and the toolbar's
 * selector cycles the canvas between the combined desktop and each monitor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import type { RemoteDesktopSession } from "@/hooks/useRemoteDesktopSession";
import type { MonitorRect } from "@/types/remoteDesktop";
import type { Viewport } from "./monitorLayout";
import { RemoteDesktopTab } from "./RemoteDesktopTab";

const hoisted = vi.hoisted(() => ({
  session: null as unknown as RemoteDesktopSession,
  viewport: undefined as Viewport | null | undefined,
  onDimensions: null as ((w: number, h: number) => void) | null,
  monitors: [] as MonitorRect[],
}));

vi.mock("@/hooks/useRemoteDesktopSession", () => ({
  useRemoteDesktopSession: () => hoisted.session,
}));

vi.mock("./RemoteDesktopCanvas", () => ({
  RemoteDesktopCanvas: (props: {
    viewport?: Viewport | null;
    onDimensions?: (w: number, h: number) => void;
  }) => {
    hoisted.viewport = props.viewport;
    hoisted.onDimensions = props.onDimensions ?? null;
    return <div data-testid="remote-desktop-canvas" />;
  },
}));

vi.mock("@/services/api", () => ({
  claimSession: vi.fn(() => Promise.resolve(null)),
  releaseSession: vi.fn(() => Promise.resolve(true)),
  remoteDesktopGetClipboard: vi.fn(() => Promise.resolve(null)),
  remoteDesktopMonitorLayout: vi.fn(() => Promise.resolve(hoisted.monitors)),
}));

const SID = "rd-1";

const TWO: MonitorRect[] = [
  { x: 0, y: 0, width: 1024, height: 768, primary: true, scale: 100 },
  { x: 1024, y: 0, width: 1024, height: 768, primary: false, scale: 100 },
];

function fakeSession(): RemoteDesktopSession {
  return {
    sessionId: SID,
    state: "active",
    reconnectAttempt: 0,
    message: null,
    remoteClipboard: null,
    certPrompt: null,
    respondCert: vi.fn(),
    viewOnly: false,
    scaleMode: "fit",
    fixedResolution: true,
    multiMonitor: true,
    monitorLayoutVersion: 0,
    sendInput: vi.fn(),
    releaseInput: vi.fn(),
    resize: vi.fn(),
    sendClipboard: vi.fn(),
    remoteClipboardFiles: vi.fn(async () => []),
    bindClipboardFiles: vi.fn(async () => 0),
    reconnect: vi.fn(),
    cancelReconnect: vi.fn(),
    awaitingFirstFrame: false,
    noteFirstFrame: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;
let tabId: string;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  hoisted.viewport = undefined;
  hoisted.onDimensions = null;
  hoisted.monitors = TWO;
  tabId = useAppStore
    .getState()
    .addTab(
      "Mock RD",
      "mock-remote-desktop",
      { type: "mock-remote-desktop", config: { host: "mock.local", monitors: "all" } },
      { contentType: "remote-desktop" }
    );
  act(() => useAppStore.getState().setTabSessionId(tabId, SID));
  useAppStore.setState({ windowLabel: "main", sessionOwners: { [SID]: "main" } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Render the tab and report a `width x height` framebuffer from the canvas. */
async function renderWithFramebuffer(width: number, height: number) {
  hoisted.session = fakeSession();
  act(() => root.render(withTooltip(<RemoteDesktopTab tabId={tabId} isVisible />)));
  await act(async () => {
    hoisted.onDimensions?.(width, height);
    await Promise.resolve();
  });
}

const selector = () =>
  container.querySelector<HTMLButtonElement>("[data-testid='remote-desktop-monitor']");

describe("RemoteDesktopTab — multi-monitor viewports (#3696)", () => {
  it("cycles the canvas through all monitors, each monitor, and back", async () => {
    await renderWithFramebuffer(2048, 768);
    expect(hoisted.viewport).toBeNull();
    const seen: Array<Viewport | null | undefined> = [];
    for (let i = 0; i < 3; i++) {
      const btn = selector();
      if (!btn) throw new Error("viewport selector not rendered");
      act(() => btn.click());
      seen.push(hoisted.viewport);
    }
    expect(seen).toEqual([
      { x: 0, y: 0, width: 1024, height: 768 },
      { x: 1024, y: 0, width: 1024, height: 768 },
      null,
    ]);
  });

  it("offers no selector when the server kept a single monitor", async () => {
    // The combined size was not honored: the second monitor lies outside.
    await renderWithFramebuffer(1024, 768);
    expect(selector()).toBeNull();
    expect(hoisted.viewport).toBeNull();
  });
});
