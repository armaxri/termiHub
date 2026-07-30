import { useCallback } from "react";
import { toast } from "@/components/ui";
import { RunLocationSelect } from "@/components/RunLocationSelect";
import { useAppStore } from "@/store/appStore";
import { useRunLocationStore } from "@/store/runLocationStore";
import { setNetworkToolRunLocation } from "@/services/networkApi";
import { THIS_COMPUTER, type RunLocation } from "@/utils/runLocation";
import type { NetworkTool } from "@/types/terminal";
import { NETWORK_TOOL_LOCATION } from "./networkToolLocation";

interface NetworkToolRunLocationProps {
  tool: NetworkTool;
}

/**
 * The "Run on" control for a network-tool panel (#2191): choose whether the
 * tool runs on this computer or a connected agent. Defaults to This computer;
 * a desktop-only tool (the HTTP monitor, ping sweep, open-ports) offers only
 * This computer, per Open Design Decision #4.
 *
 * The choice is recorded on the desktop backend (which routes the tool's next
 * invocation) and mirrored in {@link useRunLocationStore} so the selector keeps
 * showing the chosen vantage. The update is optimistic and rolls back on a
 * backend failure.
 */
export function NetworkToolRunLocation({ tool }: NetworkToolRunLocationProps) {
  const info = NETWORK_TOOL_LOCATION[tool];
  const agents = useAppStore((s) => s.remoteAgents);
  const value = useRunLocationStore((s) => s.networkToolLocations[tool]) ?? THIS_COMPUTER;
  const setLocation = useRunLocationStore((s) => s.setNetworkToolLocation);

  const handleChange = useCallback(
    (location: RunLocation) => {
      const key = info?.backendKey;
      // Desktop-only / non-routable tools have nothing to persist (they only
      // ever offer This computer).
      if (!key) return;
      const previous = value;
      setLocation(tool, location); // optimistic
      setNetworkToolRunLocation(key, location).catch((err: unknown) => {
        setLocation(tool, previous); // roll back on failure
        toast.error("Couldn't change run location", {
          description: err instanceof Error ? err.message : String(err),
        });
      });
    },
    [info?.backendKey, tool, value, setLocation]
  );

  if (!info) return null;

  return (
    <div className="network-panel__runon">
      <span className="network-panel__runon-label">Run on</span>
      <RunLocationSelect
        value={value}
        agents={agents}
        onChange={handleChange}
        agentAllowed={info.agentAllowed}
        aria-label={`Run ${tool} on`}
        data-testid={`network-runloc-${tool}`}
      />
    </div>
  );
}
