/**
 * Regex-safety validation for user-defined highlight rules.
 *
 * Custom highlight patterns are compiled into live `RegExp`s and run against
 * every plain terminal line by the highlighting engine (`syntaxHighlighting.ts`).
 * An unbounded or catastrophically-backtracking (ReDoS) pattern would run in the
 * render loop and can freeze the terminal, so user input is validated *before*
 * it is ever saved or applied.
 *
 * The validation is layered defence:
 *   1. **Length cap** — patterns over {@link MAX_PATTERN_LENGTH} chars are rejected
 *      outright (long sources are both hard to reason about and a cheap DoS vector).
 *   2. **Compile check** — the pattern (with the same wrapping the engine applies)
 *      must compile as a `RegExp`.
 *   3. **Structural check** — deterministic detection of nested unbounded
 *      quantifiers (the `(a+)+` / `(a*)*` star-height-2 shapes that drive the vast
 *      majority of ReDoS), rejected instantly without ever executing the pattern.
 *   4. **Empirical backstop** — the compiled pattern is run against a small battery
 *      of adversarial inputs with a wall-clock budget; anything that blows the
 *      budget (e.g. overlapping-alternation shapes the structural check misses) is
 *      rejected. The separation between a safe pattern (microseconds) and a
 *      catastrophic one (many milliseconds and up) is many orders of magnitude, so
 *      this stays deterministic in practice.
 *
 * The engine additionally caps per-line length and self-disables a rule that
 * exceeds a per-line time budget at runtime (see `findMatchesGuarded`), but this
 * save-time gate is the primary protection: a bad pattern should never reach the
 * engine in the first place.
 */

/** Maximum accepted pattern source length, in characters. */
export const MAX_PATTERN_LENGTH = 500;

/** Wall-clock budget (ms) for the empirical adversarial run across all probes. */
export const ADVERSARIAL_BUDGET_MS = 30;

/** Options describing how the pattern will be compiled by the engine. */
export interface PatternValidationOptions {
  /** Matches wrapped in `\b…\b` (mirrors {@link HighlightRule.wholeWord}). */
  wholeWord?: boolean;
  /** Case-insensitive matching (mirrors `caseSensitive === false`). */
  caseSensitive?: boolean;
}

/** A validation success — the pattern is safe to compile and run. */
export interface PatternValid {
  valid: true;
}

/** A validation failure with a human-readable, user-facing reason. */
export interface PatternInvalid {
  valid: false;
  /** Short reason suitable for an inline field error. */
  reason: string;
}

/** Result of {@link validateHighlightPattern}. */
export type PatternValidation = PatternValid | PatternInvalid;

/**
 * Builds the exact regex source + flags the engine would compile for a pattern,
 * so validation checks the same thing that will actually run. Mirrors the
 * wrapping in `compileRules` (`syntaxHighlighting.ts`).
 */
export function buildRuleSource(
  pattern: string,
  options: PatternValidationOptions = {}
): { source: string; flags: string } {
  const source = options.wholeWord ? `\\b(?:${pattern})\\b` : pattern;
  const flags = options.caseSensitive === false ? "gi" : "g";
  return { source, flags };
}

/**
 * Detects nested unbounded quantifiers — the star-height ≥ 2 shapes such as
 * `(a+)+`, `(a*)*`, `(\d+)*`, `([a-z]+)+`, `((ab)+)+` — that are the classic
 * source of exponential backtracking. Deterministic and executes nothing.
 *
 * It walks the source once, tracking a stack of group frames. A frame remembers
 * whether the group's body contains an unbounded quantifier (`*`, `+`, `{n,}`).
 * When an unbounded quantifier is applied to a group that already contains one,
 * the star heights stack and the pattern is flagged.
 *
 * This is a heuristic: it deliberately errs toward the well-known dangerous
 * shapes and lets the empirical backstop catch overlap-based ReDoS it cannot see
 * structurally. It does not reject a single-level quantifier like `\d+` or `a*`.
 */
