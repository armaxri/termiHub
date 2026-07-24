import type { ConnectionConfig } from "@/types/terminal";
import { getBasename } from "@/utils/formatters";

/** Read a config field as a trimmed non-empty string, else undefined. */
function str(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * Compute a human-readable display title for a session-history entry from its
 * connection config — `user@host` for SSH, the device path for serial, the
 * container name for Docker, and so on.
 */
export function sessionHistoryTitle(connectionType: string, config: ConnectionConfig): string {
  const inner = config.config ?? {};
  switch (connectionType) {
    case "ssh": {
      const host = str(inner, "host") ?? "host";
      const user = str(inner, "username");
      return user ? `${user}@${host}` : host;
    }
    case "telnet": {
      const host = str(inner, "host") ?? "host";
      const port = str(inner, "port");
      return port && port !== "23" ? `${host}:${port}` : host;
    }
    case "serial":
      return str(inner, "device") ?? str(inner, "port") ?? "Serial";
    case "docker":
      return str(inner, "container") ?? "Container";
    case "wsl":
      return str(inner, "distribution") ?? "WSL";
    case "local": {
      const shell = str(inner, "shell") ?? str(inner, "shellType");
      if (!shell) return "Local Shell";
      if (shell.startsWith("wsl:")) return shell.slice(4);
      return getBasename(shell);
    }
    default:
      return str(inner, "host") ?? connectionType;
  }
}

/** Short, uppercased type badge label for a connection type. */
export function sessionTypeBadge(connectionType: string): string {
  switch (connectionType) {
    case "ssh":
      return "SSH";
    case "telnet":
      return "Telnet";
    case "serial":
      return "Serial";
    case "docker":
      return "Docker";
    case "wsl":
      return "WSL";
    case "local":
      return "Local";
    case "remote":
    case "remote-session":
      return "Agent";
    default:
      return connectionType;
  }
}
