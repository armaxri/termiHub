import { t, tf } from "@/i18n/catalog";
import {
  PROTOCOL_LABELS,
  type EmbeddedServerConfig,
  type ServerStats,
} from "@/types/embeddedServer";
import { formatBytes } from "@/utils/formatters";

/** The URL a server listens on, e.g. `http://127.0.0.1:8080`. */
export function serverUrl(config: EmbeddedServerConfig): string {
  return `${config.serverType}://${config.bindHost}:${config.port}`;
}

/**
 * The service row's tooltip lines (#5770): the protocol and address it
 * listens on, the folder it serves, read-only, where it runs (an agent) and —
 * while it runs — its traffic. The row itself shows only the name, the
 * description and markers that need attention. See docs/copy-style.md ->
 * "List rows".
 */
export function serverRowTooltip(
  config: EmbeddedServerConfig,
  opts: { stats?: ServerStats; agentName?: string } = {}
): string[] {
  const out = [
    tf("server.tooltip.listen", {
      protocol: PROTOCOL_LABELS[config.serverType],
      url: serverUrl(config),
    }),
    tf("server.tooltip.root", { path: config.rootDirectory }),
  ];
  if (config.readOnly) out.push(t("server.tooltip.readOnly"));
  if (opts.agentName) out.push(tf("server.tooltip.agent", { agent: opts.agentName }));
  if (opts.stats) {
    out.push(
      tf("server.tooltip.traffic", {
        active: opts.stats.activeConnections,
        up: formatBytes(opts.stats.bytesSent, { maxUnit: "MB" }),
        down: formatBytes(opts.stats.bytesReceived, { maxUnit: "MB" }),
      })
    );
  }
  return out;
}
