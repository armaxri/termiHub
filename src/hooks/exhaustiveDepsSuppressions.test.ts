import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, relative, sep } from "path";
import { fileURLToPath } from "url";

/**
 * Hook-dependency suppression policy (#4370, WA-FE2-006).
 *
 * `react-hooks/exhaustive-deps` is an error. A deliberate omission (a
 * mount-once effect, an effect keyed on an id rather than the object) may be
 * suppressed, but only line by line and only with a reason a reviewer can
 * check: a `//` comment directly above the directive, or a `-- reason` on the
 * directive itself. Dependency-key hacks such as `[JSON.stringify(draft)]` are
 * not allowed: depend on a stable value instead (`useDeepStable`, the
 * `draft` from `useZodEditorForm`, `useWatch`).
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The most suppressions production code may hold. Lower it when one is
 * removed; raising it needs a reviewer to agree the new omission is
 * deliberate.
 */
const MAX_SUPPRESSIONS = 17;

/** Every non-test `.ts`/`.tsx` source file under `dir`. */
function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (full === join(SRC_DIR, "test")) continue;
      out.push(...productionSources(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** One `react-hooks` suppression directive found in a file. */
interface HookSuppression {
  /** 1-based line number of the directive. */
  line: number;
  /** Why it breaks the policy, or `null` when it is justified. */
  problem: string | null;
}

const DIRECTIVE = /eslint-disable(-next-line|-line)?\b[^\n]*react-hooks\//;

/** Find every `react-hooks` suppression in `source` and check its justification. */
function auditHookSuppressions(source: string): HookSuppression[] {
  const lines = source.split("\n");
  const found: HookSuppression[] = [];
  lines.forEach((text, i) => {
    const match = DIRECTIVE.exec(text);
    if (!match) return;
    const line = i + 1;
    if (match[1] !== "-next-line") {
      found.push({
        line,
        problem: "use eslint-disable-next-line, not a block or same-line disable",
      });
      return;
    }
    if (/\s--\s*\S/.test(text)) {
      found.push({ line, problem: null });
      return;
    }
    const above = (lines[i - 1] ?? "").trim();
    const justified = above.startsWith("//") && !above.includes("eslint-") && above.length > 3;
    found.push({
      line,
      problem: justified ? null : "add a one-line justification comment directly above it",
    });
  });
  return found;
}

/** Dependency lists keyed on a serialised value (`[JSON.stringify(x)]`, `[a.join(",")]`). */
const DEP_KEY_HACK = /\[\s*[^\]\n]*(JSON\.stringify\(|\.join\()[^\]\n]*\]\s*\)\s*;?\s*$/;

/** All production files, with the source-relative (posix) path. */
function sources(): { path: string; text: string }[] {
  return productionSources(SRC_DIR).map((file) => ({
    path: relative(SRC_DIR, file).split(sep).join("/"),
    text: readFileSync(file, "utf8"),
  }));
}

describe("auditHookSuppressions", () => {
  it("accepts a directive with a comment line directly above it", () => {
    const src = [
      "  useEffect(() => {}, []);",
      "  // Run once on mount: the callback identity churns.",
      "  // eslint-disable-next-line react-hooks/exhaustive-deps",
      "  }, []);",
    ].join("\n");
    expect(auditHookSuppressions(src)).toEqual([{ line: 3, problem: null }]);
  });

  it("accepts a directive with an inline -- reason", () => {
    const src = "  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id\n";
    expect(auditHookSuppressions(src)[0].problem).toBeNull();
  });

  it("rejects a bare directive", () => {
    const src = [
      "    onChange(new Set());",
      "    // eslint-disable-next-line react-hooks/exhaustive-deps",
      "  }, [path]);",
    ].join("\n");
    expect(auditHookSuppressions(src)[0].problem).toMatch(/justification/);
  });

  it("rejects a block or same-line disable", () => {
    expect(
      auditHookSuppressions("/* eslint-disable react-hooks/exhaustive-deps */")[0].problem
    ).toMatch(/next-line/);
    expect(
      auditHookSuppressions("  }, []); // eslint-disable-line react-hooks/exhaustive-deps")[0]
        .problem
    ).toMatch(/next-line/);
  });
});

describe("DEP_KEY_HACK", () => {
  it("matches a dependency list keyed on a serialised value", () => {
    expect(DEP_KEY_HACK.test("  }, [JSON.stringify(draft)]);")).toBe(true);
    expect(DEP_KEY_HACK.test('  }, [open, ids.join(",")]);')).toBe(true);
  });

  it("does not match a dependency list of real values", () => {
    expect(DEP_KEY_HACK.test("  }, [open, draft, reset]);")).toBe(false);
  });
});

describe("production react-hooks suppressions (#4370)", () => {
  it("every suppression carries a one-line justification", () => {
    const problems = sources().flatMap(({ path, text }) =>
      auditHookSuppressions(text)
        .filter((s) => s.problem !== null)
        .map((s) => `${path}:${s.line}: ${s.problem}`)
    );
    expect(problems).toEqual([]);
  });

  it(`stays at or below ${MAX_SUPPRESSIONS} suppressions`, () => {
    const count = sources().reduce((n, { text }) => n + auditHookSuppressions(text).length, 0);
    expect(count).toBeLessThanOrEqual(MAX_SUPPRESSIONS);
  });

  it("no hook dependency list is keyed on a serialised value", () => {
    const hacks = sources().flatMap(({ path, text }) =>
      text
        .split("\n")
        .map((line, i) => (DEP_KEY_HACK.test(line) ? `${path}:${i + 1}: ${line.trim()}` : null))
        .filter((hit): hit is string => hit !== null)
    );
    expect(hacks).toEqual([]);
  });
});
