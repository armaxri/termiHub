import { describe, expect, it } from "vitest";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import {
  LOCAL_PROCESS_REASON,
  LOCAL_PROGRAMS_OFF_REASON,
  localProcessBlockedReason,
} from "./localProcessGate";

const lp: AutomationStep = { kind: "run-local-process", program: "make", args: [] };
const call = (automationId: string): AutomationStep => ({ kind: "run-automation", automationId });
const automation = (id: string, steps: AutomationStep[]): Automation => ({
  id,
  name: id,
  tags: [],
  steps,
  triggers: [],
  createdAt: "",
  updatedAt: "",
});
const reason = (library: Automation[], experimental = false) =>
  localProcessBlockedReason(library[0], (id) => library.find((a) => a.id === id), experimental);

describe("localProcessBlockedReason", () => {
  it("blocks the step unless experimental features are on", () => {
    expect(reason([automation("a", [lp])])).toBe(LOCAL_PROCESS_REASON);
    expect(reason([automation("a", [lp])], true)).toBeNull();
    expect(reason([automation("a", [{ kind: "wait", delayMs: 1 }])])).toBeNull();
  });

  it("ends on a cycle, with and without the step behind it", () => {
    expect(reason([automation("a", [call("b")]), automation("b", [call("a")])])).toBeNull();
    expect(reason([automation("a", [call("b")]), automation("b", [call("a"), lp])])).not.toBeNull();
  });

  it("skips a missing automation and still checks the others", () => {
    expect(
      reason([automation("a", [call("gone"), call("b")]), automation("b", [lp])])
    ).not.toBeNull();
    expect(reason([automation("a", [call("gone")])])).toBeNull();
  });
});

describe("the Security switch for local programs (#6178)", () => {
  const blocked = (gate: { experimental: boolean; localPrograms: boolean }) =>
    localProcessBlockedReason(automation("a", [lp]), () => undefined, gate);

  it("blocks it while the Security switch is off, and names that switch", () => {
    expect(blocked({ experimental: true, localPrograms: false })).toBe(LOCAL_PROGRAMS_OFF_REASON);
    expect(LOCAL_PROGRAMS_OFF_REASON).toContain(
      "Settings ▸ Security ▸ Allow automations to run local programs"
    );
  });

  it("names the experimental switch first, and lets it run with both on", () => {
    expect(blocked({ experimental: false, localPrograms: false })).toBe(LOCAL_PROCESS_REASON);
    expect(blocked({ experimental: true, localPrograms: true })).toBeNull();
  });
});
