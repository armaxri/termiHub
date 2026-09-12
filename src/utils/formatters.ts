import { resolveUiLocale } from "@/utils/locale";

/**
 * Format a number for display using the app's resolved UI locale
 * ({@link resolveUiLocale}), so the decimal separator and digit grouping follow
 * the user's locale (e.g. `1,024.0` in `en-US`, `1.024,0` in `de-DE`) instead of
 * an unconditional English `.`-decimal / no-grouping `.toFixed()`.
 *
 * `resolveUiLocale()` is always a valid BCP-47 tag, so the `Intl.NumberFormat`
 * constructor can never throw on a `C`/`POSIX` locale — see `utils/locale.ts`.
 * Passing `navigator.language` raw here would reintroduce that crash (#2646).
 */
function formatNumber(value: number, minFractionDigits: number, maxFractionDigits: number): string {
  return new Intl.NumberFormat(resolveUiLocale(), {
    minimumFractionDigits: minFractionDigits,
    maximumFractionDigits: maxFractionDigits,
  }).format(value);
}

/** Binary byte-size units, ascending. Also the `maxUnit` cap values. */
const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;
/** A binary byte-size unit label. */
export type ByteUnit = (typeof BYTE_UNITS)[number];

/** Options for {@link formatBytes}. */
export interface FormatBytesOptions {
  /**
   * Largest unit to scale up to. Defaults to `"GB"`. Pass `"MB"` to cap the
   * readout at megabytes (e.g. the embedded-server stats line, which never wants
   * a `GB` suffix).
   */
  maxUnit?: ByteUnit;
}

/**
 * Format a byte count to a human-readable, locale-aware string.
 *
 * The unit label (`B`/`KB`/`MB`/`GB`) stays as-is, but the numeric part is
 * rendered through the shared locale-aware {@link formatNumber} so grouping and
 * the decimal separator follow the UI locale. Bytes are shown as a whole number;
 * larger units keep one fractional digit (`1.5 KB`, `5.0 MB`).
 *
 * Guarded against a missing/invalid input: `undefined`, `null`, `NaN`, a
 * non-finite value, or a negative count all yield an empty string rather than
 * the old `"NaN GB"` (#2798) — call sites can treat `""` as "size unknown" and
 * render nothing. A real `0` still formats as `"0 B"`.
 */
export function formatBytes(
  bytes: number | null | undefined,
  options: FormatBytesOptions = {}
): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  const maxIndex = options.maxUnit ? BYTE_UNITS.indexOf(options.maxUnit) : BYTE_UNITS.length - 1;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < maxIndex) {
    value /= 1024;
    unit += 1;
  }
  // Bytes: integer. Larger units: exactly one fractional digit (keeps "5.0 MB").
  const digits = unit === 0 ? 0 : 1;
  return `${formatNumber(value, digits, digits)} ${BYTE_UNITS[unit]}`;
}

/** Binary byte-rate units, ascending. */
const RATE_UNITS = ["B/s", "KB/s", "MB/s", "GB/s"] as const;

/**
 * Format a byte/sec throughput as a compact, locale-aware human-readable rate
 * (e.g. `112 KB/s`). Returns an empty string for a missing or non-positive rate
 * so callers can render nothing.
 *
 * Precision is adaptive: the base unit (`B/s`) and any value `>= 100` are shown
 * as a whole number; smaller scaled values keep up to one fractional digit but
 * drop a trailing zero (`1 KB/s`, `1.5 KB/s`) — matching the transfer-queue
 * readout this consolidates.
 */
export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "";
  let value = bytesPerSec;
  let unit = 0;
  while (value >= 1024 && unit < RATE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const maxDigits = value >= 100 || unit === 0 ? 0 : 1;
  return `${formatNumber(value, 0, maxDigits)} ${RATE_UNITS[unit]}`;
}

/**
 * Format an elapsed duration in whole seconds as a compact readout: `5s`,
 * `1m 05s`. Shared home for the terminal connection overlay's elapsed timer.
 *
 * Kept as literal digits (not locale-formatted): the values are single/double
 * digit counts with an intentional zero-padded `mm ss` shape, where locale
 * grouping/decimals do not apply.
 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

/** Options for {@link formatRelativeTime} / {@link formatRelativeAgo}. */
export interface RelativeTimeOptions {
  /**
   * Include second-level granularity for very recent times (`"5s ago"`).
   * Defaults to minute resolution, where anything under a minute reads
   * `"just now"`.
   */
  seconds?: boolean;
}

/**
 * Format a positive elapsed span (in ms) as a compact `"N<unit> ago"` label.
 *
 * The English wording (`just now`, `5m ago`, `2h ago`, `1d ago`) is deliberately
 * kept rather than switched to `Intl.RelativeTimeFormat`: the values are small
 * integers with no grouping or decimals, so locale number formatting adds nothing
 * here, while `RelativeTimeFormat`'s longer phrasing ("5 minutes ago") would
 * churn the compact status-bar/sidebar readouts and their tests for no i18n gain.
 * Negative spans (clock skew) clamp to `"just now"`.
 */
export function formatRelativeAgo(elapsedMs: number, options: RelativeTimeOptions = {}): string {
  const secs = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (options.seconds) {
    if (secs < 2) return "just now";
    if (secs < 60) return `${secs}s ago`;
  }
  const mins = Math.floor(secs / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format a date to a locale-aware relative string. Recent times read as a compact
 * `"N<unit> ago"` (see {@link formatRelativeAgo}); anything a week or more in the
 * past falls back to a locale-formatted absolute date.
 */
export function formatRelativeTime(dateString: string, options: RelativeTimeOptions = {}): string {
  const date = new Date(dateString);
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays >= 7) return date.toLocaleDateString(resolveUiLocale());
  return formatRelativeAgo(diffMs, options);
}

/**
 * Format a date to a full, localized absolute timestamp (date + time), suitable
 * for a hover `title` next to the coarser {@link formatRelativeTime} label
 * (#2798). Returns an empty string for a missing or unparseable input so callers
 * can omit the tooltip rather than show `"Invalid Date"`.
 */
export function formatAbsoluteTime(dateString: string | null | undefined): string {
  if (!dateString) return "";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(resolveUiLocale());
}

/** Extract the final path segment (file name) from a POSIX or Windows path. */
export function getBasename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Truncate string with ellipsis */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + "\u2026";
}
