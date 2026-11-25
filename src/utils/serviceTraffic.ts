/** The lines of a service's tooltip that both kinds share (#6068). */
import { t, tf } from "@/i18n/catalog";
import { formatBytes, formatRate } from "@/utils/formatters";

/** Counters of a running service. */
interface Traffic {
  bytesSent: number;
  bytesReceived: number;
  activeConnections: number;
  totalConnections: number;
}

/** "1 connection now, 3 in all · sent 2.0 KB · received 8.0 KB", with the rates if known. */
export function serviceTrafficLine(
  stats: Traffic,
  upRate?: number | null,
  downRate?: number | null
): string {
  const amount = (bytes: number, rate: number | null | undefined) => {
    const perSecond = formatRate(rate ?? null);
    return formatBytes(bytes) + (perSecond ? ` (${perSecond})` : "");
  };
  const { activeConnections: active } = stats;
  return tf("service.tooltip.traffic", {
    active:
      active === 1
        ? t("service.tooltip.connection")
        : tf("service.tooltip.connections", { count: String(active) }),
    total: String(stats.totalConnections),
    up: amount(stats.bytesSent, upRate),
    down: amount(stats.bytesReceived, downRate),
  });
}

/** `text` with loopback addresses in the word the row uses. */
export function localhostIn(text: string): string {
  return text.replace(/(?<![\d.])127\.0\.0\.1(?![\d.])/g, "localhost");
}
