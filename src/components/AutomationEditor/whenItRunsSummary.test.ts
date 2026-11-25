import { describe, expect, it } from "vitest";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import { whenItRunsSummary } from "./WhenItRuns";

const hotkey: AutomationTrigger = { kind: "hotkey", binding: "Ctrl+Alt+R" };
const output: AutomationTrigger = { kind: "on-output-match", connectionIds: ["c"], pattern: "x" };

describe("the closed When it runs section (B-019)", () => {
  const summary = (over: Partial<Parameters<typeof whenItRunsSummary>[0]> = {}) =>
    whenItRunsSummary({
      triggers: [],
      triggersEnabled: true,
      schedules: [],
      connectionName: () => "Build Box",
      ...over,
    });

  it("names the keys and the connections", () => {
    expect(summary()).toBe("Only when you run it");
    expect(summary({ triggers: [hotkey, output] })).toBe(
      "Hotkey Ctrl+Alt+R, matching output in Build Box"
    );
    // One without keys is still a trigger.
    expect(summary({ triggers: [{ kind: "hotkey", binding: "" }] })).toBe("Hotkey");
  });

  it("says what is off", () => {
    expect(summary({ triggers: [hotkey], triggersEnabled: false })).toBe(
      "Triggers off (hotkey Ctrl+Alt+R)"
    );
    expect(summary({ schedules: [{ enabled: false }] })).toBe("1 schedule (off)");
    expect(summary({ schedules: [{ enabled: true }, { enabled: false }] })).toBe(
      "2 schedules (1 on)"
    );
    expect(summary({ triggers: [hotkey], schedules: [{ enabled: true }] })).toBe(
      "Hotkey Ctrl+Alt+R, 1 schedule"
    );
  });
});
