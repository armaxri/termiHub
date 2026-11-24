import { useCallback, useMemo } from "react";

import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { useAppStore } from "@/store/appStore";
import { useBroadcastGroups } from "@/store/broadcastGroups";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import type { ScheduleAction, ScheduleTargets } from "@/types/schedule";

import { localProcessBlockedReason } from "@/utils/localProcessGate";

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

  const experimental = useExperimentalFeatures();
  /** Why a schedule of this action will not run, or `null` (#5818). */
  const blockedReason = useCallback(
    (action: ScheduleAction): string | null => {
      const find = (id: string) => automations.find((x) => x.id === id);
      const automation = find(action.automationId);
      return automation ? localProcessBlockedReason(automation, find, experimental) : null;
    },
    [automations, experimental]
  );

  const targets = useCallback(
    (t: ScheduleTargets) => describeTargetNames(t, (id) => names.get(id), groups),
    [names, groups]
  );

  return { automations, connections, groups, actionLabel, blockedReason, targets };
}
