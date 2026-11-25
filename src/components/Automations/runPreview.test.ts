import { describe, expect, it } from "vitest";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import { RUN_PREVIEW_STEPS, runPreview, stepCountText } from "./runPreview";

const command = (text: string): AutomationStep => ({ kind: "send-command", command: text });

describe("runPreview (A-035)", () => {
  it("says what each step does", () => {
    expect(
      runPreview({ steps: [command("make"), { kind: "run-automation", automationId: "b" }] }, [
        { id: "b", name: "Backup" },
      ])
    ).toEqual(["Run command: make", expect.stringContaining("Backup")]);
  });

  it("counts the steps it leaves out", () => {
    const steps = Array.from({ length: RUN_PREVIEW_STEPS + 1 }, (_, i) => command(`c${i}`));
    const lines = runPreview({ steps }, []);
    expect(lines).toHaveLength(RUN_PREVIEW_STEPS + 1);
    expect(lines[RUN_PREVIEW_STEPS]).toBe("and 1 step more");
    expect(runPreview({ steps: steps.slice(1) }, [])).toHaveLength(RUN_PREVIEW_STEPS);
    expect(stepCountText(2)).toBe("2 steps");
  });
});
