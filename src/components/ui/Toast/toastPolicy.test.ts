import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, relative, sep } from "path";
import { fileURLToPath } from "url";

/**
 * Toast-policy guard (#5859).
 *
 * The design-system rule is "feedback is visible in place; toast only when it
 * isn't". A saved form that closes and shows its row, a tab that opens
 * connected, a toggle that flips, a macro typing into the visible terminal:
 * none of these raise a toast. A success or info toast is only for what the
 * user cannot see where they are looking.
 *
 * So every `toast.success(…)`, `toast.info(…)` and `toast.promise(…)` call in
 * `src/` must carry a `// toast-policy: <reason>` comment on its own line or
 * up to {@link TAG_WINDOW} lines above it, naming one of {@link REASONS}.
 * A new success toast therefore needs a written justification a reviewer can
 * check against the rule. Error and loading toasts are not covered: failures
 * always toast, and a loading toast resolves into one of the tagged calls.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The reasons a success/info toast may exist, and what each one means. */
export const REASONS = {
  /** It finished off-screen or without the user watching it. */
  background: "a transfer, scheduled/automatic run, reconnect or external request finished",
  /** It carries an Undo / Reopen action for what just went away. */
  undo: "it offers to undo what the user just did",
  /** The result has no surface in termiHub's visible UI. */
  "no-in-place-surface": "the clipboard, a file on disk, a remote machine or a sent signal",
  /** It says why an action did nothing, or ended other than asked. */
  "explains-outcome": "nothing visible changed, and the toast says why",
} as const;

/** How many lines above a toast call its tag may sit. */
const TAG_WINDOW = 3;

const CALL = /\btoast\.(success|info|promise)\(/;
const TAG = /toast-policy:\s*([a-z-]+)/;

/** Every production `.ts`/`.tsx` file under `src/`, tests and the toast layer excluded. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "test" || entry === "__mocks__") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** One success/info/promise toast call site. */
interface CallSite {
  file: string;
  line: number;
  kind: string;
  reason: string | null;
}

/** Find the toast calls of `text` and the reason tag each one carries. */
export function toastCallSites(file: string, text: string): CallSite[] {
  const lines = text.split("\n");
  const sites: CallSite[] = [];
  lines.forEach((line, i) => {
    const call = CALL.exec(line);
    if (!call) return;
    // A call inside a doc comment is prose, not a toast.
    if (/^\s*(\*|\/\/)/.test(line)) return;
    let reason: string | null = null;
    for (let j = i; j >= Math.max(0, i - TAG_WINDOW); j--) {
      const tag = TAG.exec(lines[j]);
      if (tag) {
        reason = tag[1];
        break;
      }
    }
    sites.push({ file, line: i + 1, kind: call[1], reason });
  });
  return sites;
}

const TOAST_LAYER = join(SRC_DIR, "components", "ui", "Toast");

const sites = sourceFiles(SRC_DIR)
  .filter((f) => !f.startsWith(TOAST_LAYER))
  .flatMap((f) =>
    toastCallSites(relative(SRC_DIR, f).split(sep).join("/"), readFileSync(f, "utf8"))
  );

describe("toast policy (#5859)", () => {
  it("finds the toast call sites it guards", () => {
    expect(sites.length).toBeGreaterThan(20);
  });

  it("tags every success/info toast with the reason it is not visible in place", () => {
    const untagged = sites
      .filter((s) => s.reason === null)
      .map((s) => `${s.file}:${s.line} toast.${s.kind}`);
    expect(
      untagged,
      "Add `// toast-policy: <reason>` above the call, or drop the toast and show the result " +
        `in place. Reasons: ${Object.keys(REASONS).join(", ")}`
    ).toEqual([]);
  });

  it("only uses the known reasons", () => {
    const unknown = sites
      .filter((s) => s.reason !== null && !(s.reason in REASONS))
      .map((s) => `${s.file}:${s.line} ${s.reason}`);
    expect(unknown).toEqual([]);
  });

  it("reads a tag on the call line or just above it", () => {
    const text = [
      "// toast-policy: undo",
      "toast.success('a');",
      "toast.info('b');",
      "",
      "",
      "",
      "",
      "toast.success('c'); // toast-policy: background",
      " * toast.success('in a doc comment')",
    ].join("\n");
    expect(toastCallSites("x.ts", text).map((s) => s.reason)).toEqual([
      "undo",
      "undo",
      "background",
    ]);
  });

  it("leaves a call without a nearby tag untagged", () => {
    const text = ["// toast-policy: undo", "", "", "", "", "toast.success('far');"].join("\n");
    expect(toastCallSites("x.ts", text)[0].reason).toBeNull();
  });
});
