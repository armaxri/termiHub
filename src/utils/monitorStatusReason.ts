/**
 * User-facing copy for why a system monitor went offline (#3301).
 *
 * The backend carries a typed {@link MonitorStatusReason} with each collector
 * status, so the UI can tell a remote that answers with unreadable output apart
 * from a lost connection instead of always saying "connection lost".
 */

import type { MonitorStatusReason } from "@/types/monitoring";

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
    case "transport":
    default:
      return "connection lost";
  }
}

/** Sentence-case offline label, e.g. "Offline — remote output unreadable". */
export function monitorOfflineLabel(reason: MonitorStatusReason | null | undefined): string {
  return `Offline — ${monitorOfflineReasonText(reason)}`;
}
