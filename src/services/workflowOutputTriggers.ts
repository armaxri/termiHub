/**
 * On-output-match workflow triggers (PROD-041, #3791): validation of the
 * authored pattern and the bounded, batched matcher that watches terminal
 * output and fires bound workflows.
 *
 * **Why this runs on the frontend, off the render path.** The terminal output
 * for every session already reaches this window as `terminal-output` events,
 * and the workflow run that a match launches is a frontend concern (it types
 * into a tab this window owns). Matching here avoids a second backend → UI
 * signal and keeps the backend session code untouched. To keep it from adding
 * work to the output hot path:
 *
 * - The {@link OutputTriggerEngine.enqueue} tap does O(1) work per chunk: it
 *   stores a reference to the still-encoded chunk. It is only installed while
 *   at least one valid on-output-match trigger exists.
 * - Decoding, ANSI stripping and matching run later, in one batch per
 *   {@link OUTPUT_TRIGGER_LIMITS.batchMs} window, never inside the event
 *   callback that feeds xterm.
 * - Every buffer is bounded: pending chunks per session, the scanned text per
 *   batch, and the tail carried across batches. A noisy stream therefore costs
 *   a fixed amount of work per batch, however much it prints.
 * - Patterns are bounded at compile time: a maximum length, and regexes with
 *   nested quantifiers or backreferences (the catastrophic-backtracking
 *   shapes) are rejected. Combined with the bounded scan window, one match
 *   attempt has a fixed worst case.
 * - Firing is bounded per trigger and session by a cooldown and a max-fires
 *   limit, both clamped to the ranges in {@link OUTPUT_TRIGGER_LIMITS}.
 */
import type { Workflow, WorkflowTrigger } from "@/types/workflow";

/** Safety limits of the on-output-match trigger. */
export const OUTPUT_TRIGGER_LIMITS = {
  /** Longest accepted pattern (characters). */
  maxPatternLength: 256,
  /** Cooldown applied when the trigger sets none (ms). */
  defaultCooldownMs: 10_000,
  /** Shortest accepted cooldown (ms): a match can never re-fire faster. */
  minCooldownMs: 1_000,
  /** Longest accepted cooldown (ms). */
  maxCooldownMs: 24 * 60 * 60 * 1000,
  /** Max fires per session when the trigger sets none. */
  defaultMaxFiresPerSession: 5,
  /** Highest accepted max-fires-per-session. */
  maxMaxFiresPerSession: 100,
  /** Characters of output scanned per session per batch (the newest win). */
  scanChars: 16_384,
  /** Characters carried into the next batch so a match can span two batches. */
  tailChars: 1_024,
  /** Encoded characters of pending output kept per session between batches. */
  maxPendingChars: 65_536,
  /** How often pending output is matched (ms). */
  batchMs: 100,
} as const;

/** Why an on-output-match pattern was rejected. */
export type OutputPatternError = "empty" | "too-long" | "invalid-regex" | "unsafe-regex";

/**
 * A regex group that contains a quantifier and is itself quantified, e.g.
 * `(a+)+`, `(.*)*`, `(x+){2,}` — the classic catastrophic-backtracking shape.
 * Only unnested groups are inspected; that is enough for the realistic cases
 * and errs towards rejecting.
 */
const NESTED_QUANTIFIER_RE =
  /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/;

/** A numbered or named backreference (`\1`, `\k<name>`). */
const BACKREFERENCE_RE = /\\(?:[1-9]|k<)/;

/**
 * Validate an on-output-match pattern. Returns `null` when it is usable, or the
 * reason it is not. A literal is only checked for emptiness and length; a regex
 * must also compile and avoid the unbounded-backtracking shapes.
 */
export function validateOutputPattern(
  pattern: string,
  isRegex: boolean | undefined
): OutputPatternError | null {
  if (pattern.length === 0) return "empty";
  if (pattern.length > OUTPUT_TRIGGER_LIMITS.maxPatternLength) return "too-long";
  if (!isRegex) return null;
  try {
    new RegExp(pattern);
  } catch {
    return "invalid-regex";
  }
  if (NESTED_QUANTIFIER_RE.test(pattern) || BACKREFERENCE_RE.test(pattern)) {
    return "unsafe-regex";
  }
  return null;
}

/** Clamp an authored cooldown to the accepted range (absent → default). */
export function clampCooldownMs(value: number | undefined): number {
  const { defaultCooldownMs, minCooldownMs, maxCooldownMs } = OUTPUT_TRIGGER_LIMITS;
  if (value === undefined || !Number.isFinite(value)) return defaultCooldownMs;
  return Math.min(maxCooldownMs, Math.max(minCooldownMs, Math.round(value)));
}

