import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import type { TerminalAutoReconnectState } from "@/types/terminal";

// Stub lucide-react icons used in the overlay.
vi.mock("lucide-react", () => ({
  WifiOff: () => null,
  RefreshCw: () => null,
  X: () => null,
  AlertTriangle: () => null,
  Loader2: () => null,
  CheckCircle2: () => null,
}));

function setAuto(tabId: string, state: Partial<TerminalAutoReconnectState>) {
  const full: TerminalAutoReconnectState = {
    phase: "waiting",
    attempt: 0,
    maxAttempts: 10,
    delayMs: 2_000,
    nextAttemptAt: Date.now() + 2_000,
    ...state,
  };
  useAppStore.setState({ terminalAutoReconnect: { [tabId]: full } });
}

describe("TerminalDisconnectOverlay — agentless auto-reconnect variant (#1962)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({
      terminalExitedTabs: { "tab-1": true },
      terminalDisconnectErrors: {},
      terminalViewMode: {},
      terminalReconnectingTabs: {},
      terminalReconnectTriggerErrors: {},
      terminalAutoReconnect: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("shows the countdown, attempt progress, and the honest continuity note while waiting", () => {
    setAuto("tab-1", { attempt: 1, maxAttempts: 10, nextAttemptAt: Date.now() + 3_400 });
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });

    expect(container.querySelector("[data-testid='terminal-disconnect-overlay']")).not.toBeNull();
    expect(container.textContent).toContain("reconnecting");
    const countdown = container.querySelector("[data-testid='terminal-auto-reconnect-countdown']");
    expect(countdown?.textContent).toContain("Attempt 2 of 10");
    // Honest about agentless continuity.
    expect(container.textContent).toContain("Local scrollback is preserved");
    expect(container.textContent).toContain("not restored");
  });

  it("takes precedence over the exited/disconnected overlay", () => {
    setAuto("tab-1", {});
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });
    // The manual "Session disconnected" heading must NOT appear while auto-
    // reconnect is counting down.
    expect(container.textContent).not.toContain("Session disconnected");
    expect(container.textContent).toContain("Connection lost");
  });

  it("cancel button stops the loop via cancelAutoReconnect", () => {
    const cancelSpy = vi.fn();
    useAppStore.setState({ cancelAutoReconnect: cancelSpy });
    setAuto("tab-1", {});
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId="tab-1" />));
    });

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
