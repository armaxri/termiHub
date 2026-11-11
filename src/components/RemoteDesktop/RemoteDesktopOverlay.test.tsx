import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RemoteDesktopOverlay } from "./RemoteDesktopOverlay";
import type { GraphicalSessionState } from "@/types/remoteDesktop";
import type { ConnectionErrorKind } from "@/utils/connectionErrorHints";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(
  state: GraphicalSessionState,
  overrides: Partial<{
    reconnectAttempt: number;
    message: string | null;
    errorKind: ConnectionErrorKind;
    aborted: boolean;
    editable: boolean;
  }> = {}
) {
  const onCancel = vi.fn();
  const onCancelConnect = vi.fn();
  const onReconnect = vi.fn();
  const onCloseTab = vi.fn();
  const onEditConnection = vi.fn();
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
        onCloseTab={onCloseTab}
        onEditConnection={overrides.editable === false ? undefined : onEditConnection}
        errorKind={overrides.errorKind}
        aborted={overrides.aborted}
        credentialReentry={<div data-testid="fake-credential-reentry" />}
      />
    );
  });
  return { onCancel, onCancelConnect, onReconnect, onCloseTab, onEditConnection };
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
    "offers Abort on the %s overlay that aborts the connect (#4298, #5068)",
    (state) => {
      const { onCancelConnect, onCancel } = render(state);
      const cancel = query("remote-desktop-cancel-connect");
      expect(cancel?.textContent).toBe("Abort");
      act(() => cancel?.click());
      expect(onCancelConnect).toHaveBeenCalledOnce();
      expect(onCancel).not.toHaveBeenCalled();
    }
  );

  it("shows the reconnecting overlay with a clamped attempt counter and Abort", () => {
    const { onCancel } = render("reconnecting", { reconnectAttempt: 0 });
    const el = query("remote-desktop-overlay-reconnecting");
    // Worded exactly like a terminal tab's reconnect (#3730).
    expect(el?.textContent).toContain("Connection lost — reconnecting…");
    // reconnectAttempt 0 is clamped up to 1 for display; the budget is the
    // shared reconnect policy's 10 attempts.
    expect(el?.textContent).toContain("Attempt 1 of 10");
    const cancel = Array.from(el?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Abort"
    );
    act(() => cancel?.click());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("reflects a higher reconnect attempt number", () => {
    render("reconnecting", { reconnectAttempt: 2 });
    expect(query("remote-desktop-overlay-reconnecting")?.textContent).toContain("Attempt 2 of 10");
  });

  describe("failed or aborted connect rests on the terminal's failure screen (#5377)", () => {
    it("auth failure: humanised hint, credential re-entry, Retry / Edit / Close tab", () => {
      const { onReconnect, onCloseTab, onEditConnection } = render("authFailed", {
        message: "bad password",
      });
      const el = query("remote-desktop-overlay-error");
      expect(el?.querySelector(".ui-connect-progress")?.getAttribute("data-phase")).toBe("failed");
      expect(el?.textContent).toContain("Connection failed");
      expect(el?.textContent).toContain("bad password");
      expect(el?.textContent).toContain("The server rejected the credentials");
      expect(query("fake-credential-reentry")).not.toBeNull();
      // No Reconnect loop: the primary action is Retry, beside Close tab.
      expect(query("remote-desktop-reconnect")).toBeNull();
      expect(query("remote-desktop-retry")?.textContent).toBe("Retry");
      expect(query("remote-desktop-close-tab")?.textContent).toBe("Close tab");
      act(() => query("remote-desktop-retry")?.click());
      expect(onReconnect).toHaveBeenCalledOnce();
      act(() => query("remote-desktop-edit")?.click());
      expect(onEditConnection).toHaveBeenCalledOnce();
      act(() => query("remote-desktop-close-tab")?.click());
      expect(onCloseTab).toHaveBeenCalledOnce();
    });

    it("connect failure without a typed code: generic heading and the backend reason", () => {
      render("connectFailed", { message: "sidecar exited" });
      const el = query("remote-desktop-overlay-error");
      expect(el?.textContent).toContain("Connection failed");
      expect(el?.textContent).toContain("sidecar exited");
      expect(query("fake-credential-reentry")).toBeNull();
      expect(query("remote-desktop-retry")).not.toBeNull();
    });

    it("refused connect names itself and tucks the OS error behind Details", () => {
      render("connectFailed", { message: "os error 61", errorKind: "refused" });
      const el = query("remote-desktop-overlay-error");
      expect(el?.textContent).toContain("Connection refused");
      expect(query("terminal-connection-error-details")?.textContent).toContain("os error 61");
    });

    it("timeout rests on the timed-out phase", () => {
      render("connectFailed", { message: "timed out", errorKind: "timeout" });
      const el = query("remote-desktop-overlay-error");
      expect(el?.querySelector(".ui-connect-progress")?.getAttribute("data-phase")).toBe("timeout");
      expect(el?.textContent).toContain("Timed out");
    });

    it("user abort: Connection aborted with Retry and Close tab, no Edit", () => {
      const { onReconnect, onCloseTab } = render("closed", { aborted: true });
      const el = query("remote-desktop-overlay-error");
      expect(el?.querySelector(".ui-connect-progress")?.getAttribute("data-phase")).toBe("aborted");
      expect(el?.textContent).toContain("Connection aborted");
      expect(el?.textContent).not.toContain("Disconnected");
      expect(query("remote-desktop-edit")).toBeNull();
      act(() => query("remote-desktop-retry")?.click());
      expect(onReconnect).toHaveBeenCalledOnce();
      act(() => query("remote-desktop-close-tab")?.click());
      expect(onCloseTab).toHaveBeenCalledOnce();
    });

    it("hides Edit connection for a tab without a saved connection", () => {
      render("connectFailed", { message: "x", editable: false });
      expect(query("remote-desktop-edit")).toBeNull();
    });
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

  it("shows a Disconnected heading with Reconnect and Close tab for a closed session", () => {
    const { onCloseTab } = render("closed");
    expect(query("remote-desktop-overlay-error")?.textContent).toContain("Disconnected");
    expect(query("remote-desktop-reconnect")).not.toBeNull();
    act(() => query("remote-desktop-close-tab")?.click());
    expect(onCloseTab).toHaveBeenCalledOnce();
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
    render("disconnected", { message: null });
    expect(container.querySelector(".rd-overlay__error")).toBeNull();
    render("connectFailed", { message: null });
    expect(container.querySelector(".ui-connect-progress__error")).toBeNull();
  });

  describe("busy states announce through the live region (#4512)", () => {
    function liveRegion(): HTMLElement | null {
      return query("content-overlay-live");
    }

    it.each([
      ["connecting", {}, "Connecting to rd-host… Establishing connection"],
      ["authenticating", {}, "Connecting to rd-host… Authenticating"],
      ["reconnecting", { reconnectAttempt: 2 }, "Connection lost — reconnecting… Attempt 2 of 10"],
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
