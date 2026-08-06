/**
 * Regression tests for the resize handle --resizable class.
 *
 * There is a single resize handle level left:
 * - Outer (sidebar-outer-separator): between Connections and the entire Remote Agents section.
 *   Resizable whenever connections is expanded and experimental features are enabled.
 *
 * The former inner handles between individual agents were removed with #2116:
 * the agent list now scrolls, with every agent at its natural content height,
 * so there is no fixed height for a splitter to apportion between them.
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

setupSettingsRegionMirror();

describe("ConnectionList – outer resize handle (connections vs remote agents)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ settings: { ...baseSettings } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("outer separator is present when experimental features are enabled", () => {
    useAppStore.setState({ remoteAgents: [makeAgent()] });

    act(() => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      );
    });

    expect(container.querySelector('[data-testid="sidebar-outer-separator"]')).toBeTruthy();
  });

  it("outer separator has --resizable class when connections is expanded", () => {
    useAppStore.setState({ remoteAgents: [makeAgent()] });

    act(() => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      );
    });

    const sep = container.querySelector('[data-testid="sidebar-outer-separator"]');
    expect(sep?.classList.contains("connection-list__resize-handle--resizable")).toBe(true);
  });

  it("outer separator is resizable regardless of whether the agent is expanded", () => {
    useAppStore.setState({ remoteAgents: [makeAgent({ isExpanded: false })] });

    act(() => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      );
    });

    const sep = container.querySelector('[data-testid="sidebar-outer-separator"]');
    expect(sep?.classList.contains("connection-list__resize-handle--resizable")).toBe(true);
  });
});

describe("ConnectionList – no inner resize handles between agents (#2116)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ settings: { ...baseSettings } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders no inner separator even between two expanded agents (scroll model)", () => {
    useAppStore.setState({
      remoteAgents: [
        makeAgent({ id: "a1", isExpanded: true }),
        makeAgent({ id: "a2", isExpanded: true }),
      ],
    });

    act(() => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      );
    });

    expect(container.querySelector('[data-testid="sidebar-group-separator-0"]')).toBeNull();
  });
});
