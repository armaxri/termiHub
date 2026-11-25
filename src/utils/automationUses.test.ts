import { describe, expect, it } from "vitest";
import type { Automation } from "@/types/generated/Automation";
import { usedBy } from "./automationUses";

const automation = (id: string, calls?: string): Automation => ({
  id,
  name: `Automation ${id}`,
  tags: [],
  steps: calls ? [{ kind: "run-automation", automationId: calls }] : [],
  triggers: [],
  createdAt: "",
  updatedAt: "",
});
const schedule = (name: string, automationId: string) => ({
  name,
  action: { kind: "automation" as const, automationId },
});

describe("what a deletion breaks", () => {
  it("names the schedules and the automations that use it", () => {
    expect(usedBy("a", [automation("a"), automation("b", "a")], [schedule("Nightly", "a")])).toBe(
      "It is used by schedule “Nightly” and automation “Automation b”."
    );
  });

  it("says nothing when nothing does, or only itself", () => {
    expect(usedBy("a", [automation("a", "a")], [schedule("Nightly", "b")])).toBe("");
  });
});
