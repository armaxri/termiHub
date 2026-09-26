/**
 * Scale-mode cycling on a graphical tab (PROD-026): a dynamic session cycles
 * Fit → 1:1 → Match Window, while a fixed-resolution session only toggles
 * Fit ↔ 1:1 — it scales the canvas locally and never enters Match Window (the
 * mode that asks the remote to resize).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import type { RemoteDesktopSession } from "@/hooks/useRemoteDesktopSession";
import type { ScaleMode } from "@/types/remoteDesktop";
import { RemoteDesktopTab } from "./RemoteDesktopTab";

const hoisted = vi.hoisted(() => ({
  session: null as unknown as RemoteDesktopSession,
  scaleModes: [] as string[],
}));

vi.mock("@/hooks/useRemoteDesktopSession", () => ({
  useRemoteDesktopSession: () => hoisted.session,
}));

vi.mock("./RemoteDesktopCanvas", () => ({
  RemoteDesktopCanvas: (props: { scaleMode: string }) => {
    hoisted.scaleModes.push(props.scaleMode);
    return <div data-testid="remote-desktop-canvas" data-scale-mode={props.scaleMode} />;
  },
}));

vi.mock("@/services/api", () => ({
  claimSession: vi.fn(() => Promise.resolve(null)),
  releaseSession: vi.fn(() => Promise.resolve(true)),
  remoteDesktopGetClipboard: vi.fn(() => Promise.resolve(null)),
}));

const SID = "rd-1";

function fakeSession(fixedResolution: boolean, scaleMode: ScaleMode): RemoteDesktopSession {
  return {
    sessionId: SID,
    state: "active",
    reconnectAttempt: 0,
    message: null,
    remoteClipboard: null,
    certPrompt: null,
    respondCert: vi.fn(),
    viewOnly: false,
    scaleMode,
    fixedResolution,
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
  hoisted.scaleModes.length = 0;
  tabId = useAppStore
    .getState()
    .addTab(
      "Mock RD",
      "mock-remote-desktop",
      { type: "mock-remote-desktop", config: { host: "mock.local" } },
      { contentType: "remote-desktop" }
    );
  act(() => useAppStore.getState().setTabSessionId(tabId, SID));
  useAppStore.setState({ windowLabel: "main", sessionOwners: { [SID]: "main" } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(fixedResolution: boolean, scaleMode: ScaleMode = "fit") {
  hoisted.session = fakeSession(fixedResolution, scaleMode);
  act(() => root.render(withTooltip(<RemoteDesktopTab tabId={tabId} isVisible />)));
}

const canvasMode = () =>
  container.querySelector("[data-testid='remote-desktop-canvas']")?.getAttribute("data-scale-mode");

/** Click the toolbar scaling button `times` times, recording each mode. */
function cycle(times: number): Array<string | null | undefined> {
  const seen: Array<string | null | undefined> = [];
  for (let i = 0; i < times; i++) {
    const btn = container.querySelector<HTMLButtonElement>("[data-testid='remote-desktop-scale']");
    if (!btn) throw new Error("scale button not rendered");
    act(() => btn.click());
    seen.push(canvasMode());
  }
  return seen;
}

describe("RemoteDesktopTab — scale-mode cycling (PROD-026)", () => {
  it("cycles Fit → 1:1 → Match Window for a dynamic session", () => {
    render(false);
    expect(canvasMode()).toBe("fit");
    expect(cycle(3)).toEqual(["pixel", "match", "fit"]);
  });

  it("only toggles Fit ↔ 1:1 for a fixed-resolution session", () => {
    render(true);
    expect(canvasMode()).toBe("fit");
    expect(cycle(3)).toEqual(["pixel", "fit", "pixel"]);
    expect(hoisted.scaleModes).not.toContain("match");
  });

  it("never hands the canvas Match Window for a fixed session", () => {
    // Defensive: even if the session reported "match", the tab scales locally.
    render(true, "match");
    expect(canvasMode()).toBe("fit");
    expect(hoisted.scaleModes).not.toContain("match");
  });
});
