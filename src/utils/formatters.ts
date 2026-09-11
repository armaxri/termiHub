import { resolveUiLocale } from "@/utils/locale";

/**
 * Format a byte count to a human-readable string.
 *
 * Guarded against a missing/invalid input: `undefined`, `null`, `NaN`, a
 * non-finite value, or a negative count all yield an empty string rather than
 * the old `"NaN GB"` (#2798) — call sites can treat `""` as "size unknown" and
 * render nothing. A real `0` still formats as `"0 B"`.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Format date to locale-aware relative string */
export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(resolveUiLocale());
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
