import { useEffect, useState } from "react";
import type { ScheduleRule } from "@/types/schedule";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

/** Asks the scheduler when a rule would run next. */
export type PreviewNextRun = (rule: ScheduleRule) => Promise<string | null>;

/**
 * When `rule` would run next (#6024), asked from the scheduler itself: its clock
 * and its daylight-saving rules decide, so the preview never disagrees with the
 * run. `null` while unknown, for no rule, and for a rule that is not valid.
 */
export function useNextRun(
  rule: ScheduleRule | null,
  preview: PreviewNextRun | undefined
): string | null {
  const key = rule ? JSON.stringify(rule) : "";
  const [answer, setAnswer] = useState<{ key: string; next: string | null }>({
    key: "",
    next: null,
  });
  useEffect(() => {
    if (key === "" || !preview) return;
    let current = true;
    preview(JSON.parse(key) as ScheduleRule)
      .then((next) => {
        if (current) setAnswer({ key, next: next ?? null });
      })
      .catch((err: unknown) => {
        frontendLog("schedules", `next-run preview failed: ${errorMessage(err)}`);
      });
    return () => {
      current = false;
    };
  }, [key, preview]);
  // An answer to another rule is never shown.
  return answer.key === key ? answer.next : null;
}
