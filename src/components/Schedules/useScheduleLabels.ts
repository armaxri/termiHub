import { useCallback, useMemo } from "react";

import { useAppStore } from "@/store/appStore";
import { useBroadcastGroups } from "@/store/broadcastGroups";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import type { ScheduleAction, ScheduleTargets } from "@/types/schedule";

import { describeTargetNames } from "./scheduleForm";

/** Human labels for a schedule's action and targets, from live store state. */
export function useScheduleLabels() {
  const automations = useAppStore((s) => s.automations);
  const { connections } = useProjectedConnections();
  const groups = useBroadcastGroups();

  const names = useMemo(() => new Map(connections.map((c) => [c.id, c.name])), [connections]);

  const actionLabel = useCallback(
    (action: ScheduleAction): string => {
      const automation = automations.find((x) => x.id === action.automationId);
      return automation ? `automation "${automation.name}"` : "a deleted automation";
    },
    [automations]
  );

  const targets = useCallback(
    (t: ScheduleTargets) => describeTargetNames(t, (id) => names.get(id), groups),
    [names, groups]
  );

  return { automations, connections, groups, actionLabel, targets };
}
