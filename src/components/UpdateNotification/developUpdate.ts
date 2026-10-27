import type { UpdateInfo } from "@/types/connection";
import { resolveUiLocale } from "@/utils/locale";

/** Headline shown when a newer develop build than the running one exists. */
export const DEVELOP_UPDATE_TITLE = "A newer develop build is available";

/** Whether an update result came from the develop-build channel (#5023). */
export function isDevelopUpdate(info: UpdateInfo | null | undefined): boolean {
  return info?.channel === "develop";
}

/** Format an RFC 3339 timestamp for display; falls back to the raw string. */
function formatBuildDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(resolveUiLocale(), { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Describe the newer develop build: "built <date> from <short sha>". Either part
 * is omitted when the backend did not report it.
 */
export function describeDevelopBuild(info: UpdateInfo): string {
  const parts: string[] = [];
  if (info.buildPublishedAt) parts.push(`built ${formatBuildDate(info.buildPublishedAt)}`);
  const commit = info.buildCommit ?? info.latestVersion;
  if (commit) parts.push(`from ${commit}`);
  return parts.join(" ");
}

/** Upper-case the first character of a sentence fragment. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Full one-line develop notice, e.g. for tooltips. */
export function developUpdateSummary(info: UpdateInfo): string {
  const detail = describeDevelopBuild(info);
  return detail ? `${DEVELOP_UPDATE_TITLE} — ${detail}` : DEVELOP_UPDATE_TITLE;
}
