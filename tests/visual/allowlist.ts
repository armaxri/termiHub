/**
 * Known layout bugs the rendered visual checks (#4712) tolerate until their fix
 * lands. Every entry MUST name the open issue that owns the fix; that fix's PR
 * deletes the entry. After a full run, globalTeardown.ts warns about every entry
 * no test used, so stale entries are easy to spot.
 *
 * `VISUAL_STRICT=1 pnpm test:visual` ignores this list, which shows exactly
 * what each entry is hiding; `VISUAL_STRICT=4708,4710` ignores only the entries
 * of those issues (how a fix PR proves its fix before deleting its entries).
 */

import type { LayoutIssue } from "./layoutAudit";

export interface AllowEntry {
  /** Open issue that owns the fix. */
  issue: number;
  /** Which assertion this tolerates. */
  kind: LayoutIssue["kind"];
  /** Matches the surface id, e.g. `sidebar/workspaces@min` or `dialog/unlock`. */
  surface: RegExp;
  /** Matches `"<where> — <detail>"` of the issue. */
  match: RegExp;
}

export const ALLOWLIST: AllowEntry[] = [
  {
    // Five or six hover actions overlay the whole name of a tunnel or service
    // row at the minimum sidebar width, so its tooltip cannot be reached.
    issue: 4972,
    kind: "expectation",
    surface: /^rows\/(tunnel|service)@min$/,
    match: /the start of the cut name cannot be hovered/,
  },
];

const STRICT = (process.env.VISUAL_STRICT ?? "").split(",").filter(Boolean);

/** Whether `VISUAL_STRICT` switches this entry off. */
function ignored(entry: AllowEntry): boolean {
  return STRICT.includes("1") || STRICT.includes(String(entry.issue));
}

/** The allowlist entry covering `issue` on `surface`, if any. */
export function allowedBy(surface: string, issue: LayoutIssue): AllowEntry | undefined {
  const text = `${issue.where} — ${issue.detail}`;
  return ALLOWLIST.find(
    (e) => !ignored(e) && e.kind === issue.kind && e.surface.test(surface) && e.match.test(text)
  );
}
