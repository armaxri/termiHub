import type { TerminalTab } from "@/types/terminal";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { useSavedConnection } from "@/hooks/useSavedConnection";
import { useAgentDefinition } from "@/hooks/useAgentDefinition";
import { readConfigString } from "@/utils/connectionConfigFields";

interface TabConnectionIconProps {
  tab: Pick<TerminalTab, "config" | "connectionId">;
  size?: number;
  className?: string;
}

/**
 * The connection icon for a terminal tab. When the tab was opened from a saved
 * connection (#5008) or an agent connection definition (#5021), its custom
 * icon, icon colour and emoji are looked up live, so an edit in the connection
 * editor shows on open tabs immediately; otherwise the type icon is drawn.
 */
export function TabConnectionIcon({ tab, size = 14, className }: TabConnectionIconProps) {
  const saved = useSavedConnection(tab.connectionId);
  const isAgentSession = tab.config.type === "remote-session";
  const agentDef = useAgentDefinition(
    isAgentSession ? readConfigString(tab.config, "agentId") : undefined,
    isAgentSession ? readConfigString(tab.config, "definitionId") : undefined
  );
  const source = saved ?? agentDef;
  return (
    <ConnectionIcon
      config={tab.config}
      customIcon={source?.icon}
      iconColor={source?.iconColor}
      iconEmoji={source?.iconEmoji}
      size={size}
      className={className}
    />
  );
}
