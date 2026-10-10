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
  const onCancelConnect = vi.fn();
  const onReconnect = vi.fn();
  act(() => {
    root.render(
      <RemoteDesktopOverlay
        state={state}
        host="rd-host"
        reconnectAttempt={overrides.reconnectAttempt ?? 0}
        message={overrides.message ?? null}
        onCancel={onCancel}
        onCancelConnect={onCancelConnect}
        onReconnect={onReconnect}
      />
    );
  });
  return { onCancel, onCancelConnect, onReconnect };
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

  it.each(["connecting", "authenticating"] as const)(
    "offers Cancel on the %s overlay that aborts the connect (#4298)",
    (state) => {
      const { onCancelConnect, onCancel } = render(state);
      const cancel = query("remote-desktop-cancel-connect");
      expect(cancel?.textContent).toBe("Cancel");
      act(() => cancel?.click());
      expect(onCancelConnect).toHaveBeenCalledOnce();
      expect(onCancel).not.toHaveBeenCalled();
    }
  );

  it("shows the reconnecting overlay with a clamped attempt counter and Cancel", () => {
    const { onCancel } = render("reconnecting", { reconnectAttempt: 0 });
    const el = query("remote-desktop-overlay-reconnecting");
    // Worded exactly like a terminal tab's reconnect (#3730).
    expect(el?.textContent).toContain("Connection lost — reconnecting…");
    // reconnectAttempt 0 is clamped up to 1 for display; the budget is the
    // shared reconnect policy's 10 attempts.
    expect(el?.textContent).toContain("Attempt 1 of 10");
    const cancel = Array.from(el?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Cancel"
    );
    act(() => cancel?.click());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("reflects a higher reconnect attempt number", () => {
    render("reconnecting", { reconnectAttempt: 2 });
    expect(query("remote-desktop-overlay-reconnecting")?.textContent).toContain("Attempt 2 of 10");
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

  it("shows a server-ended session with its reason and a manual Reconnect", () => {
    // A remote logoff / admin disconnect is never auto-reconnected (#4321):
    // no retry spinner, the server's reason, and a Reconnect action.
    const { onReconnect } = render("serverClosed", {
      message: "The disconnection was initiated by the user logging off",
    });
    expect(query("remote-desktop-overlay-reconnecting")).toBeNull();
    const el = query("remote-desktop-overlay-error");
    expect(el?.textContent).toContain("Session ended by the server");
    expect(el?.textContent).toContain("initiated by the user logging off");
    expect(el?.textContent).not.toContain("Connection lost");
    act(() => query("remote-desktop-reconnect")?.click());
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("shows a Disconnected heading for a closed session", () => {
    render("closed");
    expect(query("remote-desktop-overlay-error")?.textContent).toContain("Disconnected");
  });

  it("shows a dropped session with no retry running as the manual reconnect prompt", () => {
    // `disconnected` = Auto-Reconnect off, budget spent, or a non-retryable drop
    // (#3364): no spinner, but a Reconnect action and the backend's reason.
    const { onReconnect } = render("disconnected", {
      reconnectAttempt: 10,
      message: "Reconnect failed after 10 attempts",
    });
    expect(query("remote-desktop-overlay-reconnecting")).toBeNull();
    const el = query("remote-desktop-overlay-error");
    expect(el?.textContent).toContain("Connection lost");
    expect(el?.textContent).toContain("Reconnect failed after 10 attempts");
    act(() => query("remote-desktop-reconnect")?.click());
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("shows a server protocol-error reason with a manual Reconnect (#3479)", () => {
    // A protocol error is terminal (no auto-retry), so it arrives as
    // `disconnected` carrying the backend's reason verbatim.
    const reason = "The VNC server sent data termiHub can't handle: unsupported encoding 7";
    const { onReconnect } = render("disconnected", { message: reason });
    expect(query("remote-desktop-overlay-reconnecting")).toBeNull();
    const el = query("remote-desktop-overlay-error");
    expect(el?.textContent).toContain("Connection lost");
    expect(container.querySelector(".rd-overlay__error")?.textContent).toBe(reason);
    act(() => query("remote-desktop-reconnect")?.click());
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("omits the error message block when none is given", () => {
    render("connectFailed", { message: null });
    expect(container.querySelector(".rd-overlay__error")).toBeNull();
  });

  describe("busy states announce through the live region (#4512)", () => {
    function liveRegion(): HTMLElement | null {
      return query("content-overlay-live");
    }

    it.each([
      ["connecting", {}, "Connecting to rd-host… Establishing connection"],
      ["authenticating", {}, "Connecting to rd-host… Authenticating"],
      ["reconnecting", { reconnectAttempt: 2 }, null],
    ] as const)("%s", (state, overrides, expected) => {
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((recs) => records.push(...recs));
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      render(state, overrides);
      records.push(...observer.takeRecords());
      observer.disconnect();

      const region = liveRegion();
      expect(region?.getAttribute("role")).toBe("status");
      expect(region?.getAttribute("aria-live")).toBe("polite");
      const heading = container.querySelector(".ui-content-overlay__heading");
      const subheading = container.querySelector(".ui-content-overlay__subheading");
      expect(region?.textContent).toBe(
        expected ?? `${heading?.textContent} ${subheading?.textContent}`
      );
      // Mounted empty, then filled: the text landed in an already-live region.
      expect(
        records.some(
          (r) => r.target === region && r.type === "childList" && r.addedNodes.length > 0
        )
      ).toBe(true);
      // Exactly one announcing node — the heading carries no live attributes.
      expect(heading?.getAttribute("role")).toBeNull();
      expect(heading?.getAttribute("aria-live")).toBeNull();
      expect(
        container.querySelectorAll("[role='status'], [role='alert'], [aria-live]")
      ).toHaveLength(1);
    });

    it("does not re-announce the reconnecting state on an unchanged re-render", async () => {
      render("reconnecting", { reconnectAttempt: 2 });
      const mutations: MutationRecord[] = [];
      const observer = new MutationObserver((recs) => mutations.push(...recs));
      observer.observe(liveRegion() as HTMLElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      render("reconnecting", { reconnectAttempt: 2 });
      render("reconnecting", { reconnectAttempt: 2 });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      observer.disconnect();
      expect(mutations).toHaveLength(0);
    });

    it("re-announces in the same region when the reconnect attempt advances", () => {
      render("reconnecting", { reconnectAttempt: 1 });
      const region = liveRegion();
      const before = region?.textContent;
      render("reconnecting", { reconnectAttempt: 2 });
      expect(liveRegion()).toBe(region);
      expect(region?.textContent).not.toBe(before);
    });
  });
});
