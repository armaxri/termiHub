import { t, tf } from "@/i18n/catalog";
import { THIS_COMPUTER, type TunnelConfig, type TunnelStats } from "@/types/tunnel";
import { formatBytes, formatRate } from "@/utils/formatters";
import { UNREADABLE_HOST } from "@/utils/hostChoice";
import { tunnelPortMapping } from "@/utils/tunnelSummary";
import { tunnelTypeHelp } from "@/utils/tunnelTypeHelp";

/** What the tunnel row's tooltip needs beyond the config (#5770). */
export interface TunnelRowTooltipInput {
  /** The SSH connection's name ("Unknown" when it is gone). */
  sshLabel: string;
  /** The host badge: the agent's name, "this computer" or an unknown machine. */
  host: { label: string; onAgent: boolean; unreadable?: boolean };
  /** Live counters, shown only while the tunnel is active. */
  stats?: TunnelStats;
  /** Smoothed upload / download rates in bytes per second. */
  upRate?: number | null;
  downRate?: number | null;
  /** A reachability note that does not need attention ("reachable on …"). */
  reach?: string | null;
  /** The bound address the agent reported. */
  boundAddress?: string;
  /** A healthy chained-pair label ("Linked · connected"). */
  pair?: string | null;
}

/**
 * The tunnel row's tooltip lines (#5770): the forwarding (type and ports), what
 * that type does (#6027), the SSH connection it goes through, the machine that hosts it, and — while it
 * runs — its traffic. The row itself shows only the name, the description and
 * markers that need attention. See docs/copy-style.md -> "List rows".
 */
export function tunnelRowTooltip(tunnel: TunnelConfig, input: TunnelRowTooltipInput): string[] {
  const help = tunnelTypeHelp(
    tunnel.tunnelType.type,
    input.host.unreadable
      ? UNREADABLE_HOST
      : input.host.onAgent
        ? { kind: "agent", agentId: input.host.label }
        : THIS_COMPUTER
  );
  const out = [
    tf("tunnel.tooltip.forward", {
      type: help.label,
      flag: help.flag,
      mapping: tunnelPortMapping(tunnel),
    }),
    help.lines[0],
    tf("tunnel.tooltip.via", { connection: input.sshLabel }),
    input.host.unreadable
      ? t("service.host.unreadable")
      : input.host.onAgent
        ? tf("tunnel.tooltip.hostAgent", { agent: input.host.label })
        : t("tunnel.tooltip.hostLocal"),
  ];
  if (input.stats) {
    const up = formatRate(input.upRate ?? null);
    const down = formatRate(input.downRate ?? null);
    out.push(
      tf("tunnel.tooltip.traffic", {
        up: formatBytes(input.stats.bytesSent) + (up ? ` (${up})` : ""),
        down: formatBytes(input.stats.bytesReceived) + (down ? ` (${down})` : ""),
        active: input.stats.activeConnections,
        total: input.stats.totalConnections,
      })
    );
  }
  if (input.reach) {
    out.push(
      input.boundAddress
        ? tf("tunnel.tooltip.bound", { address: input.boundAddress, reach: input.reach })
        : input.reach
    );
  }
  if (input.pair) out.push(input.pair);
  return out;
}
