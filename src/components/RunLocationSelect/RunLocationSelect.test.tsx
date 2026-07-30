import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { RemoteAgentDefinition } from "@/types/connection";
import { THIS_COMPUTER } from "@/types/tunnel";
import { RunLocationSelect } from "./RunLocationSelect";

function agent(id: string, name: string): RemoteAgentDefinition {
  return {
    id,
    name,
    config: {} as RemoteAgentDefinition["config"],
    agentSettings: {} as RemoteAgentDefinition["agentSettings"],
    isExpanded: false,
    connectionState: "connected",
  };
}

const AGENTS = [agent("a1", "build-server")];

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}

describe("RunLocationSelect", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows This computer as the selected vantage by default", () => {
    render(
      <RunLocationSelect
        value={THIS_COMPUTER}
        agents={AGENTS}
        onChange={() => {}}
        data-testid="rl"
      />
    );
    const trigger = document.querySelector('[data-testid="rl"]') as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain("This computer");
    // With an agent on offer the control is interactive.
    expect(trigger.hasAttribute("disabled")).toBe(false);
  });

  it("names the agent when the item runs on one", () => {
    render(
      <RunLocationSelect
        value={{ kind: "agent", agentId: "a1" }}
        agents={AGENTS}
        onChange={() => {}}
        data-testid="rl"
      />
    );
    const trigger = document.querySelector('[data-testid="rl"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain("build-server");
  });

  it("disables the control for a desktop-only item (no agent option)", () => {
    render(
      <RunLocationSelect
        value={THIS_COMPUTER}
        agents={AGENTS}
        agentAllowed={false}
        onChange={() => {}}
        data-testid="rl"
      />
    );
    const trigger = document.querySelector('[data-testid="rl"]') as HTMLButtonElement;
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.textContent).toContain("This computer");
  });

  it("disables the control when there is no agent to offer", () => {
    render(
      <RunLocationSelect value={THIS_COMPUTER} agents={[]} onChange={() => {}} data-testid="rl" />
    );
    const trigger = document.querySelector('[data-testid="rl"]') as HTMLButtonElement;
    expect(trigger.hasAttribute("disabled")).toBe(true);
  });
});
