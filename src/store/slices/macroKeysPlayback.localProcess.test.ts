import { describe, expect, it, vi } from "vitest";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { Macro } from "@/types/macro";

const invokeRunLocalProcess = vi.hoisted(() => vi.fn());
vi.mock("@/services/localProcessApi", () => ({
  invokeRunLocalProcess,
  cancelLocalProcess: vi.fn(),
  subscribeLocalProcessOutput: vi.fn(),
}));

import type { AppState } from "../appStore";
import { playAutomationKeys, playAutomationKeysOnTargets } from "./macroKeysPlayback";

const macro: Macro = { id: "m", name: "m", tags: [], steps: [], createdAt: "", updatedAt: "" };
const lp: AutomationStep = { kind: "run-local-process", program: "make", args: [] };
const automation = (id: string, steps: AutomationStep[]): Automation => ({
  id,
  name: id,
  tags: [],
  steps,
  triggers: [],
  createdAt: "",
  updatedAt: "",
});

/**
 * Macro playback has no spawn seam, so the step fails closed there whatever the
 * settings say (#5988), also on several terminals (#5818, slice 5).
 */
describe.each<[string, Automation[]]>([
  ["direct", [automation("m", [lp])]],
  [
    "through run-automation",
    [automation("m", [{ kind: "run-automation", automationId: "b" }]), automation("b", [lp])],
  ],
])("macro playback of a local-process automation: %s", (_name, automations) => {
  const state = { automations, macros: [], workflows: [] } as unknown as AppState;

  it("fails on every terminal and spawns nothing", async () => {
    const inject = vi.fn(() => true);
    const outcomes = await playAutomationKeysOnTargets(state, macro, ["a", "b"], inject, {}).done;
    expect(outcomes.map((o) => [o.tabId, o.status])).toEqual([
      ["a", "error"],
      ["b", "error"],
    ]);
    expect(inject).not.toHaveBeenCalled();
    expect(invokeRunLocalProcess).not.toHaveBeenCalled();
  });

  it("fails on one terminal and spawns nothing", async () => {
    const result = await playAutomationKeys(state, macro, () => true, {}).done;
    expect(result.status).toBe("error");
    expect(invokeRunLocalProcess).not.toHaveBeenCalled();
  });
});
