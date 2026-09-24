import { useMemo } from "react";
import { LineChart } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatRate } from "@/utils/formatters";
import type { MonitorHistories } from "@/store/useMonitorHistory";
import { MetricSparkline } from "./MetricSparkline";
import { buildMetricBlocks, latestValue, type MetricBlock } from "./monitoringHistoryModel";
import "./StatusBar.css";

/** Props for {@link MonitoringHistoryPanel}. */
export interface MonitoringHistoryPanelProps {
  /** Whether the panel is open (controlled). */
  open: boolean;
  /** Called with the next open state (Radix fires `false` on ESC / close / scrim click). */
  onOpenChange: (open: boolean) => void;
  /** Host label shown in the panel title, or `null` when unknown. */
  host: string | null;
  /** Rolling per-metric history for the active monitor. */
  histories: MonitorHistories;
}

/** Chart height (px) for a panel metric — taller than the dropdown sparkline. */
const PANEL_CHART_HEIGHT = 64;

/** Format a block's latest value for its header read-out. */
function formatLatest(block: MetricBlock): string {
  const latest = latestValue(block.values);
  if (latest == null) return "—";
  if (block.unit === "percent") return `${latest.toFixed(0)}%`;
  return formatRate(latest) || "0 B/s";
}

/**
 * A dedicated monitoring history panel (PROD-0030). Renders small time-series
 * charts for the active host's key metrics — CPU, memory, swap (when present),
 * and network throughput (down/up) — over the client-side rolling window
 * reconstructed by {@link import("@/store/useMonitorHistory").useMonitorHistory}.
 *
 * Composed from the shared {@link Modal} and {@link MetricSparkline} primitives.
 * Each metric renders its chart only once it has a real sample; a just-connected
 * (or fully idle) monitor shows a loading empty-state instead of broken charts.
 */
export function MonitoringHistoryPanel({
  open,
  onOpenChange,
  host,
  histories,
}: MonitoringHistoryPanelProps) {
  const blocks = useMemo(() => buildMetricBlocks(histories), [histories]);
  const anyData = blocks.some((b) => b.hasData);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={host ? `Monitoring history — ${host}` : "Monitoring history"}
      description="Time-series charts of the active host's system metrics over the recent rolling window."
      size="lg"
      data-testid="monitoring-history-panel"
    >
      {!anyData ? (
        <EmptyState
          loading
          title="Collecting metrics…"
          description="History appears once the monitor has reported a few samples."
          data-testid="monitoring-history-empty"
        />
      ) : (
        <div className="monitoring-history">
          {blocks.map((block) => (
            <div
              key={block.key}
              className="monitoring-history__block"
              data-testid={`monitoring-history-${block.key}`}
            >
              <div className="monitoring-history__header">
                <span className="monitoring-history__label">{block.label}</span>
                <span className="monitoring-history__value">{formatLatest(block)}</span>
              </div>
              {block.hasData ? (
                <MetricSparkline
                  values={block.values}
                  min={block.min}
                  max={block.max}
                  height={PANEL_CHART_HEIGHT}
                  ariaLabel={`${block.label} history`}
                />
              ) : (
                <div className="monitoring-history__pending" role="status">
                  <LineChart size={14} aria-hidden="true" />
                  Waiting for data…
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
