/**
 * Tunnel run-location (host) helpers — the view-model + labelling layer for
 * agent-hosted tunnels (S3, #2155).
 *
 * SSH semantics are invariant; only the host machine moves. "Local"/"remote"
 * keep their exact SSH meaning relative to the *tunnel host*. These pure helpers
 * turn a tunnel's {@link RunLocation} host plus its {@link TunnelType} into the
 * named endpoint copy, the per-row host badge, and the non-blocking reachability
 * warning the UI renders. They are pure (no store, no React) so they unit-test
 * directly and the components stay thin renderers.
 */

import type {
  PortValue,
  ReachableFrom,
  RunLocation,
  TunnelConfig,
  TunnelType,
} from "@/types/tunnel";
import { THIS_COMPUTER } from "@/types/tunnel";

/** A tunnel's effective host, defaulting a missing field to This computer. */
export function resolveTunnelHost(config: Pick<TunnelConfig, "host">): RunLocation {
  return config.host ?? THIS_COMPUTER;
}

/** Narrow a run-location to the agent variant. */
export function isAgentHost(host: RunLocation): host is { kind: "agent"; agentId: string } {
  return host.kind === "agent";
}

/**
 * The badge shown on every tunnel row (sidebar + Open Connections). Desktop
 * tunnels read "this computer"; agent tunnels name the agent. `agentName` is the
 * resolved human name for the host agent, falling back to the raw id.
 */
export function tunnelHostBadge(
  host: RunLocation,
  agentName?: string
): { label: string; onAgent: boolean } {
  if (isAgentHost(host)) {
    return { label: agentName || host.agentId, onAgent: true };
  }
  return { label: "this computer", onAgent: false };
}

/** The concrete machine name used inside endpoint copy ("agent build-box"). */
function hostMachine(host: RunLocation, agentName?: string): string {
  return isAgentHost(host) ? `agent ${agentName || host.agentId}` : "this computer";
}

/** Loopback listen addresses — reachable only from the host machine itself. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Whether a bind address is loopback (as opposed to a widened / any address). */
export function isLoopbackBind(hostAddr: string): boolean {
  return LOOPBACK_HOSTS.has(hostAddr.trim().toLowerCase());
}

/** A widened bind that exposes the port beyond the host machine itself. */
export const WIDE_BIND_HOST = "0.0.0.0";

function addr(host: string, port: PortValue): string {
  return `${host}:${port === "" ? "?" : port}`;
}

/** A single named endpoint line for the tunnel editor. */
export interface TunnelEndpointLine {
  /** Leading bold label, e.g. "Listens on" / "Via" / "Forwards to". */
  label: string;
  /** The concrete machine for this endpoint (e.g. "agent build-box"), if any. */
  machine?: string;
  /** The address (host:port) for this endpoint, if any. */
  address?: string;
  /** A parenthetical note (reachability / resolution vantage), if any. */
  note?: string;
}

/** The "who can reach this" note for a listen socket on the tunnel host. */
function listenReach(host: RunLocation, bindHost: string, agentName?: string): string {
  const loopback = isLoopbackBind(bindHost);
  if (isAgentHost(host)) {
    const name = agentName || host.agentId;
    return loopback
      ? `reachable only from processes on ${name} — not this computer`
      : `reachable on ${name}'s network`;
  }
  return loopback ? "reachable from apps on this computer" : "reachable on this computer's network";
}

/**
 * The named endpoint lines for a tunnel, naming the concrete machine + address
 * on each side (never a bare "local"/"remote" adjective) per the endpoint
 * semantics sub-concept. `sshLabel` is the SSH connection's display name.
 */
export function tunnelEndpointLines(
  tunnelType: TunnelType,
  host: RunLocation,
  opts: { agentName?: string; sshLabel?: string } = {}
): TunnelEndpointLine[] {
  const { agentName, sshLabel = "SSH connection" } = opts;
  const machine = hostMachine(host, agentName);

  switch (tunnelType.type) {
    case "local": {
      const c = tunnelType.config;
      return [
        {
          label: "Listens on",
          machine,
          address: addr(c.localHost, c.localPort),
          note: listenReach(host, c.localHost, agentName),
        },
        { label: "Via", machine: `SSH server ${sshLabel}` },
        {
          label: "Forwards to",
          address: addr(c.remoteHost, c.remotePort),
          note: "resolved from the SSH server",
        },
      ];
    }
    case "remote": {
      const c = tunnelType.config;
      return [
        {
          label: "Listens on",
          machine: `SSH server ${sshLabel}`,
          address: addr(c.remoteHost, c.remotePort),
          note: "reachable on the SSH server's network",
        },
        {
          label: "Forwards to",
          machine,
          address: addr(c.localHost, c.localPort),
          note: `resolved from ${machine}`,
        },
      ];
    }
    case "dynamic": {
      const c = tunnelType.config;
      return [
        {
          label: "SOCKS5 proxy on",
          machine,
          address: addr(c.localHost, c.localPort),
          note: listenReach(host, c.localHost, agentName),
        },
        { label: "Targets reached from", machine: `SSH server ${sshLabel}` },
      ];
    }
  }
}

/**
 * The non-blocking reachability warning for the tunnel editor, or `null` when
 * none applies. It fires only for an agent-hosted local/dynamic forward bound to
 * loopback — the one dangerous case where the listen port sits on the agent's
 * `127.0.0.1` and this computer cannot reach it. Never a hard block: the user
 * may widen the bind or dismiss it (loopback-on-agent is legitimate when the
 * consumer is another agent-hosted service).
 */
export function tunnelReachabilityWarning(
  tunnelType: TunnelType,
  host: RunLocation,
  agentName?: string
): { message: string; bindHost: string } | null {
  if (!isAgentHost(host)) return null;
  if (tunnelType.type === "remote") return null;
  const bindHost = tunnelType.config.localHost;
  if (!isLoopbackBind(bindHost)) return null;
  const name = agentName || host.agentId;
  const port = tunnelType.config.localPort;
  return {
    message:
      `This port opens on ${name}, not your computer. ` +
      `localhost:${port === "" ? "?" : port} here will not reach it.`,
    bindHost,
  };
}

/**
 * The runtime vantage note for a *running* agent-hosted tunnel, derived from the
 * agent's reported {@link ReachableFrom} rather than the persisted host+bind
 * heuristic (#2199). This is authoritative — it reflects the agent's actual bind
 * classification, including the `-R` (`sshServer`) case the config-only
 * {@link tunnelReachabilityWarning} cannot express and any loopback/widened
 * outcome the agent settled on. Returns `null` when there is no report
 * (desktop tunnels, or an agent tunnel that has not reported yet).
 *
 * `warn` marks the one case where the listen port is NOT reachable from this
 * computer (`agentOnly` — a loopback bind on the agent), so the UI can badge it.
 */
export function reportedReachability(
  reachableFrom: ReachableFrom | undefined,
  agentName: string
): { label: string; warn: boolean } | null {
  switch (reachableFrom) {
    case "agentOnly":
      return { label: `reachable only on ${agentName}`, warn: true };
    case "agentLan":
      return { label: `reachable on ${agentName}'s network`, warn: false };
    case "sshServer":
      return { label: "reachable on the SSH server's network", warn: false };
    default:
      return null;
  }
}
