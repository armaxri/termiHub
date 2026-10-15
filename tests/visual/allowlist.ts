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

/** The narrow-sidebar surfaces #4709 owns. */
const NARROW_SIDEBARS = /^sidebar\/(connections|macros|workflows|workspaces)@/;

export const ALLOWLIST: AllowEntry[] = [
  // #4708: shared settings field CSS lives in the lazy ConnectionEditor chunk.
  { issue: 4708, kind: "unstyled-class", surface: /^settings\//, match: /\.settings-form__/ },
  {
    issue: 4708,
    kind: "text-overlap",
    surface: /^settings\/appearance$/,
    match: /settings-form__hint/,
  },
  // #4709: sidebar toolbars clip, names truncate, the Schedules header overflows.
  { issue: 4709, kind: "clipped-control", surface: NARROW_SIDEBARS, match: /./ },
  { issue: 4709, kind: "overflow", surface: NARROW_SIDEBARS, match: /./ },
  { issue: 4709, kind: "truncated-text", surface: NARROW_SIDEBARS, match: /./ },
  // #4710: the description sits on the password field's focus ring.
  {
    issue: 4710,
    kind: "text-overlap",
    surface: /^dialog\/(unlock|password-prompt)$/,
    match: /focus ring/,
  },
  // #4711: two platform columns, and the overlay's unkeyed fragments warn at boot.
  { issue: 4711, kind: "expectation", surface: /^dialog\/shortcuts$/, match: /shortcut column/ },
  { issue: 4711, kind: "console-error", surface: /./, match: /unique "key" prop/ },
  // #4728: the External Files header pushes its add button off-screen at 800x600.
  {
    issue: 4728,
    kind: "clipped-control",
    surface: /^settings\/external-files$/,
    match: /external-files-add/,
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