/** Clamp an authored max-fires-per-session to `[1, max]` (absent → default). */
export function clampMaxFires(value: number | undefined): number {
  const { defaultMaxFiresPerSession, maxMaxFiresPerSession } = OUTPUT_TRIGGER_LIMITS;
  if (value === undefined || !Number.isFinite(value)) return defaultMaxFiresPerSession;
  return Math.min(maxMaxFiresPerSession, Math.max(1, Math.round(value)));
}

/**
 * Strips the common ANSI/VT escape sequences (CSI/SGR and friends) so a
 * pattern matches the visible text, not the control codes. Mirrors the
 * `wait-for-output` step's stripper; `no-control-regex` is disabled because
 * matching the escape introducer is exactly the intent.
 */
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/** Remove ANSI escape sequences from terminal text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

/** One compiled, valid on-output-match trigger. */
export interface CompiledOutputTrigger {
  /** Stable key of the trigger: `<workflowId>#<triggerIndex>`. */
  key: string;
  /** The workflow the trigger launches. */
  workflowId: string;
  /** Connection ids the trigger is bound to. */
  connectionIds: ReadonlySet<string>;
  /** Whether `text` contains a match. */
  test: (text: string) => boolean;
  /** Clamped minimum time between two fires in one session (ms). */
  cooldownMs: number;
  /** Clamped maximum number of fires per session. */
  maxFires: number;
}

/**
 * Compile every valid, connection-bound on-output-match trigger of
 * `workflows`. Invalid patterns and triggers bound to no connection are
 * skipped, so a bad trigger can never fire.
 */
export function compileOutputTriggers(workflows: readonly Workflow[]): CompiledOutputTrigger[] {
  const compiled: CompiledOutputTrigger[] = [];
  for (const workflow of workflows) {
    workflow.triggers.forEach((trigger: WorkflowTrigger, index) => {
      if (trigger.kind !== "on-output-match") return;
      if (trigger.connectionIds.length === 0) return;
      if (validateOutputPattern(trigger.pattern, trigger.isRegex) !== null) return;
      const pattern = trigger.pattern;
      let test: (text: string) => boolean;
      if (trigger.isRegex) {
        // No `g`/`y` flag: `test` then keeps no `lastIndex` state between calls.
        const re = new RegExp(pattern);
        test = (text) => re.test(text);
      } else {
        test = (text) => text.includes(pattern);
      }
      compiled.push({
        key: `${workflow.id}#${index}`,
        workflowId: workflow.id,
        connectionIds: new Set(trigger.connectionIds),
        test,
        cooldownMs: clampCooldownMs(trigger.cooldownMs),
        maxFires: clampMaxFires(trigger.maxFiresPerSession),
      });
    });
  }
  return compiled;
}

/** Where a session's output lands: its tab and saved connection. */
export interface OutputSessionTarget {
  tabId: string;
  connectionId: string;
}

/** What the engine needs from its host (the store glue, or a test). */
export interface OutputTriggerDeps {
  /** The tab + saved connection a session belongs to, or `null` when none. */
  resolveSession: (sessionId: string) => OutputSessionTarget | null;
  /**
   * Launch `workflowId` against `tabId`. Returns whether a run started; a
   * refused launch (e.g. another run in progress) still starts the cooldown
   * but does not count towards the max-fires limit.
   */
  fire: (workflowId: string, tabId: string, sessionId: string) => boolean;
  /** Clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Decode one encoded chunk. Defaults to base64 → bytes → UTF-8 (streaming). */
  decode?: (chunk: string, decoder: TextDecoder) => string;
}

/** Per-trigger firing record within one session. */
interface FireRecord {
  fires: number;
  lastAttemptAt: number;
}

/** Per-session matching state. */
interface SessionState {
  decoder: TextDecoder;
  tail: string;
  records: Map<string, FireRecord>;
}

/** Default chunk decoder: base64 → bytes → streamed UTF-8. */
function decodeBase64Chunk(chunk: string, decoder: TextDecoder): string {
  const binary = atob(chunk);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return decoder.decode(bytes, { stream: true });
}

/**
 * The batched on-output-match matcher. {@link enqueue} is the O(1) output tap;
 * {@link flush} (run on a timer) does the decoding and matching.
 */
export class OutputTriggerEngine {
  private triggers: CompiledOutputTrigger[] = [];
  private pending = new Map<string, { chunks: string[]; chars: number }>();
  private sessions = new Map<string, SessionState>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly decode: (chunk: string, decoder: TextDecoder) => string;

  constructor(private readonly deps: OutputTriggerDeps) {
    this.now = deps.now ?? Date.now;
    this.decode = deps.decode ?? decodeBase64Chunk;
  }

  /** Replace the watched triggers (recompiled from the saved workflows). */
  setWorkflows(workflows: readonly Workflow[]): void {
    this.triggers = compileOutputTriggers(workflows);
    if (this.triggers.length === 0) this.reset();
  }

