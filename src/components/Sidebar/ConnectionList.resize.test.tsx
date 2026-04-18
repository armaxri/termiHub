/**
 * Regression tests for the resize handle --resizable class.
 *
 * There are two levels of resize handles:
 * - Outer (sidebar-outer-separator): between Connections and the entire Remote Agents section.
 *   Resizable whenever connections is expanded and experimental features are enabled.
 * - Inner (sidebar-group-separator-N): between individual agents inside the Remote Agents section.
 *   Resizable only when both adjacent agents are expanded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import type { RemoteAgentDefinition } from "@/types/connection";

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
      root.render(React.createElement(ConnectionList));
    });

    expect(container.querySelector('[data-testid="sidebar-outer-separator"]')).toBeTruthy();
  });

  it("outer separator has --resizable class when connections is expanded", () => {
    useAppStore.setState({ remoteAgents: [makeAgent()] });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const sep = container.querySelector('[data-testid="sidebar-outer-separator"]');
    expect(sep?.classList.contains("connection-list__resize-handle--resizable")).toBe(true);
  });

  it("outer separator is resizable regardless of whether the agent is expanded", () => {
    useAppStore.setState({ remoteAgents: [makeAgent({ isExpanded: false })] });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const sep = container.querySelector('[data-testid="sidebar-outer-separator"]');
    expect(sep?.classList.contains("connection-list__resize-handle--resizable")).toBe(true);
  });
});

describe("ConnectionList – inner resize handles (between agents)", () => {
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

  it("no inner separator when there is only one agent", () => {
    useAppStore.setState({ remoteAgents: [makeAgent({ isExpanded: true })] });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    expect(container.querySelector('[data-testid="sidebar-group-separator-0"]')).toBeNull();
  });

  it("inner separator appears between two agents", () => {
    useAppStore.setState({
      remoteAgents: [
        makeAgent({ id: "a1", isExpanded: true }),
        makeAgent({ id: "a2", isExpanded: true }),
      ],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    expect(container.querySelector('[data-testid="sidebar-group-separator-0"]')).toBeTruthy();
  });

  it("inner separator has --resizable class only when both adjacent agents are expanded", () => {
    useAppStore.setState({
      remoteAgents: [
        makeAgent({ id: "a1", isExpanded: true }),
        makeAgent({ id: "a2", isExpanded: true }),
      ],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const sep = container.querySelector('[data-testid="sidebar-group-separator-0"]');
    expect(sep?.classList.contains("connection-list__resize-handle--resizable")).toBe(true);
  });

  it("inner separator does NOT have --resizable class when the second agent is collapsed", () => {
    useAppStore.setState({
      remoteAgents: [
        makeAgent({ id: "a1", isExpanded: true }),
        makeAgent({ id: "a2", isExpanded: false }),
      ],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const sep = container.querySelector('[data-testid="sidebar-group-separator-0"]');
    expect(sep?.classList.contains("connection-list__resize-handle--resizable")).toBe(false);
  });
});
