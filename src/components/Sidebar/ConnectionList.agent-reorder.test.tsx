/**
 * ConnectionList wiring for the keyboard / menu agent reorder (#4641): each
 * AgentNode gets `canMoveBy` / `onMoveBy`, which compute the same
 * `reorderRemoteAgents(oldIndex, newIndex)` call the drag path makes, swapping
 * with the neighbour the user can see when the agent search hides some agents.
 */
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import React, { act } from "react";
import { flushAsync } from "@/test/flushAsync";
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

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

// A stand-in AgentNode exposing the reorder props as buttons, so the test can
// drive them and read the enabled state ConnectionList computed.
vi.mock("./AgentNode", () => ({
  AgentNode: ({
    agent,
    canMoveBy,
    onMoveBy,
  }: {
    agent: RemoteAgentDefinition;
    canMoveBy?: (id: string, delta: -1 | 1) => boolean;
    onMoveBy?: (id: string, delta: -1 | 1) => void;
  }) =>
    React.createElement(
      "div",
      { "data-testid": `agent-node-${agent.id}` },
      React.createElement("button", {
        "data-testid": `up-${agent.id}`,
        disabled: !canMoveBy?.(agent.id, -1),
        onClick: () => onMoveBy?.(agent.id, -1),
      }),
      React.createElement("button", {
        "data-testid": `down-${agent.id}`,
        disabled: !canMoveBy?.(agent.id, 1),
        onClick: () => onMoveBy?.(agent.id, 1),
      })
    ),
}));

function makeAgent(id: string, name: string): RemoteAgentDefinition {
  return {
    id,
    name,
    config: { host: "10.0.0.1", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded: false,
    agentSettings: DEFAULT_AGENT_SETTINGS,
  };
}

const AGENTS = [
  makeAgent("a", "Alpha box"),
  makeAgent("b", "Bravo"),
  makeAgent("c", "Charlie box"),
];

setupSettingsRegion();
setupAgentsRegion();

describe("ConnectionList — reorder agents without dragging (#4641)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let reorderRemoteAgents: Mock<(oldIndex: number, newIndex: number) => void>;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: false,
      fileBrowserEnabled: false,
      experimentalFeaturesEnabled: true,
    });
    reorderRemoteAgents = vi.fn();
    useAppStore.setState({ reorderRemoteAgents });
    seedAgentsRegion({ remoteAgents: AGENTS });
    await act(async () => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      );
    });
    await flushAsync();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const button = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement;

  function click(testId: string) {
    act(() => {
      button(testId).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("moves an agent down and up through reorderRemoteAgents", () => {
    click("down-a");
    expect(reorderRemoteAgents).toHaveBeenLastCalledWith(0, 1);
    click("up-c");
    expect(reorderRemoteAgents).toHaveBeenLastCalledWith(2, 1);
  });

  it("disables moving the first agent up and the last agent down", () => {
    expect(button("up-a").disabled).toBe(true);
    expect(button("down-a").disabled).toBe(false);
    expect(button("up-c").disabled).toBe(false);
    expect(button("down-c").disabled).toBe(true);
  });

  it("swaps with the visible neighbour while the agent search hides some", () => {
    const input = container.querySelector('[data-testid="agent-filter-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(input, "box");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="agent-node-b"]')).toBeNull();
    click("up-c");
    expect(reorderRemoteAgents).toHaveBeenLastCalledWith(2, 0);
    expect(button("down-c").disabled).toBe(true);
  });
});
