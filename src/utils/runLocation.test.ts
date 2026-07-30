import { describe, it, expect } from "vitest";
import type { RemoteAgentDefinition } from "@/types/connection";
import { THIS_COMPUTER } from "@/types/tunnel";
import {
  RUN_LOCATION_THIS,
  decodeRunLocation,
  encodeRunLocation,
  runLocationLabel,
  runLocationOptions,
} from "./runLocation";

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

const AGENTS = [agent("a1", "build-server"), agent("a2", "lab-box")];

describe("runLocation helpers", () => {
  it("encodes This computer and an agent as distinct Select values", () => {
    expect(encodeRunLocation(THIS_COMPUTER)).toBe(RUN_LOCATION_THIS);
    expect(encodeRunLocation({ kind: "agent", agentId: "a1" })).toBe("agent:a1");
  });

  it("round-trips through encode/decode", () => {
    expect(decodeRunLocation(encodeRunLocation(THIS_COMPUTER))).toEqual(THIS_COMPUTER);
    const loc = { kind: "agent", agentId: "a1" } as const;
    expect(decodeRunLocation(encodeRunLocation(loc))).toEqual(loc);
  });

  it("decodes an unknown value as This computer", () => {
    expect(decodeRunLocation("nonsense")).toEqual(THIS_COMPUTER);
  });

  it("offers This computer plus every agent when agents are allowed", () => {
    const options = runLocationOptions(AGENTS, true);
    expect(options).toEqual([
      { value: RUN_LOCATION_THIS, label: "This computer" },
      { value: "agent:a1", label: "Agent · build-server" },
      { value: "agent:a2", label: "Agent · lab-box" },
    ]);
  });

  it("offers only This computer for a desktop-only item", () => {
    const options = runLocationOptions(AGENTS, false);
    expect(options).toEqual([{ value: RUN_LOCATION_THIS, label: "This computer" }]);
  });

  it("labels a run-location, naming a known agent and falling back to its id", () => {
    expect(runLocationLabel(THIS_COMPUTER, AGENTS)).toBe("This computer");
    expect(runLocationLabel({ kind: "agent", agentId: "a1" }, AGENTS)).toBe("Agent · build-server");
    expect(runLocationLabel({ kind: "agent", agentId: "gone" }, AGENTS)).toBe("Agent · gone");
  });
});
