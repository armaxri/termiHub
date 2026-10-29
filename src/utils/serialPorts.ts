import { compareNames } from "./locale";

/**
 * Natural-order comparator for serial port names: embedded numbers compare
 * numerically, so `COM3 < COM9 < COM10 < COM27` and
 * `/dev/ttyUSB2 < /dev/ttyUSB10` (#5066). Built on the shared numeric
 * `Intl.Collator` ({@link compareNames}), with a code-unit tie-break so the
 * order is total and deterministic.
 */
export function compareSerialPorts(a: string, b: string): number {
  const byName = compareNames(a, b);
  if (byName !== 0) return byName;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Return a de-duplicated, naturally ordered copy of `ports`.
 *
 * The backend already reports ports in natural order; this is applied on the
 * frontend too so a list from an older remote agent (which may report raw OS
 * enumeration order) is shown the same way.
 */
export function sortSerialPorts(ports: readonly string[]): string[] {
  return [...new Set(ports)].sort(compareSerialPorts);
}
