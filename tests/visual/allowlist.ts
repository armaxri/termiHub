/**
 * Known layout bugs the rendered visual checks (#4712) tolerate until their fix
 * lands. Every entry MUST name the open issue that owns the fix; delete the
 * entry in that fix's PR. An entry that no longer matches anything is reported
 * as a warning annotation so stale entries are easy to spot.
 */

import type { LayoutIssue } from "./layoutAudit";

export interface AllowEntry {
  /** Issue that owns the fix. */
  issue: number;
  /** Which assertion this tolerates. */
  kind: LayoutIssue["kind"];
  /** Matches the surface id, e.g. `sidebar/workspaces@min` or `dialog/unlock`. */
  surface: RegExp;
  /** Matches `"<where> — <detail>"` of the issue. */
  match: RegExp;
}

export const ALLOWLIST: AllowEntry[] = [];

/** The allowlist entry covering `issue` on `surface`, if any. */
export function allowedBy(surface: string, issue: LayoutIssue): AllowEntry | undefined {
  const text = `${issue.where} — ${issue.detail}`;
  return ALLOWLIST.find(
    (e) => e.kind === issue.kind && e.surface.test(surface) && e.match.test(text)
  );
}
