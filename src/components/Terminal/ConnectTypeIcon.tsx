import { ConnectionTypeIcon } from "@/utils/connectionIcons";

/** Props for {@link ConnectTypeIcon}. */
export interface ConnectTypeIconProps {
  /** The connection type (`ssh`, `telnet`, `serial`, `docker`, `rdp`, …). */
  type: string;
  /** Pixel size. Defaults to 20 (the connect ring's centre glyph). */
  size?: number;
}

/**
 * The glyph for a connection type on the connect overlay (#5068) — the shared
 * connection-type mapping used by the sidebar, tabs and agent tree (#5622).
 */
export function ConnectTypeIcon({ type, size = 20 }: ConnectTypeIconProps) {
  return <ConnectionTypeIcon type={type} size={size} aria-hidden />;
}
