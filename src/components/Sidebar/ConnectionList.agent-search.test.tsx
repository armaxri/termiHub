/**
 * Regression tests for #2485: the Remote Agents sidebar search must match an
 * agent by its own name/label — not only by its saved-connection definitions.
 *
 * Searching a case-insensitive substring of an agent's label (e.g. `dev0`
 * matching "Dev Agent (dev0)") must surface that agent with its full tree, and
 * hide agents that match neither by name nor by a child connection. Previously
 * `agentFilterQuery` was threaded only *into* each `AgentNode` to filter its
 * contents; it never narrowed *which* agents rendered, so an agent whose name
 * matched (but with no matching child connection) was never isolated.
 */
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { TooltipProvider } from "@/components/ui";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { AgentDefinitionInfo } from "@/services/api";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

// Mock AgentNode to a leaf div that records the filterQuery it received, so the
// test can assert both which agents render and whether an agent surfaced by a
// name match is shown with its full (unfiltered) tree.
vi.mock("./AgentNode", () => ({
  AgentNode: ({
    agent,
    filterQuery,
    sectionRef,
  }: {
    agent: RemoteAgentDefinition;
    filterQuery?: string;
    sectionRef?: (el: HTMLDivElement | null) => void;
  }) =>
    React.createElement("div", {
      ref: sectionRef,
      "data-testid": `agent-node-${agent.id}`,
      "data-filter-query": filterQuery ?? "",
    }),
}));

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: "agent-1",
    name: "Test Agent",
    config: { host: "10.0.0.1", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

function makeDef(overrides: Partial<AgentDefinitionInfo> = {}): AgentDefinitionInfo {
  return {
    id: "def-1",
    name: "a connection",
    sessionType: "shell",
    config: {},
    persistent: false,
    folderId: null,
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

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function agentFilterInput(): HTMLInputElement {
  return container.querySelector('[data-testid="agent-filter-input"]') as HTMLInputElement;
}

setupSettingsRegion();
setupAgentsRegion();

describe("ConnectionList — Remote Agents search by agent name (#2485)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({ ...baseSettings });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("surfaces an agent whose label matches the query and hides the rest", () => {
    seedAgentsRegion({
      remoteAgents: [
        makeAgent({ id: "agent-dev0", name: "Dev Agent (dev0)" }),
        makeAgent({ id: "agent-prod", name: "Prod Agent" }),
      ],
    });
    render();

    typeInto(agentFilterInput(), "dev0");

    expect(container.querySelector('[data-testid="agent-node-agent-dev0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-node-agent-prod"]')).toBeNull();
  });

  it("matches the agent label case-insensitively", () => {
    seedAgentsRegion({
      remoteAgents: [
        makeAgent({ id: "agent-dev0", name: "Dev Agent (dev0)" }),
        makeAgent({ id: "agent-prod", name: "Prod Agent" }),
      ],
    });
    render();

    typeInto(agentFilterInput(), "DEV0");

    expect(container.querySelector('[data-testid="agent-node-agent-dev0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-node-agent-prod"]')).toBeNull();
  });

  it("shows the full tree (no content filter) for an agent surfaced by a name match", () => {
    seedAgentsRegion({
      remoteAgents: [makeAgent({ id: "agent-dev0", name: "Dev Agent (dev0)" })],
    });
    render();

    typeInto(agentFilterInput(), "dev0");

    const node = container.querySelector('[data-testid="agent-node-agent-dev0"]');
    // A name-matched agent is shown whole: the content filter is not applied.
    expect(node?.getAttribute("data-filter-query")).toBe("");
  });

  it("still surfaces an agent by a matching child connection (definition) name", () => {
    seedAgentsRegion({
      remoteAgents: [
        makeAgent({ id: "agent-a", name: "Alpha" }),
        makeAgent({ id: "agent-b", name: "Beta" }),
      ],
      agentDefinitions: {
        "agent-a": [makeDef({ id: "def-a", name: "dev0-database" })],
        "agent-b": [makeDef({ id: "def-b", name: "unrelated" })],
      },
    });
    render();

    typeInto(agentFilterInput(), "dev0");

    // agent-a has a matching definition → shown, and its content filter is active.
    const nodeA = container.querySelector('[data-testid="agent-node-agent-a"]');
    expect(nodeA).not.toBeNull();
    expect(nodeA?.getAttribute("data-filter-query")).toBe("dev0");
    // agent-b matches neither by name nor by any definition → hidden.
    expect(container.querySelector('[data-testid="agent-node-agent-b"]')).toBeNull();
  });

  it("shows an empty state when no agent matches the query", () => {
    seedAgentsRegion({
      remoteAgents: [
        makeAgent({ id: "agent-dev0", name: "Dev Agent (dev0)" }),
        makeAgent({ id: "agent-prod", name: "Prod Agent" }),
      ],
    });
    render();

    typeInto(agentFilterInput(), "zzz-nothing");

    expect(container.querySelector('[data-testid="agent-node-agent-dev0"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-node-agent-prod"]')).toBeNull();
    expect(container.querySelector('[data-testid="remote-agents-empty"]')).not.toBeNull();
  });

  it("renders all agents when the query is empty", () => {
    seedAgentsRegion({
      remoteAgents: [
        makeAgent({ id: "agent-dev0", name: "Dev Agent (dev0)" }),
        makeAgent({ id: "agent-prod", name: "Prod Agent" }),
      ],
    });
    render();

    expect(container.querySelector('[data-testid="agent-node-agent-dev0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-node-agent-prod"]')).not.toBeNull();
  });
});
