import { useEffect } from "react";

import { onScheduleFire, onSchedulesChanged, reportScheduleRun } from "@/services/scheduleApi";
import { useAppStore } from "@/store/appStore";
import { executeScheduledRun } from "@/store/scheduledRuns";
import type { ScheduleFire } from "@/types/schedule";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

/** Execute one fired schedule in this window and report the outcome. */
export async function handleScheduleFire(fire: ScheduleFire): Promise<void> {
  frontendLog("schedules", `schedule ${fire.scheduleId} fired (run ${fire.token})`);
  const report = await executeScheduledRun(fire, {
    getState: useAppStore.getState,
    setState: useAppStore.setState,
  });
  frontendLog(
    "schedules",
    `schedule ${fire.scheduleId} ${report.outcome}${report.message ? `: ${report.message}` : ""}`
  );
  try {
    await reportScheduleRun(fire.token, report);
  } catch (err) {
    frontendLog("schedules", `Failed to report scheduled run: ${errorMessage(err)}`);
  }
}

/**
 * Wire this window into the backend scheduler (PROD-043): run fired schedules
 * on this window's connected targets and keep the schedule list current.
 */
export function useScheduledRuns(): void {
  const loadSchedules = useAppStore((s) => s.loadSchedules);

  useEffect(() => {
    const offs: (() => void)[] = [];
    let disposed = false;
    const keep = (off: () => void) => {
      if (disposed) off();
      else offs.push(off);
    };

    void onScheduleFire((fire) => void handleScheduleFire(fire))
      .then(keep)
      .catch((err) => frontendLog("schedules", `schedule-fire listen failed: ${errorMessage(err)}`));
    void onSchedulesChanged(() => void loadSchedules())
      .then(keep)
      .catch((err) =>
        frontendLog("schedules", `schedules-changed listen failed: ${errorMessage(err)}`)
      );

    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, [loadSchedules]);
}
