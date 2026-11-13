/**
 * Reconnect strip and disconnect overlay wording per transport (#5619, #5666):
 * an unplugged serial device never reads as a lost shell or agent, SSH names
 * the termiHub remote agent only when it is meant, the overlay says the
 * scrollback is kept (it is dimmed behind, not "below"), and its dismiss
 * control sits on the card with a tooltip.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDisconnectOverlay } from "./TerminalDisconnectOverlay";
import { withTooltip } from "@/test/tooltip";
import {
  disconnected,
  flushSessionRegion,
  installSessionLifecycleHarness,
  reconnecting,
  withExit,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { ProjectedSessionLifecycle } from "@/store/sessionBridge";
import type { TerminalTab } from "@/types/terminal";
import { layoutState, seedLayoutState } from "@/test/layoutState";

const TAB = "tab-transport";

function seedTab(config: TerminalTab["config"]) {
  const leafId = layoutState().rootPanel.id;
  const tab: TerminalTab = {
    id: TAB,
    sessionId: "sess-1",
    title: "dev",
    connectionType: config.type,
    contentType: "terminal",
    config,
    panelId: leafId,
    isActive: true,
  };
  seedLayoutState({
    rootPanel: { type: "leaf", id: leafId, tabs: [tab], activeTabId: tab.id },
    activePanelId: leafId,
  });
}

describe("TerminalDisconnectOverlay — transport-specific wording", () => {
  const harness = installSessionLifecycleHarness();
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderWith(life: ProjectedSessionLifecycle): Promise<void> {
    harness.transport.setSession(TAB, life);
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} isActive />));
    });
    await flushSessionRegion();
  }

  const loop = reconnecting({ phase: "waiting", attempt: 0, delayMs: 5_000 });

  it("words a serial unplug as a device, never a shell or agent", async () => {
    seedTab({ type: "serial", config: { port: "/dev/ttyUSB0", baudRate: 115200 } });
    await renderWith(loop);
    const text = container.textContent ?? "";
    expect(text).toContain("Device disconnected — reconnecting…");
    expect(text).toContain("Waiting for /dev/ttyUSB0 to come back.");
    expect(text).not.toMatch(/agent|shell/i);
  });

  it("tells an SSH user their remote shell restarts, without a bare 'agent'", async () => {
    seedTab({ type: "ssh", config: { host: "bastion", username: "me" } });
    await renderWith(loop);
    const detail = container.querySelector("[data-testid='terminal-reconnect-detail']");
    expect(detail?.textContent).toBe(
      "Scrollback is kept. Your remote shell restarts; running programs are lost."
    );
    expect(container.textContent).not.toMatch(/agent/i);
  });

  it("says the telnet connection was closed", async () => {
    seedTab({ type: "telnet", config: { host: "router", port: 23 } });
    await renderWith(loop);
    expect(container.textContent).toContain("Connection closed — reconnecting…");
    expect(container.textContent).not.toMatch(/agent/i);
  });

  it("names the termiHub remote agent for an agent session", async () => {
    seedTab({ type: "remote-session", config: { agentId: "a1", sessionType: "shell" } });
    await renderWith(loop);
    expect(container.textContent).toContain("termiHub remote agent");
  });

  it("says the scrollback is kept, not 'preserved below'", async () => {
    seedTab({ type: "ssh", config: { host: "bastion" } });
    await renderWith(withExit(disconnected("unexpected"), { code: null, reason: "dropped" }));
    const text = container.textContent ?? "";
    expect(text).toContain("Your scrollback is kept — choose View scrollback to read it.");
    expect(text).not.toContain("preserved below");
  });

  it("attaches the dismiss control to the overlay card", async () => {
    seedTab({ type: "telnet", config: { host: "router" } });
    await renderWith(withExit(disconnected("unexpected"), { code: null, reason: "dropped" }));
    const dismiss = container.querySelector("[data-testid='terminal-disconnect-dismiss-btn']");
    const card = dismiss?.closest(".terminal-disconnect-overlay__card");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".ui-content-overlay__heading")?.textContent).toBe(
      "Session disconnected"
    );
  });
});
