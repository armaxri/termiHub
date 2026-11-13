/**
 * Labels for the status-bar session chips (#5628): the SSH chip shown on every
 * SSH tab and the serial chip with the port and line settings.
 *
 * Pure so the exact wording is unit-tested; the components only render them.
 */

import type { JumpHostConfig } from "@/types/connection";
import type { ConnectionConfig } from "@/types/terminal";
import { getJumpHosts } from "@/utils/jumpHost";
import { isSshConnectionConfig } from "@/utils/typedConnectionConfig";
import { connectionConfigFields } from "@/utils/connectionConfigFields";
import type { SshHostKeyTrustedEvent } from "@/types/generated/SshHostKeyTrustedEvent";
import type { SshHostKeyTrust } from "@/types/generated/SshHostKeyTrust";

/** A status-bar chip: its visible label and its tooltip. */
export interface SessionChip {
  label: string;
  tooltip: string;
}

/** The SSH port when a config leaves it out (mirrors the backend default). */
const DEFAULT_SSH_PORT = 22;

/** Serial defaults when a config leaves them out (mirrors `SerialConfig`). */
const SERIAL_DEFAULTS = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none" };

/** A config value as a positive number, accepting numeric strings. */
function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `host:port`, or the generic hop name for a saved-connection reference. */
function hopEndpoint(hop: JumpHostConfig): string {
  const host = hop.host?.trim();
  if (!host) return "jump host";
  return `${host}:${numberOr(hop.port, DEFAULT_SSH_PORT)}`;
}

/** How an SSH config authenticates, for the chip tooltip. */
function authDescription(method: string | undefined, keyPath: string | undefined): string {
  switch (method) {
    case "password":
      return "password";
    case "agent":
      return "SSH agent";
    case "key":
      return keyPath ? `key ${keyPath}` : "key";
    default:
      return method || "unknown";
  }
}

/** How a host key was trusted, for the chip tooltip (#5669). */
const TRUST_WORDING: Record<SshHostKeyTrust, string> = {
  knownHosts: "trusted via ~/.ssh/known_hosts",
  remembered: "trusted",
  firstSeenRemembered: "first seen, accepted and remembered",
  firstSeenOnce: "first seen, trusted once (this session only)",
  changedReplaced: "changed, new key accepted and remembered",
  changedOnce: "changed, trusted once (this session only)",
};

/** The tooltip line for the target's accepted host key, e.g. `Host key: trusted (SHA256:…)`. */
function hostKeyTrustLine(event: SshHostKeyTrustedEvent): string {
  return `Host key: ${TRUST_WORDING[event.trust]} (${event.fingerprint})`;
}

/**
 * The SSH chip for an SSH config: `user@host:port`, plus ` via hop:port → …`
 * when it jumps, so a target and bastion that differ only by port stay
 * distinguishable. The tooltip names the auth method (and key) and, once the
 * session's connect accepted the target's host key (`hostKeys`, #5669), how
 * that key is trusted. Returns `null` for non-SSH configs or an SSH config
 * without a host.
 */
export function sshStatusChip(
  config: ConnectionConfig | undefined | null,
  hostKeys: readonly SshHostKeyTrustedEvent[] = []
): SessionChip | null {
  if (!isSshConnectionConfig(config)) return null;
  const fields = config.config;
  const host = fields.host?.trim();
  if (!host) return null;
  const port = numberOr(fields.port, DEFAULT_SSH_PORT);
  const endpoint = `${host}:${port}`;
  const target = fields.username ? `${fields.username}@${endpoint}` : endpoint;
  const hops = getJumpHosts(config);
  const label = hops.length > 0 ? `${target} via ${hops.map(hopEndpoint).join(" → ")}` : target;
  // A jump chain also reports each hop's key; only the target's is shown.
  const targetKey = hostKeys.find((k) => k.host.trim() === host && k.port === port);
  const tooltip = [
    `SSH: ${label}`,
    `Auth: ${authDescription(fields.authMethod, fields.keyPath)}`,
    ...(targetKey ? [hostKeyTrustLine(targetKey)] : []),
  ].join("\n");
  return { label, tooltip };
}

/**
 * The serial chip: `<port> · <baud> <data><parity><stop>`, e.g.
 * `/dev/ttyPR0 · 9600 8N1`. Missing settings fall back to the backend defaults.
 * Returns `null` for non-serial configs or one without a port.
 */
export function serialStatusChip(config: ConnectionConfig | undefined | null): SessionChip | null {
  if (config?.type !== "serial") return null;
  const fields = connectionConfigFields(config);
  const port = typeof fields.port === "string" ? fields.port.trim() : "";
  if (!port) return null;
  const baud = numberOr(fields.baudRate, SERIAL_DEFAULTS.baudRate);
  const dataBits = numberOr(fields.dataBits, SERIAL_DEFAULTS.dataBits);
  const stopBits = numberOr(fields.stopBits, SERIAL_DEFAULTS.stopBits);
  const parity = typeof fields.parity === "string" ? fields.parity : SERIAL_DEFAULTS.parity;
  const parityLetter = (parity.charAt(0) || "n").toUpperCase();
  const label = `${port} · ${baud} ${dataBits}${parityLetter}${stopBits}`;
  return { label, tooltip: `Serial: ${label}` };
}
