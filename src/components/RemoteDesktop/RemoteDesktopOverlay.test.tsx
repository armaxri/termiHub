import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RemoteDesktopOverlay } from "./RemoteDesktopOverlay";
import type { GraphicalSessionState } from "@/types/remoteDesktop";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(
  state: GraphicalSessionState,
  overrides: Partial<{ reconnectAttempt: number; message: string | null }> = {}
) {
  const onCancel = vi.fn();
  const onReconnect = vi.fn();
  act(() => {
    root.render(
      <RemoteDesktopOverlay
        state={state}
        host="rd-host"
        reconnectAttempt={overrides.reconnectAttempt ?? 0}
        message={overrides.message ?? null}
        onCancel={onCancel}
        onReconnect={onReconnect}
      />
    );
  });
  return { onCancel, onReconnect };
}

describe("RemoteDesktopOverlay", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing while the session is active or resizing", () => {
    render("active");
    expect(container.textContent).toBe("");
    render("resizing");
    expect(container.textContent).toBe("");
  });

  it("shows a connecting overlay with the host", () => {
    render("connecting");
    const el = query("remote-desktop-overlay-connecting");
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain("Connecting to rd-host");
    expect(el?.textContent).toContain("Establishing connection");
  });

  it("shows an authenticating sub-state on the connecting overlay", () => {
    render("authenticating");
    const el = query("remote-desktop-overlay-connecting");
    expect(el?.textContent).toContain("Authenticating");
  });

  it("shows the reconnecting overlay with a clamped attempt counter and Cancel", () => {
    const { onCancel } = render("reconnecting", { reconnectAttempt: 0 });
    const el = query("remote-desktop-overlay-reconnecting");
    expect(el?.textContent).toContain("Connection lost");
    // reconnectAttempt 0 is clamped up to 1 for display.
    expect(el?.textContent).toContain("attempt 1/3");
    const cancel = Array.from(el?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Cancel"
    );
    act(() => cancel?.click());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("reflects a higher reconnect attempt number", () => {
    render("reconnecting", { reconnectAttempt: 2 });
    expect(query("remote-desktop-overlay-reconnecting")?.textContent).toContain("attempt 2/3");
  });

  it("shows the auth-failed error overlay with a Reconnect action and guidance", () => {
    const { onReconnect } = render("authFailed", { message: "bad password" });
    const el = query("remote-desktop-overlay-error");
    expect(el?.textContent).toContain("Authentication failed");
    expect(el?.textContent).toContain("bad password");
    expect(el?.textContent).toContain("Check the credentials");
    act(() => query("remote-desktop-reconnect")?.click());
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("shows a connect-failed heading", () => {
    render("connectFailed");
    expect(query("remote-desktop-overlay-error")?.textContent).toContain("Could not connect");
  });

  it("shows a server-closed heading for a server-closed session", () => {
    render("serverClosed");
    expect(query("remote-desktop-overlay-error")?.textContent).toContain(
      "Session closed by server"
    );
  });

  it("shows a Disconnected heading for a closed session", () => {
    render("closed");
    expect(query("remote-desktop-overlay-error")?.textContent).toContain("Disconnected");
  });

  it("shows the disconnected state as a reconnecting overlay", () => {
    render("disconnected");
    expect(query("remote-desktop-overlay-reconnecting")).not.toBeNull();
  });

  it("omits the error message block when none is given", () => {
    render("connectFailed", { message: null });
    expect(container.querySelector(".rd-overlay__error")).toBeNull();
  });
});
