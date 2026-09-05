import { useCallback } from "react";

import { toast } from "@/components/ui";
import { RunLocationSelect } from "@/components/RunLocationSelect";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { useRunLocationStore } from "@/store/runLocationStore";
import { useAppStore } from "@/store/appStore";
import {
  encodeRunLocation,
  isAgentHost,
  THIS_COMPUTER,
  type RunLocation,
} from "@/utils/runLocation";
import type { MonitoringEntry } from "@/types/monitoring";

/** Props for {@link MonitorRunLocation}. */
interface MonitorRunLocationProps {
  /** The system monitor whose execution host is being chosen. */
  entry: MonitoringEntry;
}

/**
 * The "Run on" control for a **system monitor** (#2593): choose whether the
 * monitor runs on this computer or a connected agent's own host. Mirrors
 * {@link import("../NetworkTools/NetworkToolRunLocation").NetworkToolRunLocation}
 * so the system-monitor vantage is a first-class choice, consistent with the
 * network-tool and HTTP-monitor selectors.
 *
 * System monitoring is `LocalOrAgent`: the agent path routes
 * `monitoring.subscribe`/`unsubscribe` through the chosen agent so the streamed
 * samples come from the agent host. Because a system monitor is a live,
 * session-keyed subscription, changing its vantage **reconnects** it — the
 * current subscription is torn down and re-opened on the newly chosen host. The
 * choice is recorded in {@link useRunLocationStore} so the selector keeps
 * showing the chosen vantage and a later reconnect keeps it; the update is
 * optimistic and rolls back on failure.
 */
export function MonitorRunLocation({ entry }: MonitorRunLocationProps) {
  const { remoteAgents: agents } = useProjectedAgents();
  const value = useRunLocationStore((s) => s.systemMonitorLocations[entry.key]) ?? THIS_COMPUTER;
  const setLocation = useRunLocationStore((s) => s.setSystemMonitorLocation);
  const connectMonitoring = useAppStore((s) => s.connectMonitoring);
  const disconnectMonitoring = useAppStore((s) => s.disconnectMonitoring);

  const handleChange = useCallback(
    async (location: RunLocation) => {
      // No-op when the vantage is unchanged so an idle re-select never churns a
      // live subscription.
      if (encodeRunLocation(location) === encodeRunLocation(value)) return;

      const previous = value;
      setLocation(entry.key, location); // optimistic
      try {
        // Reconnect so the streamed samples come from the chosen host: tear the
        // current subscription down, then re-open on the new vantage.
        await disconnectMonitoring(entry.key);
        await connectMonitoring(entry.key, entry.host, location);
        toast.success(
          isAgentHost(location) ? "Monitoring moved to agent" : "Monitoring moved to this computer"
        );
      } catch (err: unknown) {
        setLocation(entry.key, previous); // roll back on failure
        toast.error("Couldn't change run location", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [entry.key, entry.host, value, setLocation, connectMonitoring, disconnectMonitoring]
  );

  return (
    <RunLocationSelect
      value={value}
      agents={agents}
      onChange={handleChange}
      aria-label={`Run monitor for ${entry.host ?? entry.key} on`}
      data-testid={`monitor-runloc-${entry.key}`}
    />
  );
}
