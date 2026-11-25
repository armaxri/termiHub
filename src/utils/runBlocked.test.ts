import { describe, expect, it } from "vitest";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import { runBlockedReason } from "./runBlocked";

const automation = (id: string, steps: AutomationStep[]): Automation => ({
  id,
  name: `Automation ${id}`,
  tags: [],
  steps,
  triggers: [],
  createdAt: "",
  updatedAt: "",
});
const program: AutomationStep = { kind: "run-local-process", program: "make", args: [] };
const future = { kind: "future-step" } as unknown as AutomationStep;
const calls = (automationId: string): AutomationStep => ({ kind: "run-automation", automationId });

describe("runBlockedReason (A-016)", () => {
  const reason = (steps: AutomationStep[], experimental = true, others: Automation[] = []) =>
    runBlockedReason(
      automation("a", steps),
      (id) => others.find((other) => other.id === id),
      experimental
    );

  it("is null for what can run", () => {
    expect(reason([{ kind: "wait", delayMs: 1 }])).toBeNull();
    expect(reason([{ kind: "wait", delayMs: 1 }], false)).toBeNull();
    expect(reason([program])).toBeNull();
    expect(reason([calls("gone")])).toBeNull();
  });

  it("says which switch a local program needs, also through a call", () => {
    expect(reason([program], false)).toContain("Allow experimental features");
    expect(reason([calls("b")], false, [automation("b", [program])])).toContain(
      "Allow experimental features"
    );
  });

  it("names the step of a newer version, also through a call, before anything else", () => {
    expect(reason([program, future], false)).toMatch(/^Step 2 \(future-step\)/);
    expect(reason([calls("b")], true, [automation("b", [future])])).toContain("“Automation b”");
  });
});
