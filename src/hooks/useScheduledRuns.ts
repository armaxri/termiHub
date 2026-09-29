import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  ackScheduleRun,
  onScheduleFire,
  onSchedulesChanged,
  registerScheduleWindow,
  reportScheduleRun,
  scheduleRunCoverage,
} from "@/services/scheduleApi";
import { useAppStore } from "@/store/appStore";
import { awaitRunCoverage } from "@/store/scheduledConnect";
import { claimedTargetIds, executeScheduledRun } from "@/store/scheduledRuns";
import { connectSavedConnection } from "@/utils/connectSavedConnection";
import type { SavedConnection } from "@/types/connection";
import type { ScheduleFire } from "@/types/schedule";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

/**
 * This window's label, or `null` outside Tauri (tests, a browser build) —
 * compared with a fire's `connectWindow` (#3527).
 */
function currentWindowLabel(): string | null {
  try {
    return getCurrentWindow().label;
  } catch {
    return null;
  }
}

/** Connect a schedule's target without prompting (#3527). */
function connectUnattended(connection: SavedConnection) {
  return connectSavedConnection(connection, { unattended: true });
}

/** Execute one fired schedule in this window and report the outcome. */
export async function handleScheduleFire(fire: ScheduleFire): Promise<void> {
  frontendLog("schedules", `schedule ${fire.scheduleId} fired (run ${fire.token})`);
  // Acknowledge first, so the scheduler waits for this window's report — with
  // the targets this window runs on itself, so the connect window leaves them
  // alone (#3878).
  try {
    await ackScheduleRun(fire.token, claimedTargetIds(fire, useAppStore.getState()));
  } catch (err) {
    frontendLog("schedules", `Failed to acknowledge scheduled run: ${errorMessage(err)}`);
  }
  // Only the window the backend named connects missing targets (#3527).
  const isConnectWindow =
    fire.connectWindow !== undefined && fire.connectWindow === currentWindowLabel();
  const report = await executeScheduledRun(
    fire,
    { getState: useAppStore.getState, setState: useAppStore.setState },
    {
      connectMissing: isConnectWindow ? connectUnattended : undefined,
      connectedElsewhere: isConnectWindow
        ? () => awaitRunCoverage(() => scheduleRunCoverage(fire.token))
        : undefined,
    }
  );
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
      .then((off) => {
        keep(off);
        // Only now can this window receive runs: register it with the scheduler.
        if (!disposed) return registerScheduleWindow();
      })
      .catch((err) =>
        frontendLog("schedules", `schedule-fire listen failed: ${errorMessage(err)}`)
      );
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
