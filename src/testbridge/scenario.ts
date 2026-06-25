/**
 * Declarative UI test scenarios for the in-app test bridge.
 *
 * A {@link Scenario} is plain data: an ordered list of UI actions ({@link
 * ScenarioStep}) followed by a set of assertions ({@link ScenarioCheck}). The
 * {@link runScenario} runner drives them through a {@link Driver} and returns a
 * {@link ScenarioResult} — structured, agent-readable feedback rather than a
 * thrown assertion. This is the layer a human or a coding agent authors against:
 * "press these buttons, then assert the terminal shows X".
 */

/** A single UI action performed in sequence before the checks run. */
export type ScenarioStep =
  | { action: "click"; testId: string }
  /** Double-click to "activate" (open connection / enter directory / open file). */
  | { action: "doubleClick"; testId: string }
  | { action: "type"; testId: string; text: string }
  /** Choose a native `<select>` option by value. */
  | { action: "select"; testId: string; value: string }
  /** Open an element's right-click context menu. */
  | { action: "contextMenu"; testId: string }
  /** Press a key on `testId` (or the focused element when omitted). */
  | { action: "pressKey"; key: string; testId?: string }
  /** Drag an element by a pixel delta (e.g. a resize handle); `dy` defaults to 0. */
  | { action: "drag"; testId: string; dx: number; dy?: number }
  /** Drag one element onto another (pointer-based, e.g. @dnd-kit reordering). */
  | { action: "dragTo"; fromTestId: string; toTestId: string }
  /** Send a command into a terminal session (active tab unless `tabId` is set). */
  | { action: "terminalInput"; text: string; tabId?: string }
  /**
   * Scroll a terminal's viewport by `lines` logical lines (negative = up into
   * scrollback), or to the bottom when `toBottom` is set. Active tab unless
   * `tabId` is given. Fires the same `onScroll` the auto-scroll guard keys off.
   */
  | { action: "scrollTerminal"; lines?: number; toBottom?: boolean; tabId?: string }
  /** Poll until an element with `testId` exists, or fail after `timeoutMs`. */
  | { action: "waitFor"; testId: string; timeoutMs?: number; intervalMs?: number }
  /** Wait a fixed duration (e.g. to let terminal output settle). */
  | { action: "pause"; ms: number };

/** A single assertion evaluated after all steps succeed. */
export type ScenarioCheck =
  /** The terminal's text contains `value` (active tab unless `tabId` is set). */
  | { assert: "terminalContains"; value: string; tabId?: string }
  /** The terminal's text matches the regular expression `pattern`. */
  | { assert: "terminalMatches"; pattern: string; flags?: string; tabId?: string }
  /** The element's visible text equals `value`. */
  | { assert: "textEquals"; testId: string; value: string }
  /**
   * The control's live `value` equals `value` — reads the DOM property a
   * controlled `<input>`/`<select>` updates, which `textEquals` cannot.
   */
  | { assert: "valueEquals"; testId: string; value: string }
  /** The element is present (or absent when `present` is false). */
  | { assert: "exists"; testId: string; present?: boolean }
  /**
   * A computed CSS property equals `value`. Reads `testId` when given, else the
   * document root (theme CSS variables like `--bg-primary`).
   */
  | { assert: "computedStyleEquals"; property: string; value: string; testId?: string }
  /**
   * Whether a terminal is pinned to the bottom (auto-scroll active). True when
   * `viewportY >= baseY - tolerance` (default `tolerance` 2, absorbing the
   * fractional row xterm leaves when the last line is partially visible). Set
   * `atBottom: false` to assert the user is scrolled up into the scrollback.
   */
  | { assert: "terminalAtBottom"; atBottom?: boolean; tolerance?: number; tabId?: string }
  /** The app-state value at `path` deep-equals `value`. */
  | { assert: "stateEquals"; path: string; value: unknown };

/** A scenario: a named sequence of actions plus the checks that must hold after. */
export interface Scenario {
  /** Human-readable scenario name, echoed into the result. */
  name: string;
  /** Optional free-text intent, surfaced in the result so an agent sees the "why". */
  requirement?: string;
  steps: ScenarioStep[];
  checks: ScenarioCheck[];
}

/** Outcome of a single {@link ScenarioStep}. */
export interface StepResult {
  step: ScenarioStep;
  ok: boolean;
  /** Failure reason when `ok` is false. */
  error?: string;
}

/** Outcome of a single {@link ScenarioCheck}. */
export interface CheckResult {
  check: ScenarioCheck;
  passed: boolean;
  /** What the check required (for agent-readable diffs). */
  expected?: unknown;
  /** What was actually observed. */
  actual?: unknown;
  /** Set when the check could not be evaluated at all (e.g. no terminal to read). */
  error?: string;
}

/**
 * The structured result of running a {@link Scenario}.
 *
 * `passed` is the single field an agent must check. On failure, `steps`/`checks`
 * carry per-item detail and `terminalSnapshot` captures the terminal at the point
 * of failure so the feedback is self-explanatory without a re-run.
 */
export interface ScenarioResult {
  scenario: string;
  requirement?: string;
  passed: boolean;
  steps: StepResult[];
  checks: CheckResult[];
  /** Best-effort terminal text captured when the scenario fails. */
  terminalSnapshot?: string;
}
