import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  ackScheduleRun: vi.fn(() => Promise.resolve()),
  reportScheduleRun: vi.fn(),
  executeScheduledRun: vi.fn(),
}));
vi.mock("@/services/scheduleApi", () => ({
  reportScheduleRun: mocks.reportScheduleRun,
  ackScheduleRun: mocks.ackScheduleRun,
  registerScheduleWindow: vi.fn(() => Promise.resolve()),
  onScheduleFire: vi.fn(() => Promise.resolve(() => {})),
  onSchedulesChanged: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/store/scheduledRuns", () => ({ executeScheduledRun: mocks.executeScheduledRun }));

import { handleScheduleFire } from "./useScheduledRuns";
import type { ScheduleFire } from "@/types/schedule";

const fire: ScheduleFire = {
  token: "tok",
  scheduleId: "s1",
  scheduleName: "Health",
  action: { kind: "workflow", workflowId: "wf" },
  targets: { kind: "connections", connectionIds: ["c"] },
  catchUp: false,
};

describe("handleScheduleFire (PROD-043)", () => {
  beforeEach(() => {
    mocks.reportScheduleRun.mockReset();
    mocks.executeScheduledRun.mockReset();
  });

  it("executes the run and reports its outcome with the fire's token", async () => {
    const report = { outcome: "completed", targetsRun: 2 };
    mocks.executeScheduledRun.mockResolvedValue(report);
    mocks.reportScheduleRun.mockResolvedValue(undefined);
    await handleScheduleFire(fire);
    expect(mocks.ackScheduleRun).toHaveBeenCalledWith("tok");
    expect(mocks.executeScheduledRun).toHaveBeenCalledWith(fire, expect.any(Object));
    expect(mocks.reportScheduleRun).toHaveBeenCalledWith("tok", report);
  });

  it("swallows a failed report (logged, never thrown)", async () => {
    mocks.executeScheduledRun.mockResolvedValue({ outcome: "skipped", targetsRun: 0 });
    mocks.reportScheduleRun.mockRejectedValue(new Error("gone"));
    await expect(handleScheduleFire(fire)).resolves.toBeUndefined();
  });
});
