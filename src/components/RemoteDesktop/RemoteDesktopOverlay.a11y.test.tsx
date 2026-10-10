/**
 * Screen-reader announcement and focus handling of the remote-desktop resting
 * (non-busy) overlay states (#4514, follow-up to #4331): failures are announced
 * assertively, intentional closes politely, each exactly once with the backend
 * message; Reconnect takes focus only in the active tab; and axe passes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RemoteDesktopOverlay } from "./RemoteDesktopOverlay";
import { checkA11y } from "@/test/axe";
import type { GraphicalSessionState } from "@/types/remoteDesktop";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(state: GraphicalSessionState, message: string | null, isActive = true): void {
  act(() => {
    root.render(
      <RemoteDesktopOverlay
        state={state}
        host="rd-host"
        reconnectAttempt={0}
        message={message}
        onCancel={vi.fn()}
        onCancelConnect={vi.fn()}
        onReconnect={vi.fn()}
        isActive={isActive}
      />
    );
  });
}

function liveRegion(): HTMLElement {
  const regions = container.querySelectorAll<HTMLElement>(
    "[role='status'], [role='alert'], [aria-live]"
  );
  expect(regions).toHaveLength(1);
  return regions[0];
}

function reconnectButton(): HTMLElement | null {
  return container.querySelector('[data-testid="remote-desktop-reconnect"]');
}

describe("RemoteDesktopOverlay resting-state announcement (#4514)", () => {
  it.each([
    ["connectFailed", "Could not connect. Connection refused"],
    ["disconnected", "Connection lost. Connection refused"],
  ] as const)("announces %s assertively with its message", (state, spoken) => {
    render(state, "Connection refused");
    const region = liveRegion();
    expect(region.getAttribute("role")).toBe("alert");
    expect(region.textContent).toBe(spoken);
  });

  it("announces an auth failure assertively with the credentials hint", () => {
    render("authFailed", "Invalid password");
    const region = liveRegion();
    expect(region.getAttribute("role")).toBe("alert");
    expect(region.textContent).toBe(
      "Authentication failed. Invalid password Check the credentials and try again."
    );
    const body = container.querySelector(".ui-content-overlay") as HTMLElement;
    const description = (body.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toBe("Invalid password Check the credentials and try again.");
  });

  it.each([
    ["serverClosed", "Session ended by the server."],
    ["closed", "Disconnected."],
  ] as const)("announces %s politely", (state, spoken) => {
    render(state, null);
    const region = liveRegion();
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toBe(spoken);
    const body = container.querySelector(".ui-content-overlay") as HTMLElement;
    expect(body.getAttribute("aria-describedby")).toBeNull();
  });

  it("focuses Reconnect in the active tab only", () => {
    render("connectFailed", "Connection refused");
    expect(document.activeElement).toBe(reconnectButton());
    act(() => root.unmount());
    root = createRoot(container);
    (document.activeElement as HTMLElement | null)?.blur();
    render("connectFailed", "Connection refused", false);
    expect(reconnectButton()).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("has no axe violations", async () => {
    render("authFailed", "Invalid password");
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
