import { formatRate } from "@/utils/formatters";
import { MetricSparkline } from "./MetricSparkline";
import { latestValue, type MetricBlock } from "./monitoringHistoryModel";

/** Inline sparkline geometry for a compact metric row (#5628). */
const ROW_SPARK_WIDTH = 72;
const ROW_SPARK_HEIGHT = 14;

/** Props for {@link MonitoringMetricRows}. */
export interface MonitoringMetricRowsProps {
  /** The metric blocks to show; blocks without a real sample are skipped. */
  blocks: MetricBlock[];
}

/** The last-known value of a block, formatted for its unit. */
function blockValueLabel(block: MetricBlock): string {
  const latest = latestValue(block.values);
  if (latest == null) return "—";
  return block.unit === "percent" ? `${latest.toFixed(0)}%` : formatRate(latest) || "0 B/s";
}

/**
 * One compact row per metric in the host menu (#5628): label, an inline
 * mini-sparkline and the latest value. Replaces the stacked full-width charts,
 * which made the menu ~700 px tall; the larger charts stay in View history.
 */
export function MonitoringMetricRows({ blocks }: MonitoringMetricRowsProps) {
  const shown = blocks.filter((b) => b.hasData);
  if (shown.length === 0) return null;
  return (
    <div className="monitoring-menu__metrics" data-testid="monitoring-sparklines">
      {shown.map((block) => (
        <div
          key={block.key}
          className="monitoring-menu__metric"
          data-testid={`monitoring-metric-${block.key}`}
        >
          <span className="monitoring-menu__label">{block.label}</span>
          <MetricSparkline
            values={block.values}
            min={block.min}
            max={block.max}
            width={ROW_SPARK_WIDTH}
            height={ROW_SPARK_HEIGHT}
            ariaLabel={`${block.label} history`}
          />
          <span className="monitoring-menu__value">{blockValueLabel(block)}</span>
        </div>
      ))}
    </div>
  );
}
