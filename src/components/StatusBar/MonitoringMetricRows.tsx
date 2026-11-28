import { formatRate } from "@/utils/formatters";
import { MetricSparkline } from "./MetricSparkline";
import { severityLevel } from "./monitoringSeverity";
import { alignBlockStarts, latestValue, type MetricBlock } from "./monitoringHistoryModel";

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
 * A percentage as a usage bar filled to its latest value (#6183, states-3): it
 * reads from the first sample, where a row-sized sparkline drew the same flat
 * rule for every value. It takes the per-core bars' tones.
 */
function UsageBar({ block }: { block: MetricBlock }) {
  const latest = latestValue(block.values) ?? 0;
  const value = Math.max(0, Math.min(100, latest));
  return (
    <span
      className="monitoring-menu__usage"
      role="meter"
      aria-label={`${block.label} usage`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
    >
      <span
        className={`monitoring-menu__usage-fill monitoring-menu__core-fill--${severityLevel(value)}`}
        style={{ width: `${value}%` }}
      />
    </span>
  );
}

/**
 * One compact row per metric in the host menu (#5628): label, a usage bar for
 * a percentage or an inline mini-sparkline for a rate, and the latest value. Replaces the stacked full-width charts,
 * which made the menu ~700 px tall; the larger charts stay in View history. The
 * lines share one start so they read on one time axis (#5840).
 */
export function MonitoringMetricRows({ blocks }: MonitoringMetricRowsProps) {
  // One shared start column for every line (#5840): rate metrics prime a sample late.
  const shown = alignBlockStarts(blocks.filter((b) => b.hasData));
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
          {block.unit === "percent" ? (
            <UsageBar block={block} />
          ) : (
            <MetricSparkline
              values={block.values}
              min={block.min}
              max={block.max}
              width={ROW_SPARK_WIDTH}
              height={ROW_SPARK_HEIGHT}
              ariaLabel={`${block.label} history`}
            />
          )}
          <span className="monitoring-menu__value">{blockValueLabel(block)}</span>
        </div>
      ))}
    </div>
  );
}