export function hasNestedQuantifier(source: string): boolean {
  interface Frame {
    /** Body of this group contains an unbounded quantifier. */
    hasUnbounded: boolean;
  }
  const stack: Frame[] = [];
  // Unbounded quantifier of the group that just closed at `)` (else null).
  let lastClosedUnbounded: boolean | null = null;

  const markEnclosingUnbounded = (): void => {
    if (stack.length > 0) stack[stack.length - 1].hasUnbounded = true;
  };

  const isUnboundedQuantAt = (i: number): boolean => {
    const ch = source[i];
    if (ch === "*" || ch === "+") return true;
    if (ch === "{") {
      // Open-ended `{n,}` is unbounded; `{n}` / `{n,m}` are bounded.
      const close = source.indexOf("}", i);
      if (close === -1) return false;
      const body = source.slice(i + 1, close);
      return /^\d*,\s*$/.test(body) && body.includes(",");
    }
    return false;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (ch === "\\") {
      // Escaped atom; the next char is literal. It resets "last closed group".
      i++;
      lastClosedUnbounded = null;
      continue;
    }

    if (ch === "[") {
      // Character class: skip to the matching `]`, honouring escapes.
      let j = i + 1;
      while (j < source.length && source[j] !== "]") {
        if (source[j] === "\\") j++;
        j++;
      }
      i = j;
      lastClosedUnbounded = null;
      continue;
    }

    if (ch === "(") {
      stack.push({ hasUnbounded: false });
      lastClosedUnbounded = null;
      continue;
    }

    if (ch === ")") {
      const frame = stack.pop();
      lastClosedUnbounded = frame ? frame.hasUnbounded : null;
      continue;
    }

    if (isUnboundedQuantAt(i)) {
      // A group that already contained an unbounded quantifier is now itself
      // unbounded-quantified -> nested / stacked star height.
      if (lastClosedUnbounded === true) return true;
      // This quantifier makes the enclosing group unbounded.
      markEnclosingUnbounded();
      // Advance past a multi-char `{n,}` quantifier so its digits/comma are not
      // re-scanned as atoms.
      if (ch === "{") {
        const close = source.indexOf("}", i);
        if (close !== -1) i = close;
      }
      lastClosedUnbounded = null;
      continue;
    }

    // Any other atom (literal, `.`, etc.) resets the just-closed-group memory.
    lastClosedUnbounded = null;
  }

  return false;
}

/**
 * Runs a compiled pattern against a battery of adversarial inputs and reports
 * whether the total wall-clock time exceeds `budgetMs`. Catches ReDoS shapes the
 * structural check misses (e.g. overlapping alternation `(a|a)+`).
 *
 * The probes are built from characters that appear in the pattern so that the
 * pattern actually engages with them, each a long run followed by a
 * non-matching sentinel that forces maximal backtracking.
 */
export function exceedsAdversarialBudget(
  source: string,
  flags: string,
  budgetMs = ADVERSARIAL_BUDGET_MS,
  nowFn: () => number = defaultNow
): boolean {
  let regex: RegExp;
  try {
    regex = new RegExp(source, flags);
  } catch {
    return false; // compile errors are handled elsewhere
  }

  const probes = buildAdversarialInputs(source);
  const start = nowFn();
  for (const input of probes) {
    regex.lastIndex = 0;
    // A single exec cannot be interrupted; the input lengths are chosen so a
    // catastrophic pattern clearly overruns the budget while a safe one stays in
    // the microsecond range.
    regex.test(input);
    if (nowFn() - start > budgetMs) return true;
  }
  return false;
}

/** Characters worth stress-testing, seeded from the pattern's own literals. */
function adversarialAlphabet(source: string): string[] {
  const chars = new Set<string>();
  for (const ch of source) {
    if (/[a-zA-Z0-9]/.test(ch)) chars.add(ch);
  }
  // Always include a couple of generic characters so `.`/class-only patterns are
  // still exercised.
  chars.add("a");
  chars.add("0");
  return [...chars].slice(0, 4);
}

/** Adversarial inputs: long single-char runs plus a failing sentinel. */
function buildAdversarialInputs(source: string): string[] {
  const inputs: string[] = [];
  // ~20 repeats is deliberately modest: an exponential pattern still overruns the
  // budget by an order of magnitude (hundreds of ms) yet the worst-case single
  // exec stays bounded (~2^20 steps), so the validator never hangs. A linear
  // pattern stays sub-millisecond.
  const runLength = 20;
  for (const ch of adversarialAlphabet(source)) {
    inputs.push(ch.repeat(runLength) + "!");
    inputs.push(ch.repeat(runLength) + " ");
  }
  return inputs;
}

/**
 * Validates a user-entered highlight pattern for safety. Returns `{ valid: true }`
 * for a pattern that is safe to compile and run, or `{ valid: false, reason }`
 * with a user-facing message otherwise.
 *
 * Checks, in order: non-empty, length cap, compiles, no nested unbounded
 * quantifiers, and not empirically catastrophic on adversarial input.
 */
export function validateHighlightPattern(
  pattern: string,
  options: PatternValidationOptions = {}
): PatternValidation {
  if (pattern.length === 0) {
    return { valid: false, reason: "Pattern must not be empty." };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      valid: false,
      reason: `Pattern is too long (max ${MAX_PATTERN_LENGTH} characters).`,
    };
  }

  const { source, flags } = buildRuleSource(pattern, options);

  try {
    void new RegExp(source, flags);
  } catch (err) {
    return { valid: false, reason: `Invalid regular expression: ${describeError(err)}` };
  }

  if (hasNestedQuantifier(source)) {
    return {
      valid: false,
      reason: "Pattern may cause catastrophic backtracking (nested quantifiers).",
    };
  }

  if (exceedsAdversarialBudget(source, flags)) {
    return {
      valid: false,
      reason: "Pattern is too slow on adversarial input (possible ReDoS).",
    };
  }

  return { valid: true };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    // Strip the noisy "Invalid regular expression: /…/: " prefix engines add.
    return err.message.replace(/^Invalid regular expression:[^:]*:\s*/, "");
  }
  return String(err);
}

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}
