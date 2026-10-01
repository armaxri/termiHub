/**
 * Tests for the connected-agent summary segment of the status bar (#1347, #4009).
 *
 * The segment (`agent-updates-indicator`) counts the agents whose
 * `connectionState` is `connected` in the authoritative `agents` region and how
 * many of them run an older minor version than the desktop. Its tooltip and
 * accessible name read "N agents · M updates available — click to open
 * Connections" (or "N agents connected — …" when nothing is outdated). It is
 * hidden when no agent is connected, and a click opens the Connections sidebar.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { StatusBar } from "./StatusBar";
import {
  DEFAULT_AGENT_SETTINGS,
  type AgentCapabilities,
  type RemoteAgentDefinition,
} from "@/types/connection";
import { seedAgentsRegion, setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";

// The desktop version the agents are compared against. Mocked so the test does
// not depend on the one-time `getAppInfo` IPC fetch.
const DESKTOP_VERSION = "0.5.0";
vi.mock("@/hooks/useDesktopVersion", () => ({
  useDesktopVersion: () => DESKTOP_VERSION,
}));

// Stub the unrelated status-bar children so the test isolates the segment.
vi.mock("@/components/CredentialStoreIndicator", () => ({ CredentialStoreIndicator: () => null }));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

setupAgentsRegion();

function agent(
  id: string,
  connectionState: RemoteAgentDefinition["connectionState"],
  agentVersion?: string
): RemoteAgentDefinition {
  return {
    id,
    name: `Agent ${id}`,
    config: { host: `${id}.example.com`, port: 22, username: "user", authMethod: "key" },
    connectionState,
    isExpanded: false,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    // The summary reads only `agentVersion`; the rest of the capabilities
    // record is irrelevant here.
    ...(agentVersion ? { capabilities: { agentVersion } as AgentCapabilities } : {}),
  };
}

function renderStatusBar(root: Root) {
  // Zero delay so a focus reveals the tooltip synchronously.
  root.render(
    React.createElement(TooltipProvider, { delayDuration: 0 }, React.createElement(StatusBar))
  );
}

describe("StatusBar — connected-agent update summary (#1347)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const indicator = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="agent-updates-indicator"]');

  /**
   * Focus the segment and return the text of the tooltip it reveals: the
   * `role="tooltip"` node Radix renders for screen readers (the visible content
   * box nests that node next to its own copy, so its text would read twice).
   */
  function tooltipText(): string | null {
    const trigger = indicator()!;
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });
    return document.querySelector('[role="tooltip"]')?.textContent ?? null;
  }

  it("is hidden when no agent is connected", async () => {
    seedAgentsRegion({
      remoteAgents: [agent("a", "disconnected", "0.1.0"), agent("b", "connecting")],
    });

    act(() => renderStatusBar(root));
    await flushAsync();

    expect(indicator()).toBeNull();
  });

  it("shows 'N agents · M updates available' counting only connected agents", async () => {
    seedAgentsRegion({
      remoteAgents: [
        agent("old1", "connected", "0.3.2"),
        agent("old2", "connected", "0.4.0"),
        agent("current", "connected", DESKTOP_VERSION),
        // Outdated but not connected: counted neither as an agent nor an update.
        agent("offline", "disconnected", "0.1.0"),
      ],
    });

    act(() => renderStatusBar(root));
    await flushAsync();

    const item = indicator();
    expect(item).not.toBeNull();
    const expected = "3 agents · 2 updates available — click to open Connections";
    expect(item!.getAttribute("aria-label")).toBe(expected);
    expect(item!.textContent).toBe("32");
    expect(container.querySelector('[data-testid="agent-updates-count"]')!.textContent).toBe("2");
    expect(tooltipText()).toBe(expected);
  });

  it("uses the singular forms for one agent with one update", async () => {
    seedAgentsRegion({ remoteAgents: [agent("old", "connected", "0.4.9")] });

    act(() => renderStatusBar(root));
    await flushAsync();

    const expected = "1 agent · 1 update available — click to open Connections";
    expect(indicator()!.getAttribute("aria-label")).toBe(expected);
    expect(tooltipText()).toBe(expected);
  });

  it("drops the update count when every connected agent is current", async () => {
    seedAgentsRegion({
      remoteAgents: [agent("a", "connected", DESKTOP_VERSION), agent("b", "connected", "0.5.3")],
    });

    act(() => renderStatusBar(root));
    await flushAsync();

    const expected = "2 agents connected — click to open Connections";
    expect(indicator()!.getAttribute("aria-label")).toBe(expected);
    expect(container.querySelector('[data-testid="agent-updates-count"]')).toBeNull();
    expect(tooltipText()).toBe(expected);
  });

  it("opens the Connections sidebar when clicked", async () => {
    useAppStore.setState({ sidebarView: "services" });
    seedAgentsRegion({ remoteAgents: [agent("old", "connected", "0.4.0")] });

    act(() => renderStatusBar(root));
    await flushAsync();

    act(() => {
      indicator()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useAppStore.getState().sidebarView).toBe("connections");
  });
});
