/**
 * Regression tests for #2116: the Remote Agents list must scroll with agents
 * EXPANDED, not just collapsed.
 *
 * #2106 wrapped the list in `.connection-list__agents-scroll` and was verified
 * only with collapsed rows. Expanding an agent then broke: each expanded agent
 * was handed an inline `flex` value that split the scroll container's FIXED
 * height between the expanded agents, so the list could never overflow (no
 * top-level scroll) and every expanded agent's tree was squeezed into a tiny
 * clipped slice. The fix drops the inner flex distribution (and the inner
 * resize handles that depended on it): every agent now renders at its natural
 * content height inside the single scroll container.
 *
 * jsdom does not lay out, so these tests lock the structural invariants that
 * make scrolling with expanded agents possible; the pixel-level overflow is
 * verified separately with the real CSS in headless Chrome (see the PR).
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

/** Records every `style` prop the real ConnectionList hands each AgentNode. */
const receivedStyles: Record<string, React.CSSProperties | undefined> = {};

// A stand-in AgentNode that renders a tall block of rows when the agent is
// expanded, so the DOM mirrors a real expanded agent (many child rows) without
// pulling in the full AgentNode store wiring. It also captures the `style` prop
// so the test can assert no inline flex distribution is applied.
vi.mock("./AgentNode", () => ({
  AgentNode: ({ agent, style }: { agent: RemoteAgentDefinition; style?: React.CSSProperties }) => {
    receivedStyles[agent.id] = style;
    return React.createElement(
      "div",
      {
        "data-testid": `agent-node-${agent.id}`,
        className: "connection-list__group connection-list__group--expanded",
        style,
      },
      agent.isExpanded
        ? Array.from({ length: 12 }, (_, r) =>
            React.createElement("div", {
              key: r,
              "data-testid": `agent-${agent.id}-row-${r}`,
              className: "connection-tree__item",
            })
          )
        : null
    );
  },
}));

function makeAgent(i: number, expanded: boolean): RemoteAgentDefinition {
  return {
    id: `agent-${i}`,
    name: `Agent ${i}`,
    config: {
      host: `10.0.0.${i}`,
      port: 22,
      username: "user",
      authMethod: "password",
    },
    connectionState: "connected",
    isExpanded: expanded,
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

describe("ConnectionList – Remote Agents scroll with EXPANDED agents (#2116)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const k of Object.keys(receivedStyles)) delete receivedStyles[k];
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ settings: { ...baseSettings } });
    // 15 agents, several expanded — the scenario #2106 never tested.
    useAppStore.setState({
      remoteAgents: Array.from({ length: 15 }, (_, i) => makeAgent(i, i % 3 === 0)),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders every agent — expanded and collapsed — inside the single scroll container", () => {
    render();
    const scroll = container.querySelector('[data-testid="remote-agents-scroll"]');
    expect(scroll).toBeTruthy();

    for (let i = 0; i < 15; i++) {
      const node = container.querySelector(`[data-testid="agent-node-agent-${i}"]`);
      expect(node, `agent-${i} should render`).toBeTruthy();
      expect(scroll?.contains(node)).toBe(true);
    }
  });

  it("keeps every expanded agent's child rows inside the scroll container (reachable by scrolling)", () => {
    render();
    const scroll = container.querySelector('[data-testid="remote-agents-scroll"]');
    for (let i = 0; i < 15; i += 3) {
      // Last row of each expanded agent must live inside the scroll region so it
      // is reachable — not clipped by a fixed-height inner slice.
      const lastRow = container.querySelector(`[data-testid="agent-agent-${i}-row-11"]`);
      expect(lastRow, `expanded agent-${i} last row should render`).toBeTruthy();
      expect(scroll?.contains(lastRow)).toBe(true);
    }
  });

  it("does NOT hand expanded agents an inline flex value (no fixed-height distribution)", () => {
    render();
    // The bug: expanded agents got `style={{ flex: <n> }}`, which split the
    // container's fixed height and defeated scrolling. They must now size to
    // content instead.
    for (let i = 0; i < 15; i++) {
      const style = receivedStyles[`agent-${i}`];
      expect(style?.flex, `agent-${i} must not receive an inline flex`).toBeUndefined();
    }
  });

  it("renders no inner resize separators between agents", () => {
    render();
    expect(container.querySelector('[data-testid^="sidebar-group-separator-"]')).toBeNull();
  });
});
