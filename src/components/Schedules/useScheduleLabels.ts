import { useCallback, useMemo } from "react";

import { useExperimentalFeatures } from "@/hooks/useExperimentalFeatures";
import { useAppStore } from "@/store/appStore";
import { useBroadcastGroups } from "@/store/broadcastGroups";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import type { ScheduleAction, ScheduleTargets } from "@/types/schedule";

import { t, tf } from "@/i18n/catalog";
import { localProcessBlockedReason } from "@/utils/localProcessGate";
import { unattendedBlockedReason } from "@/utils/unattended";

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
      return automation?.name ?? t("schedule.action.deleted");
    },
    [automations]
  );

  const experimental = useExperimentalFeatures();

  const targets = useCallback(
    (target: ScheduleTargets) => describeTargetNames(target, (id) => names.get(id), groups),
    [names, groups]
  );

  /** Why a schedule will not run, or `null` (#5818, #6024). */
  const blockedReason = useCallback(
    (s: { action: ScheduleAction; targets: ScheduleTargets }): string | null => {
      const find = (id: string) => automations.find((x) => x.id === id);
      const automation = find(s.action.automationId);
      if (!automation) return tf("schedule.blocked", { reason: t("schedule.gone.automation") });
      const blocked =
        localProcessBlockedReason(automation, find, experimental) ??
        unattendedBlockedReason(automation);
      if (blocked) return blocked;
      const { gone } = targets(s.targets);
      return gone ? tf("schedule.blocked", { reason: gone }) : null;
    },
    [automations, experimental, targets]
  );

  return { automations, connections, groups, actionLabel, blockedReason, targets };
}
