/**
 * Severity mapping for monitoring percentages (CPU, memory, disk, swap, and
 * per-core CPU). Shared by the status-bar stats and the per-core mini-bars so a
 * value is coloured consistently wherever it appears.
 */
export type Severity = "normal" | "warning" | "critical";

/** Map a 0–100 percentage to its severity band. */
export function severityLevel(value: number): Severity {
  if (value >= 90) return "critical";
  if (value >= 70) return "warning";
  return "normal";
}
