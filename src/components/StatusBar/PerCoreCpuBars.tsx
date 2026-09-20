import { severityLevel } from "./monitoringSeverity";

interface PerCoreCpuBarsProps {
  /**
   * Per-logical-core CPU usage percentage (0–100), one entry per core in core
   * order. When empty the component renders nothing — a non-Linux SSH remote or
   * an older agent supplies no per-core data (#3178).
   */
  values: number[];
}

/**
 * Compact per-core CPU mini-bars for the monitoring dropdown (#3178).
 *
 * Renders one vertical bar per core, its height encoding that core's usage and
 * its colour the severity band, so a many-core host shows its load distribution
 * at a glance without enlarging the dropdown. Renders `null` when no per-core
 * data is available, leaving hosts without it unaffected.
 */
export function PerCoreCpuBars({ values }: PerCoreCpuBarsProps) {
  if (values.length === 0) return null;
  return (
    <div className="monitoring-menu__cores" data-testid="monitoring-per-core">
      <div className="monitoring-menu__spark-header">
        <span className="monitoring-menu__label">Cores</span>
        <span className="monitoring-menu__value">{values.length}</span>
      </div>
      <div className="monitoring-menu__cores-grid">
        {values.map((pct, i) => {
          const clamped = Math.min(100, Math.max(0, pct));
          return (
            <div
              key={i}
              className="monitoring-menu__core"
              title={`Core ${i}: ${pct.toFixed(0)}%`}
              data-testid={`monitoring-core-${i}`}
            >
              <div className="monitoring-menu__core-track">
                <div
                  className={`monitoring-menu__core-fill monitoring-menu__core-fill--${severityLevel(
                    pct
                  )}`}
                  style={{ height: `${clamped}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
