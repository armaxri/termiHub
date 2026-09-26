import { useCallback, useMemo } from "react";

import { useAppStore } from "@/store/appStore";
import { useBroadcastGroups } from "@/store/broadcastGroups";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import type { ScheduleAction, ScheduleTargets } from "@/types/schedule";

import { describeTargetNames } from "./scheduleForm";

/** Human labels for a schedule's action and targets, from live store state. */
export function useScheduleLabels() {
  const workflows = useAppStore((s) => s.workflows);
  const macros = useAppStore((s) => s.macros);
  const { connections } = useProjectedConnections();
  const groups = useBroadcastGroups();

  const names = useMemo(() => new Map(connections.map((c) => [c.id, c.name])), [connections]);

  const actionLabel = useCallback(
    (action: ScheduleAction): string => {
      if (action.kind === "workflow") {
        const w = workflows.find((x) => x.id === action.workflowId);
        return w ? `workflow "${w.name}"` : "a deleted workflow";
      }
      const m = macros.find((x) => x.id === action.macroId);
      return m ? `macro "${m.name}"` : "a deleted macro";
    },
    [workflows, macros]
  );

  const targets = useCallback(
    (t: ScheduleTargets) => describeTargetNames(t, (id) => names.get(id), groups),
    [names, groups]
  );

  return { workflows, macros, connections, groups, actionLabel, targets };
}
