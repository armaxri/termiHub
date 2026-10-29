import { Cable, Container, Globe, Monitor, Terminal, Wifi } from "lucide-react";

/** Props for {@link ConnectTypeIcon}. */
export interface ConnectTypeIconProps {
  /** The connection type (`ssh`, `telnet`, `serial`, `docker`, `rdp`, …). */
  type: string;
  /** Pixel size. Defaults to 20 (the connect ring's centre glyph). */
  size?: number;
}

/**
 * The glyph for a connection type on the connect overlay (#5068) — the same
 * mapping the agent tree uses for its session rows.
 */
export function ConnectTypeIcon({ type, size = 20 }: ConnectTypeIconProps) {
  switch (type) {
    case "serial":
      return <Cable size={size} aria-hidden />;
    case "docker":
      return <Container size={size} aria-hidden />;
    case "ssh":
      return <Wifi size={size} aria-hidden />;
    case "telnet":
      return <Globe size={size} aria-hidden />;
    case "rdp":
    case "vnc":
      return <Monitor size={size} aria-hidden />;
    default:
      return <Terminal size={size} aria-hidden />;
  }
}
