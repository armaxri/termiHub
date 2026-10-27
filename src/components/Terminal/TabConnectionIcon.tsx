import type { TerminalTab } from "@/types/terminal";
import { ConnectionIcon } from "@/utils/connectionIcons";
import { useSavedConnection } from "@/hooks/useSavedConnection";

interface TabConnectionIconProps {
  tab: Pick<TerminalTab, "config" | "connectionId">;
  size?: number;
  className?: string;
}

/**
 * The connection icon for a terminal tab. When the tab was opened from a saved
 * connection, its custom icon, icon colour and emoji (#5008) are looked up
 * live, so an edit in the connection editor shows on open tabs immediately;
 * otherwise the type icon is drawn.
 */
export function TabConnectionIcon({ tab, size = 14, className }: TabConnectionIconProps) {
  const saved = useSavedConnection(tab.connectionId);
  return (
    <ConnectionIcon
      config={tab.config}
      customIcon={saved?.icon}
      iconColor={saved?.iconColor}
      iconEmoji={saved?.iconEmoji}
      size={size}
      className={className}
    />
  );
}
