import { describe, expect, it } from "vitest";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import { parameterUse } from "./parameterUses";

const command = (text: string): AutomationStep => ({ kind: "send-command", command: text });

describe("parameterUse (B-006)", () => {
  it("says which step uses the value, and how", () => {
    expect(parameterUse("env", [command("ls"), command("deploy ${env}")])).toBe(
      "Used in step 2 (Run command: deploy ${env})"
    );
  });

  it("finds it inside a branch, and lists several steps", () => {
    const branch: AutomationStep = {
      kind: "conditional",
      condition: { left: "x", op: "eq", right: "y" },
      then: [command("echo ${env}")],
    };
    expect(parameterUse("env", [branch, command("a"), command("${env}")])).toBe(
      "Used in steps 1 and 3"
    );
  });

  it("says nothing when no step does", () => {
    expect(parameterUse("env", [command("${environment}")])).toBe("");
  });
});
