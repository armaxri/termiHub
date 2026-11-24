/**
 * Remote agents section (#5851):
 *  - R-081: after the editor creates or saves an agent, the section expands
 *    (even if the user collapsed it) and the agent's row scrolls into view.
 *  - An expanded section with no agents names its action: "No remote agents
 *    yet. New remote agent".
 */
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { requestRemoteAgentReveal } from "./remoteAgentReveal";
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

async function render() {
  await act(async () => {
    root.render(
      React.createElement(TooltipProvider, {
        delayDuration: 0,
        children: React.createElement(ConnectionList),
      })
    );
  });
  await flushAsync();
}

setupSettingsRegion();
setupAgentsRegion();

const toggle = () =>
  container.querySelector<HTMLButtonElement>(
    '[data-testid="connection-list-remote-agents-toggle"]'
  );

describe("ConnectionList – reveal an agent after the editor saves it (R-081, #5851)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({ ...baseSettings });
    seedAgentsRegion({ remoteAgents: [makeAgent()] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("expands a collapsed section and scrolls the new agent into view", async () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute("data-testid") ?? "");
    };
    try {
      await render();
      act(() => toggle()!.click());
      expect(toggle()?.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        seedAgentsRegion({ remoteAgents: [makeAgent(), makeAgent({ id: "agent-2" })] });
        requestRemoteAgentReveal("agent-2");
      });
      await flushAsync();

      expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelector('[data-testid="agent-node-agent-2"]')).toBeTruthy();
      expect(scrolled).toEqual(["agent-node-agent-2"]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("waits for the agent's row when the request arrives first", async () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute("data-testid") ?? "");
    };
    try {
      await render();
      await act(async () => requestRemoteAgentReveal("agent-3"));
      expect(scrolled).toEqual([]);
      await act(async () =>
        seedAgentsRegion({ remoteAgents: [makeAgent(), makeAgent({ id: "agent-3" })] })
      );
      await flushAsync();
      expect(scrolled).toEqual(["agent-node-agent-3"]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe("ConnectionList – empty Remote agents names its action (#5851)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({ ...baseSettings });
    seedAgentsRegion({ remoteAgents: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers New remote agent as a link once the empty section is expanded", async () => {
    const openEditor = vi.fn();
    useAppStore.setState({ openConnectionEditorTab: openEditor });
    await render();
    act(() => toggle()!.click());

    const empty = container.querySelector('[data-testid="remote-agents-none"]');
    expect(empty?.textContent).toBe("No remote agents yet. New remote agent");
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="remote-agents-none-new-agent"]')!
        .click()
    );
    expect(openEditor).toHaveBeenCalledWith("new-remote-agent");
  });
});
