/**
 * Which sessions travel unencrypted (#5749): telnet sends everything, the
 * login password included, in clear text. Such a session carries an
 * "Unencrypted" badge on its tab and in the status-bar telnet chip, and its
 * password prompt says so.
 */

import type { ConnectionConfig } from "@/types/terminal";
import { readConfigString } from "@/utils/connectionConfigFields";

/**
 * Whether a tab's connection runs over telnet: a direct telnet connection, or
 * a telnet session on a remote agent (the agent's hop to the host is telnet).
 */
export function isUnencryptedSession(config: ConnectionConfig | undefined | null): boolean {
  if (!config) return false;
  if (config.type === "telnet") return true;
  return config.type === "remote-session" && readConfigString(config, "sessionType") === "telnet";
}

/**
 * Whether a password prompt's transport display name (e.g. `"Telnet"`, #5617)
 * names an unencrypted transport.
 */
export function isUnencryptedTransport(transport: string | null | undefined): boolean {
  return transport?.trim().toLowerCase() === "telnet";
}
