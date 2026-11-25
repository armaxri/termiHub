import { toast } from "@/components/ui";
import { runPreview } from "@/components/Automations/runPreview";
import { useAppStore } from "@/store/appStore";
import type { ScheduleView } from "@/types/schedule";
import { errorMessage } from "@/utils/errorMessage";
import { ScheduleEnableConfirmDialog } from "./ScheduleEnableConfirmDialog";
import { useScheduleLabels } from "./useScheduleLabels";

/** Props of {@link ScheduleSwitchOn}. */
export interface ScheduleSwitchOnProps {
  /** The schedule to switch on, or `null` while nothing is asked. */
  schedule: ScheduleView | null;
  onDone: () => void;
}

/**
 * Asks before a schedule is first switched on (PROD-043): which hosts, what is typed
 * there and when. One place for the list's switch and for "Save and switch on…".
 */
export function ScheduleSwitchOn({ schedule, onDone }: ScheduleSwitchOnProps) {
  const setScheduleEnabled = useAppStore((s) => s.setScheduleEnabled);
  const library = useAppStore((s) => s.automations);
  const labels = useScheduleLabels();
  const targets = schedule ? labels.targets(schedule.targets) : null;
  const automation = library.find((a) => a.id === schedule?.action.automationId);
  return (
    <ScheduleEnableConfirmDialog
      open={schedule !== null}
      scheduleName={schedule?.name ?? ""}
      actionLabel={schedule ? labels.actionLabel(schedule.action) : ""}
      rule={schedule?.rule ?? null}
      hosts={targets?.hosts ?? []}
      gone={targets?.gone ?? null}
      steps={automation ? runPreview(automation, library) : []}
      stepCount={automation?.steps.length ?? 0}
      missedRuns={schedule?.missedRuns ?? "skip"}
      connects={schedule?.connectIfNeeded === true}
      onConfirm={async () => {
        if (schedule) {
          try {
            await setScheduleEnabled(schedule.id, true, true);
          } catch (err) {
            toast.error(`Failed to update schedule: ${errorMessage(err)}`);
          }
        }
        onDone();
      }}
      onCancel={onDone}
    />
  );
}
