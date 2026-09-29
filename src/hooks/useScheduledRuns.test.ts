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
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

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
    expect(mocks.executeScheduledRun).toHaveBeenCalledWith(fire, expect.any(Object), {
      connectMissing: undefined,
    });
    expect(mocks.reportScheduleRun).toHaveBeenCalledWith("tok", report);
  });

  it("connects missing targets only in the window the fire names (#3527)", async () => {
    mocks.executeScheduledRun.mockResolvedValue({ outcome: "completed", targetsRun: 1 });
    mocks.reportScheduleRun.mockResolvedValue(undefined);

    await handleScheduleFire({ ...fire, connectWindow: "main" });
    expect(mocks.executeScheduledRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectWindow: "main" }),
      expect.any(Object),
      { connectMissing: expect.any(Function) }
    );

    await handleScheduleFire({ ...fire, connectWindow: "aux-1" });
    expect(mocks.executeScheduledRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectWindow: "aux-1" }),
      expect.any(Object),
      { connectMissing: undefined }
    );
  });

  it("swallows a failed report (logged, never thrown)", async () => {
    mocks.executeScheduledRun.mockResolvedValue({ outcome: "skipped", targetsRun: 0 });
    mocks.reportScheduleRun.mockRejectedValue(new Error("gone"));
    await expect(handleScheduleFire(fire)).resolves.toBeUndefined();
  });
});
