import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import {
  flushSessionRegion,
  installSessionLifecycleHarness,
  reconnecting,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { ProjectedReconnect } from "@/store/sessionBridge";
import type { TerminalTab } from "@/types/terminal";

// Stub lucide-react icons used in the overlay.
vi.mock("lucide-react", () => ({
  WifiOff: () => null,
  RefreshCw: () => null,
  X: () => null,
  AlertTriangle: () => null,
  Loader2: () => null,
  CheckCircle2: () => null,
}));

/** A `waiting` reconnect detail (the countdown-driving phase). */
function waiting(over: Partial<ProjectedReconnect> = {}): ProjectedReconnect {
  return { phase: "waiting", attempt: 0, delayMs: 2_000, ...over };
}

/**
 * Seed a terminal tab into the active panel tree so the countdown overlay can read
 * its connection config — the source of the on-reconnect command since #2205
 * moved the loop off `appStore` (`onReconnectCommandForTabId`).
 */
function seedTabConfig(onReconnectCommand?: string) {
  const leafId = useAppStore.getState().rootPanel.id;
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: "sess-tab-1",
    title: "srv",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: onReconnectCommand ? { onReconnectCommand } : {} },
    panelId: leafId,
    isActive: true,
  };
  useAppStore.setState({
    rootPanel: { type: "leaf", id: leafId, tabs: [tab], activeTabId: tab.id },
    activePanelId: leafId,
  });
}

describe("TerminalDisconnectOverlay — agentless auto-reconnect variant (#1962)", () => {
  // The reconnect loop is now sourced purely from the projected `session-lifecycle`
  // region (#2205), so seed a `waiting` reconnect there rather than the removed
  // `appStore.terminalAutoReconnect` record. The on-reconnect command still comes
  // from the tab's connection config (see `seedTabConfig`).
  const harness = installSessionLifecycleHarness();

  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Reset the panel tree so a tab's `onReconnectCommand` config seeded by one
    // test (via `seedTabConfig`) does not leak into the next (the command is now
    // read from the tab config, not the removed auto-reconnect record).
    const leafId = useAppStore.getState().rootPanel.id;
    useAppStore.setState({
      rootPanel: { type: "leaf", id: leafId, tabs: [], activeTabId: null },
      terminalExitedTabs: { "tab-1": true },
      terminalDisconnectErrors: {},
      terminalViewMode: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("shows the countdown, attempt progress, and the honest continuity note while waiting", async () => {
    harness.transport.setSession("tab-1", reconnecting(waiting({ attempt: 1, delayMs: 3_400 })));
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });
    await flushSessionRegion();

    expect(container.querySelector("[data-testid='terminal-disconnect-overlay']")).not.toBeNull();
    expect(container.textContent).toContain("reconnecting");
    const countdown = container.querySelector("[data-testid='terminal-auto-reconnect-countdown']");
    expect(countdown?.textContent).toContain("Attempt 2 of 10");
    // Honest about agentless continuity.
    expect(container.textContent).toContain("Local scrollback is preserved");
    expect(container.textContent).toContain("not restored");
  });

  it("announces the on-reconnect command when one is configured (#1978)", async () => {
    seedTabConfig("tmux attach");
    harness.transport.setSession("tab-1", reconnecting(waiting()));
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });
    await flushSessionRegion();

    const note = container.querySelector("[data-testid='terminal-auto-reconnect-command']");
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain("Will run");
    expect(note?.querySelector("code")?.textContent).toBe("tmux attach");
  });

  it("omits the on-reconnect note when no command is configured (#1978)", async () => {
    harness.transport.setSession("tab-1", reconnecting(waiting()));
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });
    await flushSessionRegion();
    expect(container.querySelector("[data-testid='terminal-auto-reconnect-command']")).toBeNull();
  });

  it("takes precedence over the exited/disconnected overlay", async () => {
    harness.transport.setSession("tab-1", reconnecting(waiting()));
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });
    await flushSessionRegion();
    // The manual "Session disconnected" heading must NOT appear while auto-
    // reconnect is counting down.
    expect(container.textContent).not.toContain("Session disconnected");
    expect(container.textContent).toContain("Connection lost");
  });

  it("cancel button stops the loop via cancelAutoReconnect", async () => {
    const cancelSpy = vi.fn();
    useAppStore.setState({ cancelAutoReconnect: cancelSpy });
    harness.transport.setSession("tab-1", reconnecting(waiting()));
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });
    await flushSessionRegion();

    const btn = container.querySelector<HTMLButtonElement>(
      "[data-testid='terminal-auto-reconnect-cancel-btn']"
    );
    expect(btn).not.toBeNull();
    act(() => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(cancelSpy).toHaveBeenCalledWith("tab-1");
  });
});
