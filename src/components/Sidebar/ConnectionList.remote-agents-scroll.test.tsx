/**
 * Regression tests for #2106: the "Remote Agents" sidebar list must be
 * scrollable. With more agent connections than fit the panel height, the
 * overflow rows were clipped by the section's `overflow: hidden` and could not
 * be reached because the agent rows were rendered directly in the section with
 * no scroll container.
 *
 * The fix wraps the agent rows in a dedicated
 * `.connection-list__agents-scroll` container (`flex: 1 1 auto; min-height: 0;
 * overflow-y: auto`) so the list scrolls internally while the section header
 * and the filter box stay pinned above it. jsdom does not do layout, so these
 * tests assert the structural invariants that make scrolling possible:
 *  - every agent row renders inside the scroll container, and
 *  - the header + filter live OUTSIDE it (so they stay pinned, not scrolled).
 */
import { setupSettingsRegionMirror } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { TooltipProvider } from "@/components/ui";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

vi.mock("./AgentNode", () => ({
  AgentNode: ({
    agent,
    style,
    sectionRef,
  }: {
    agent: RemoteAgentDefinition;
    style?: React.CSSProperties;
    sectionRef?: (el: HTMLDivElement | null) => void;
  }) =>
    React.createElement("div", {
      ref: sectionRef,
      "data-testid": `agent-node-${agent.id}`,
      style,
    }),
}));

function makeAgent(i: number): RemoteAgentDefinition {
  return {
    id: `agent-${i}`,
    name: `Agent ${i}`,
    config: {
      host: `10.0.0.${i}`,
      port: 22,
      username: "user",
      authMethod: "password",
    },
    connectionState: "disconnected",
    isExpanded: false,
    agentSettings: DEFAULT_AGENT_SETTINGS,
  };
}

const baseSettings = {
  version: "1",
  externalConnectionFiles: [] as [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
  experimentalFeaturesEnabled: true,
};

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      React.createElement(TooltipProvider, {
        delayDuration: 0,
        children: React.createElement(ConnectionList),
      })
    );
  });
}

setupSettingsRegionMirror();

describe("ConnectionList – Remote Agents scroll (#2106)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ settings: { ...baseSettings } });
    useAppStore.setState({
      remoteAgents: Array.from({ length: 15 }, (_, i) => makeAgent(i)),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("wraps the agent list in a dedicated scroll container", () => {
    render();
    const scroll = container.querySelector('[data-testid="remote-agents-scroll"]');
    expect(scroll).toBeTruthy();
    expect(scroll?.classList.contains("connection-list__agents-scroll")).toBe(true);
  });

  it("renders every agent row inside the scroll container so overflow rows are reachable", () => {
    render();
    const scroll = container.querySelector('[data-testid="remote-agents-scroll"]');
    expect(scroll).toBeTruthy();

    for (let i = 0; i < 15; i++) {
      const node = container.querySelector(`[data-testid="agent-node-agent-${i}"]`);
      expect(node, `agent-${i} should render`).toBeTruthy();
      // Each agent row must live inside the scroll container, not clipped above it.
      expect(scroll?.contains(node)).toBe(true);
    }
  });

  it("keeps the header and filter pinned outside the scroll container", () => {
    render();
    const scroll = container.querySelector('[data-testid="remote-agents-scroll"]');
    const header = container.querySelector('[data-testid="sidebar-group-header-remote-agents"]');
    const filter = container.querySelector('[data-testid="agent-filter-input"]');

    expect(header).toBeTruthy();
    expect(filter).toBeTruthy();
    // Header + filter are siblings above the scroll region, not scrolled with it.
    expect(scroll?.contains(header)).toBe(false);
    expect(scroll?.contains(filter)).toBe(false);
  });
});
