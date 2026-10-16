/**
 * Live remote clipboard in the open panel (#4836): a server-side copy the
 * backend pushes while the panel stays open lands in the draft without
 * reopening, and never clobbers a draft the user is typing — that change
 * waits behind a "Remote clipboard changed" notice with an Apply action.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import type { RemoteDesktopSession } from "@/hooks/useRemoteDesktopSession";
import { remoteDesktopGetClipboard } from "@/services/api";
import { RemoteDesktopTab } from "./RemoteDesktopTab";

const hoisted = vi.hoisted(() => ({
  session: null as unknown as RemoteDesktopSession,
}));

vi.mock("@/hooks/useRemoteDesktopSession", () => ({
  useRemoteDesktopSession: () => hoisted.session,
}));

vi.mock("./RemoteDesktopCanvas", () => ({
  RemoteDesktopCanvas: () => <div data-testid="remote-desktop-canvas" />,
}));

vi.mock("./RemoteDesktopClipboardImage", () => ({
  RemoteDesktopClipboardImage: () => null,
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

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const SID = "rd-clip-push";

function fakeSession(remoteClipboard: string | null): RemoteDesktopSession {
  return {
    sessionId: SID,
    state: "active",
    reconnectAttempt: 0,
    message: null,
    remoteClipboard,
    certPrompt: null,
    respondCert: vi.fn(),
    viewOnly: false,
    scaleMode: "fit",
    fixedResolution: false,
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
  };
}

let container: HTMLDivElement;
let root: Root;
let tabId: string;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.mocked(remoteDesktopGetClipboard).mockResolvedValue("on open");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
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

const byTestId = <T extends HTMLElement = HTMLElement>(id: string) =>
  container.querySelector<T>(`[data-testid='${id}']`);

const draft = () => byTestId<HTMLTextAreaElement>("remote-desktop-clipboard-text")?.value;

/** Render with the session's current remote clipboard. */
function render(remoteClipboard: string | null) {
  hoisted.session = fakeSession(remoteClipboard);
  act(() => root.render(withTooltip(<RemoteDesktopTab tabId={tabId} isVisible />)));
}

/** Open the clipboard panel and let its open-time pull settle. */
async function openPanel() {
  const toggle = byTestId<HTMLButtonElement>("remote-desktop-clipboard-btn");
  if (!toggle) throw new Error("clipboard toggle not rendered");
  await act(async () => {
    toggle.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Type `value` into the panel's textarea like a user would. */
function type(value: string) {
  const ta = byTestId<HTMLTextAreaElement>("remote-desktop-clipboard-text");
  if (!ta) throw new Error("clipboard textarea not rendered");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )!.set!;
  act(() => {
    setter.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("RemoteDesktopTab — live remote clipboard (#4836)", () => {
  it("updates the open panel when the server copies, without reopening", async () => {
    render(null);
    await openPanel();
    expect(draft()).toBe("on open");
    expect(remoteDesktopGetClipboard).toHaveBeenCalledTimes(1);

    // The backend pushes a server-side copy while the panel stays open.
    render("copied on the server");
    expect(draft()).toBe("copied on the server");
    render("copied again");
    expect(draft()).toBe("copied again");
    // No re-pull: the update arrived by push.
    expect(remoteDesktopGetClipboard).toHaveBeenCalledTimes(1);
    expect(byTestId("remote-desktop-clipboard-changed")).toBeNull();
  });

  it("does not clobber a typed draft; the change waits behind an Apply notice", async () => {
    render(null);
    await openPanel();
    type("my unsent draft");

    render("copied on the server");
    expect(draft()).toBe("my unsent draft");
    const notice = byTestId("remote-desktop-clipboard-changed");
    expect(notice?.textContent).toContain("Remote clipboard changed");
    expect(notice?.getAttribute("role")).toBe("status");

    // A newer remote copy replaces the pending one, still not the draft.
    render("newer server copy");
    expect(draft()).toBe("my unsent draft");

    act(() => byTestId<HTMLButtonElement>("remote-desktop-clipboard-apply")?.click());
    expect(draft()).toBe("newer server copy");
    expect(byTestId("remote-desktop-clipboard-changed")).toBeNull();

    // Applied, the draft is in sync again: the next push lands directly.
    render("after apply");
    expect(draft()).toBe("after apply");
  });

  it("sending the draft clears the edit state, so the echo and later pushes land", async () => {
    render(null);
    await openPanel();
    type("to send");
    act(() => byTestId<HTMLButtonElement>("remote-desktop-clipboard-send")?.click());
    expect(hoisted.session.sendClipboard).toHaveBeenCalledWith("to send");

    // The backend's echo of the send, then a later server copy.
    render("to send");
    expect(draft()).toBe("to send");
    render("server copy");
    expect(draft()).toBe("server copy");
    expect(byTestId("remote-desktop-clipboard-changed")).toBeNull();
  });
});
