/**
 * User-facing copy for why a system monitor went offline (#3301).
 *
 * The backend carries a typed {@link MonitorStatusReason} with each collector
 * status, so the UI can tell a remote that answers with unreadable output apart
 * from a lost connection instead of always saying "connection lost".
 */

import type { MonitorStatus, MonitorStatusReason } from "@/types/monitoring";

/**
 * Short, lowercase phrase describing why a monitor is offline, e.g.
 * "remote output unreadable". A missing reason (an older backend, or a status
 * that carries none) reads as the historical "connection lost".
 */
export function monitorOfflineReasonText(reason: MonitorStatusReason | null | undefined): string {
  switch (reason) {
    case "parse":
      return "remote output unreadable";
    case "silent":
      return "no data from agent";
    case "unsupported":
      return "monitoring unavailable on this host";
    case "transport":
    default:
      return "connection lost";
  }
}

/**
 * Sentence-case offline label, e.g. "Offline — remote output unreadable".
 *
 * A host with no stats source (#5471) is not offline: the connection is fine,
 * there is just nothing to read. It gets its own label instead.
 */
export function monitorOfflineLabel(reason: MonitorStatusReason | null | undefined): string {
  if (reason === "unsupported") return "Monitoring unavailable on this host";
  return `Offline — ${monitorOfflineReasonText(reason)}`;
}

/**
 * Whether a monitor ended because the host has no stats source (#5471). That
 * is a permanent capability state, not a failure: the UI shows it as muted
 * info and offers no Retry, which could only fail the same way (#5628).
 */
export function isMonitorUnsupported(
  status: MonitorStatus | null | undefined,
  reason: MonitorStatusReason | null | undefined
): boolean {
  return status === "offline" && reason === "unsupported";
}

/** Tooltip explaining why monitoring is unavailable on a host (#5628). */
export function monitorUnsupportedTooltip(): string {
  return (
    "This host has no stats source termiHub can read: it could not run a POSIX sh " +
    "script over this connection. The terminal session is not affected."
  );
}
