import { describe, expect, it } from "vitest";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import { triggerBlocked, unattendedStartBlocked } from "./triggerBlocked";

const automation = (over: Partial<Automation> = {}): Automation => ({
  id: "a",
  name: "A",
  tags: [],
  steps: [{ kind: "wait", delayMs: 1 }],
  triggers: [],
  createdAt: "",
  updatedAt: "",
  ...over,
});
const waits = automation({ steps: [{ kind: "wait", delayMs: 1 }, { kind: "wait-for-user" }] });
const asks = automation({ parameters: [{ name: "env", type: "string", required: true }] });
const names = (id: string) => (id === "c" ? "prod" : undefined);
const blocked = (trigger: AutomationTrigger, of: Automation) =>
  triggerBlocked(trigger, of, () => undefined, names);
const on = (kind: "on-connect" | "on-disconnect", ...connectionIds: string[]) =>
  ({ kind, connectionIds }) as AutomationTrigger;
const output: AutomationTrigger = { kind: "on-output-match", connectionIds: ["c"], pattern: "x" };

describe("a trigger that can never start its automation (C-001)", () => {
  it("nobody is there after a disconnect or for matching output", () => {
    for (const trigger of [on("on-disconnect", "c"), output]) {
      expect(blocked(trigger, waits)).toBe("step 2 waits for you");
      expect(blocked(trigger, asks)).toContain("it asks for “env”");
      expect(blocked(trigger, automation())).toBeNull();
    }
    expect(unattendedStartBlocked(waits, () => undefined)).toBe("step 2 waits for you");
  });

  it("somebody is there for a hotkey and on connect", () => {
    expect(blocked({ kind: "hotkey", binding: "F9" }, waits)).toBeNull();
    expect(blocked(on("on-connect", "c"), waits)).toBeNull();
  });

  it("its connections must exist: all gone is none, one left is enough", () => {
    expect(blocked(on("on-connect", "gone"), automation())).toBe("its connection was deleted");
    expect(blocked(on("on-connect", "x", "y"), automation())).toBe("its connections were deleted");
    expect(blocked(on("on-connect", "gone", "c"), automation())).toBeNull();
    // One without any is not set up yet, which is said elsewhere.
    expect(blocked(on("on-connect"), automation())).toBeNull();
  });
});
