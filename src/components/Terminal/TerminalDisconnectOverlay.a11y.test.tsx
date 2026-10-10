/**
 * Screen-reader announcement and focus handling of the terminal disconnect
 * overlay variants (#4331 / A11Y2-002): every failure and disconnect state must
 * land in a live region with the right politeness, describe itself with its
 * message, and move focus to its primary action only in the active tab.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import { consumeTerminalRefocusPending } from "./terminalRefocus";
import {
  authFailed,
  disconnected,
  failed,
  flushSessionRegion,
  idleReconnect,
  installSessionLifecycleHarness,
  reconnecting,
  sessionLost,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { ProjectedSessionLifecycle } from "@/store/sessionBridge";

const TAB = "tab-a11y";
const harness = installSessionLifecycleHarness();

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState({ terminalViewMode: {}, terminalReconnectPrompt: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderWith(life: ProjectedSessionLifecycle, isActive: boolean): Promise<void> {
  harness.transport.setSession(TAB, life);
  act(() => {
    root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} isActive={isActive} />));
  });
  await flushSessionRegion();
}

function liveRegion(): HTMLElement | null {
  return container.querySelector("[data-testid='content-overlay-live']");
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid='${id}']`);
}

describe("TerminalDisconnectOverlay announcements (#4331)", () => {
  it("announces a failed reconnect assertively with its error", async () => {
    await renderWith(failed("connection timed out"), true);
    expect(liveRegion()?.getAttribute("role")).toBe("alert");
    expect(liveRegion()?.textContent).toBe("Reconnect failed. connection timed out");
  });

  it("announces an authentication failure assertively", async () => {
    await renderWith(authFailed("Permission denied (publickey)"), true);
    expect(liveRegion()?.getAttribute("role")).toBe("alert");
    expect(liveRegion()?.textContent).toBe("Authentication failed. Permission denied (publickey)");
  });

  it("announces a lost session assertively with its cause", async () => {
    await renderWith(sessionLost("the live agent session could not be recovered"), true);
    expect(liveRegion()?.getAttribute("role")).toBe("alert");
    expect(liveRegion()?.textContent).toBe(
      "Session lost. the live agent session could not be recovered"
    );
  });

  it("announces a plain disconnect politely", async () => {
    await renderWith(disconnected("unexpected"), true);
    expect(liveRegion()?.getAttribute("role")).toBe("status");
    expect(liveRegion()?.textContent).toContain("Session disconnected.");
  });

  it("announces the busy reconnecting state politely through the live region (#4512)", async () => {
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((recs) => records.push(...recs));
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    await renderWith(reconnecting(idleReconnect()), true);
    records.push(...observer.takeRecords());
    observer.disconnect();
    const region = liveRegion();
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toBe(
      "Reconnecting… Connection lost. Attempting to reconnect automatically."
    );
    // The region was in the document before its text arrived.
    expect(
      records.some((r) => r.target === region && r.type === "childList" && r.addedNodes.length > 0)
    ).toBe(true);
    // The heading no longer announces itself, so nothing is spoken twice.
    const heading = container.querySelector(".ui-content-overlay__heading");
    expect(heading?.textContent).toBe("Reconnecting…");
    expect(heading?.getAttribute("role")).toBeNull();
    expect(heading?.getAttribute("aria-live")).toBeNull();
    expect(container.querySelectorAll("[role='status'], [role='alert'], [aria-live]")).toHaveLength(
      1
    );
  });

  it("describes the failure body by its error message", async () => {
    await renderWith(failed("connection timed out"), true);
    const body = container.querySelector(".ui-content-overlay") as HTMLElement;
    const description = (body.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toContain("connection timed out");
  });

  it("does not re-announce when the overlay re-renders unchanged", async () => {
    await renderWith(failed("connection timed out"), true);
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((recs) => mutations.push(...recs));
    observer.observe(liveRegion() as HTMLElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    for (let i = 0; i < 3; i++) {
      act(() => {
        root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} isActive />));
      });
    }
    await flushSessionRegion();
    observer.disconnect();
    expect(mutations).toHaveLength(0);
  });
});

describe("TerminalDisconnectOverlay focus (#4331)", () => {
  it("moves focus to Try Again on a failed reconnect in the active tab", async () => {
    await renderWith(failed("boom"), true);
    expect(document.activeElement).toBe(byTestId("terminal-disconnect-reconnect-btn"));
  });

  it("moves focus to Start New Shell when the session is lost in the active tab", async () => {
    await renderWith(sessionLost("gone"), true);
    expect(document.activeElement).toBe(byTestId("terminal-session-lost-new-shell-btn"));
  });

  it("moves focus to Reconnect on a disconnect in the active tab", async () => {
    await renderWith(disconnected("unexpected"), true);
    expect(document.activeElement).toBe(byTestId("terminal-disconnect-reconnect-btn"));
  });

  it("leaves focus alone in an inactive tab", async () => {
    await renderWith(failed("boom"), false);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("TerminalDisconnectOverlay — refocus after reconnect (#4513)", () => {
  it("marks the tab when the user clicks Reconnect", async () => {
    const reconnectTerminal = vi.fn();
    useAppStore.setState({ reconnectTerminal });
    consumeTerminalRefocusPending(TAB);
    await renderWith(disconnected("unexpected"), true);
    act(() => byTestId("terminal-disconnect-reconnect-btn")?.click());
    expect(reconnectTerminal).toHaveBeenCalledWith(TAB);
    expect(consumeTerminalRefocusPending(TAB)).toBe(true);
  });

  it("marks the tab when the user clicks Try Again after a failed reconnect", async () => {
    useAppStore.setState({ reconnectTerminal: vi.fn() });
    consumeTerminalRefocusPending(TAB);
    await renderWith(failed("boom"), true);
    act(() => byTestId("terminal-disconnect-reconnect-btn")?.click());
    expect(consumeTerminalRefocusPending(TAB)).toBe(true);
  });

  it("marks the tab when the user starts a new shell after a lost session", async () => {
    const startFreshShellForTab = vi.fn();
    useAppStore.setState({ startFreshShellForTab });
    consumeTerminalRefocusPending(TAB);
    await renderWith(sessionLost("gone"), true);
    act(() => byTestId("terminal-session-lost-new-shell-btn")?.click());
    expect(startFreshShellForTab).toHaveBeenCalledWith(TAB);
    expect(consumeTerminalRefocusPending(TAB)).toBe(true);
  });

  it("does not mark the tab on a mere re-render", async () => {
    consumeTerminalRefocusPending(TAB);
    await renderWith(disconnected("unexpected"), true);
    expect(consumeTerminalRefocusPending(TAB)).toBe(false);
  });
});
