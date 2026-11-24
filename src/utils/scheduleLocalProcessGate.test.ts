import { describe, expect, it } from "vitest";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import { SCHEDULE_LOCAL_PROCESS_REASON, scheduleBlockedReason } from "./scheduleLocalProcessGate";

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
  scheduleBlockedReason(library[0], (id) => library.find((a) => a.id === id), experimental);

describe("scheduleBlockedReason", () => {
  it("blocks the step unless experimental features are on", () => {
    expect(reason([automation("a", [lp])])).toBe(SCHEDULE_LOCAL_PROCESS_REASON);
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
