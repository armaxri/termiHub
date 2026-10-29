import { useMemo, useState } from "react";
import { Cable } from "lucide-react";
import { MenuItem } from "@/components/ui";
import { listAgentSerialPorts } from "@/services/api";
import { useSerialPortRescan } from "@/components/DynamicForm/useSerialPortRescan";

interface AgentNewSerialSessionItemProps {
  agentId: string;
  /** The agent's connect-time `availableSerialPorts` snapshot. */
  snapshot: readonly string[];
  /** Whether the agent advertises `serialPortRescan` (`serial.list_ports`). */
  canRescan: boolean;
  /** Open a serial session on `port`. */
  onSelectPort: (port: string) => void;
}

/** Raised by the agent lister when the agent cannot list its ports on demand. */
class AgentRescanUnsupported extends Error {}

/**
 * The agent context menu's "New Serial Session" item (#5075). It is mounted
 * only while the menu is open, so for an agent advertising `serialPortRescan`
 * the agent's ports are enumerated freshly on open and rescanned (with the
 * editor's backoff, #5069) while the menu stays open: an adapter plugged in
 * after connect is offered, an unplugged one is not. The connect-time snapshot
 * stands in until the first scan answers, and is kept for older agents (or one
 * that answers "unsupported"). Hidden when there is no port to offer.
 */
export function AgentNewSerialSessionItem({
  agentId,
  snapshot,
  canRescan,
  onSelectPort,
}: AgentNewSerialSessionItemProps) {
  const [unsupported, setUnsupported] = useState(false);
  const agentRescan = canRescan && !unsupported;
  const lister = useMemo(
    () => async () => {
      const result = await listAgentSerialPorts(agentId);
      if (!result.supported) {
        setUnsupported(true);
        throw new AgentRescanUnsupported(agentId);
      }
      return result.ports;
    },
    [agentId]
  );
  const detected = useSerialPortRescan({ enabled: agentRescan, lister });
  const ports = agentRescan && detected.scanned ? detected.ports : snapshot;
  const port = ports[0];
  if (port === undefined) return null;

  return (
    <MenuItem onSelect={() => onSelectPort(port)} data-testid="context-agent-new-serial">
      <Cable size={14} />
      New Serial Session
      <span className="ui-menu__hint">{port}</span>
    </MenuItem>
  );
}
