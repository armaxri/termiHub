/**
 * Severity mapping for monitoring percentages (CPU, memory, disk, swap, and
 * per-core CPU). The per-core mini-bars use {@link severityLevel}; the ambient
 * status-bar stats use the stricter {@link statusStatSeverity} (#5563).
 */
export type Severity = "normal" | "warning" | "critical";

/**
 * Map a 0–100 percentage to its severity band. Used where the value is being
 * inspected on purpose (the per-core bars in the monitoring menu), so the
 * warning band starts early.
 */
export function severityLevel(value: number): Severity {
  if (value >= 90) return "critical";
  if (value >= 70) return "warning";
  return "normal";
}

/**
 * Status-bar severity (#5563). The status bar is ambient chrome: colour there
 * must flag something actionable, or users learn to ignore it. A disk at 78% or
 * swap at 82% on an idle Mac is normal, so stats stay in the muted status-bar
 * text colour and are coloured only near exhaustion.
 */
export const STATUS_STAT_WARNING_PERCENT = 90;
/** Status-bar critical threshold (#5563). */
export const STATUS_STAT_CRITICAL_PERCENT = 95;

/** Map a 0–100 percentage to its status-bar severity band (#5563). */
export function statusStatSeverity(value: number): Severity {
  if (value >= STATUS_STAT_CRITICAL_PERCENT) return "critical";
  if (value >= STATUS_STAT_WARNING_PERCENT) return "warning";
  return "normal";
}
