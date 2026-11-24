/**
 * The short display name of a serial device (#5831, R-072): the last segment of
 * its path (`/dev/ttyPR0` → `ttyPR0`, `\\.\COM10` → `COM10`). The full path
 * goes in a tooltip.
 */
export function serialDeviceName(path: string): string {
  const trimmed = path.trim();
  const name = trimmed.split(/[\\/]/).filter(Boolean).pop();
  return name ?? trimmed;
}