  /** Whether any valid trigger is being watched (i.e. the tap is needed). */
  get active(): boolean {
    return this.triggers.length > 0;
  }

  /**
   * The output tap: queue one still-encoded chunk for the next batch. O(1)
   * amortised, and bounded per session — once a session's pending output
   * passes {@link OUTPUT_TRIGGER_LIMITS.maxPendingChars}, the oldest chunks
   * are dropped (the scan only looks at the newest output anyway).
   */
  enqueue(sessionId: string, chunk: string): void {
    if (this.triggers.length === 0) return;
    let entry = this.pending.get(sessionId);
    if (!entry) {
      entry = { chunks: [], chars: 0 };
      this.pending.set(sessionId, entry);
    }
    entry.chunks.push(chunk);
    entry.chars += chunk.length;
    while (entry.chars > OUTPUT_TRIGGER_LIMITS.maxPendingChars && entry.chunks.length > 1) {
      entry.chars -= entry.chunks.shift()!.length;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, OUTPUT_TRIGGER_LIMITS.batchMs);
    }
  }

  /** Match all pending output now. Normally called by the batch timer. */
  flush(): void {
    const pending = this.pending;
    this.pending = new Map();
    for (const [sessionId, entry] of pending) {
      this.flushSession(sessionId, entry.chunks);
    }
  }

  /** Forget a session's matching state and fire counts (it ended). */
  forgetSession(sessionId: string): void {
    this.pending.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  /** Drop all state and any scheduled batch. */
  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.sessions.clear();
  }

  private flushSession(sessionId: string, chunks: string[]): void {
    const target = this.deps.resolveSession(sessionId);
    if (!target) return;
    const bound = this.triggers.filter((t) => t.connectionIds.has(target.connectionId));
    if (bound.length === 0) return;

    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { decoder: new TextDecoder(), tail: "", records: new Map() };
      this.sessions.set(sessionId, state);
    }
    let fresh = "";
    for (const chunk of chunks) {
      try {
        fresh += this.decode(chunk, state.decoder);
      } catch {
        // A malformed chunk is skipped; it must never break matching.
      }
      if (fresh.length > OUTPUT_TRIGGER_LIMITS.scanChars * 2) {
        fresh = fresh.slice(fresh.length - OUTPUT_TRIGGER_LIMITS.scanChars);
      }
    }
    let text = state.tail + stripAnsi(fresh);
    if (text.length > OUTPUT_TRIGGER_LIMITS.scanChars) {
      text = text.slice(text.length - OUTPUT_TRIGGER_LIMITS.scanChars);
    }

    const now = this.now();
    let matchedAny = false;
    for (const trigger of bound) {
      const record = state.records.get(trigger.key) ?? { fires: 0, lastAttemptAt: -Infinity };
      if (record.fires >= trigger.maxFires) continue;
      if (!trigger.test(text)) continue;
      matchedAny = true;
      if (now - record.lastAttemptAt < trigger.cooldownMs) continue;
      record.lastAttemptAt = now;
      if (this.deps.fire(trigger.workflowId, target.tabId, sessionId)) record.fires++;
      state.records.set(trigger.key, record);
    }
    // After any match the scanned text is consumed, so the same output can
    // never fire again once a cooldown ends. Otherwise keep a short tail so a
    // match can span two batches.
    state.tail = matchedAny ? "" : text.slice(-OUTPUT_TRIGGER_LIMITS.tailChars);
  }
}

/** Whether an authored cooldown is in range (absent → default, valid). */
export function cooldownInRange(value: number | undefined): boolean {
  if (value === undefined) return true;
  const { minCooldownMs, maxCooldownMs } = OUTPUT_TRIGGER_LIMITS;
  return Number.isFinite(value) && value >= minCooldownMs && value <= maxCooldownMs;
}

/** Whether an authored max-fires-per-session is in range (absent → default, valid). */
export function maxFiresInRange(value: number | undefined): boolean {
  if (value === undefined) return true;
  return (
    Number.isInteger(value) && value >= 1 && value <= OUTPUT_TRIGGER_LIMITS.maxMaxFiresPerSession
  );
}

/**
 * Whether every trigger can be saved: each on-output-match trigger needs a
 * valid, bounded pattern and in-range limits. Other kinds are always valid.
 * The workflow editor gates Save on this.
 */
export function workflowTriggersValid(triggers: readonly WorkflowTrigger[]): boolean {
  return triggers.every(
    (t) =>
      t.kind !== "on-output-match" ||
      (validateOutputPattern(t.pattern, t.isRegex) === null &&
        cooldownInRange(t.cooldownMs) &&
        maxFiresInRange(t.maxFiresPerSession))
  );
}
