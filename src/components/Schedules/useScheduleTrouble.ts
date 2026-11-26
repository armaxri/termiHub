import { useAppStore } from "@/store/appStore";
import type { ScheduleView } from "@/types/schedule";
import { concernText, lastRunAttention } from "./scheduleStatus";
import { useScheduleLabels } from "./useScheduleLabels";

/** What is wrong with the schedules that are on, as the status bar says it. */
export interface ScheduleTrouble {
  /** The schedules that are on. */
  on: ScheduleView[];
  /** How many of them will not run (their automation or connections are gone, B-016). */
  blocked: number;
  /** The last runs that need attention ("1 failed"), or empty. */
  concern: string;
}

/**
 * The trouble of the schedules that are on, from one source for every place that
 * counts them: the status bar and Settings ▸ Schedules (#5860, G-003).
 */
export function useScheduleTrouble(): ScheduleTrouble {
  const schedules = useAppStore((s) => s.schedules);
  const { automations, connections, blockedShort } = useScheduleLabels();
  const on = schedules.filter((x) => x.enabled);
  const concerns = on.map(lastRunAttention);
  const concern = concernText(
    concerns.filter((c) => c === "error").length,
    concerns.filter((c) => c === "warning").length
  );
  // Not before the library and the connections have loaded.
  const loaded = automations.length > 0 && connections.length > 0;
  const blocked = loaded ? on.filter((x) => blockedShort(x) !== null).length : 0;
  return { on, blocked, concern };
}
