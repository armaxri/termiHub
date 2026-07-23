/**
 * Regression tests for #1822: collapsing the "Remote Agents" group must fold
 * away its contents AND reclaim the sidebar space it occupied.
 *
 * The child items were already hidden by the `!remoteAgentsCollapsed` render
 * guards, but the outer wrapper still grew to fill the column because its flex
 * slot was keyed on `experimentalFeaturesEnabled` instead of the collapsed
 * state — leaving an empty gap that "gives free view over the side bar".
 */
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

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: "agent-1",
    name: "Test Agent",
    config: {
      host: "10.0.0.1",
      port: 22,
      username: "user",
      authMethod: "password",
    },
    connectionState: "disconnected",
    isExpanded: false,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    ...overrides,
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

function clickRemoteAgentsToggle() {
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-testid="connection-list-remote-agents-toggle"]'
  );
  act(() => {
    toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ConnectionList – Remote Agents collapse (#1822)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ settings: { ...baseSettings } });
    useAppStore.setState({ remoteAgents: [makeAgent()] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("expanded by default: children visible and toggle marked expanded", () => {
    render();

    expect(container.querySelector('[data-testid="agent-node-agent-1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="agent-filter-input"]')).toBeTruthy();
    const toggle = container.querySelector('[data-testid="connection-list-remote-agents-toggle"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapsing hides the agent children and the agent filter", () => {
    render();
    clickRemoteAgentsToggle();

    expect(container.querySelector('[data-testid="agent-node-agent-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-filter-input"]')).toBeNull();
    const toggle = container.querySelector('[data-testid="connection-list-remote-agents-toggle"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapsing removes the wrapper's flex-grow so it no longer squats on the column", () => {
    render();

    // While expanded the Remote Agents wrapper participates in the flex layout.
    const wrapper = container.querySelector<HTMLElement>(".connection-list__remote-agents");
    expect(wrapper).toBeTruthy();
    expect(wrapper?.style.flex).not.toBe("");

    clickRemoteAgentsToggle();

    // Collapsed: no inline flex value, so it shrinks to just the header and the
    // Connections group reclaims the freed space.
    const collapsedWrapper = container.querySelector<HTMLElement>(
      ".connection-list__remote-agents"
    );
    expect(collapsedWrapper?.style.flex).toBe("");
  });
});
