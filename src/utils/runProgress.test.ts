import { describe, expect, it } from "vitest";
import { currentStep, stepProgress, typedPercent, typedProgress } from "./runProgress";

describe("how far a run is (B-002)", () => {
  it("says the step it is at, not how many are done", () => {
    expect(stepProgress(0, 3)).toBe("Step 1 of 3");
    expect(stepProgress(2, 3)).toBe("Step 3 of 3");
    // While it finishes there is no fourth step.
    expect(stepProgress(3, 3)).toBe("Step 3 of 3");
    expect(currentStep(0, 0)).toBe(1);
  });

  it("says the share of the keys", () => {
    expect(typedProgress(1, 3)).toBe("33 % typed");
    expect(typedPercent(0, 0)).toBe(0);
  });
});
