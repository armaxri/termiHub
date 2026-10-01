/**
 * Console-output guard for the vitest suite (#3356).
 *
 * The suite once wrote ~1 GB of React warnings to stderr per run (a missing
 * `IS_REACT_ACT_ENVIRONMENT` made every `act()` log a component stack), which
 * pushed the Windows `Run Tests` CI log to ~900 MB and made it undownloadable.
 * This guard keeps that from growing back unnoticed, with two checks:
 *
 * 1. **Fatal patterns** — a test fails if it logs a warning that means the
 *    test environment itself is misconfigured (see {@link FATAL_CONSOLE_PATTERNS}).
 *    These are deterministic, so the check cannot flake.
 * 2. **Per-file volume budget** — a test file fails (in `afterAll`) when the
 *    console output of all its tests together exceeds
 *    {@link CONSOLE_BYTES_PER_FILE_BUDGET}. A budget rather than "fail on any
 *    console.error" because React's "update … not wrapped in act(...)" warning is
 *    timing-dependent: a zero-tolerance check would turn a slow Windows runner
 *    into a flake source, while a generous per-file budget still catches a test
 *    file that starts flooding the log, and names the file that did it.
 *
 * Output a test silences on purpose (`vi.spyOn(console, "error")
 * .mockImplementation(...)`) replaces this wrapper and is not counted.
 *
 * Debugging a file over budget: run it with `TERMIHUB_TEST_CONSOLE_TRACE=1` to
 * append the JavaScript stack to every console call. For an "update … not
 * wrapped in act(...)" warning, that stack shows which promise/timer/event
 * triggered the stray update, which is what needs awaiting inside `act()`.
 */
import { format } from "node:util";
import { afterAll, afterEach, expect } from "vitest";

/**
 * Max bytes of console output one test file may emit across all its tests.
 * Sized when `FileBrowser.test.tsx` emitted ~47 KiB of react-virtual flushSync
 * warnings; #3897 now filters those (see {@link isSilencedConsoleMessage}), so
 * the budget has ample headroom and can be lowered.
 */
export const CONSOLE_BYTES_PER_FILE_BUDGET = 96 * 1024;

/**
 * Console messages that always fail the emitting test. Each one means the test
 * environment is misconfigured (not that one test is sloppy), so a single
 * occurrence is repeated by every React update across the suite.
 */
export const FATAL_CONSOLE_PATTERNS: readonly RegExp[] = [
  // IS_REACT_ACT_ENVIRONMENT unset (see setup.ts): ~985 MB per run before #3356.
  /The current testing environment is not configured to support act\(/,
];

/**
 * React 18's exact first line for a `flushSync` issued during a commit. `error()`
 * in react-dom prefixes "Warning: " and the component stack follows on the next
 * lines.
 */
export const REACT_VIRTUAL_FLUSH_SYNC_WARNING =
  "Warning: flushSync was called from inside a lifecycle method. React cannot flush when " +
  "React is already rendering. Consider moving this call to a scheduler task or micro task.";

/** FileBrowser component test files (`src/components/Sidebar/FileBrowser*.test.tsx`). */
const FILE_BROWSER_TEST_PATH = /[\\/]components[\\/]Sidebar[\\/]FileBrowser[^\\/]*\.test\.tsx$/;

/**
 * Whether a console call is the known, accepted react-virtual `flushSync` warning
 * from the FileBrowser tests (#3897), which is dropped instead of printed.
 *
 * `useVirtualizer` in `FileBrowser.tsx` keeps react-virtual's default
 * `useFlushSync: true` on purpose: synchronous flushing is what keeps rows painted
 * during fast scrolls in the real app, and turning it off cannot be proven
 * flicker-free without a real layout engine. In jsdom the virtualizer measures
 * during a commit, so React logs this warning ~120 times per run. The filter is
 * deliberately narrow; every condition must hold:
 * - it is `console.error`;
 * - the first line is exactly {@link REACT_VIRTUAL_FLUSH_SYNC_WARNING};
 * - the first component-stack frame is `FileBrowser`;
 * - the emitting test file is a FileBrowser component test.
 * Any other warning, including this one from another component or test file,
 * still prints and counts against the per-file budget.
 */
export function isSilencedConsoleMessage(
  method: string,
  text: string,
  testPath: string | undefined
): boolean {
  if (method !== "error" || !testPath || !FILE_BROWSER_TEST_PATH.test(testPath)) return false;
  const [first, second] = text.split("\n", 2);
  return (
    first === REACT_VIRTUAL_FLUSH_SYNC_WARNING &&
    second !== undefined &&
    second.trimStart().startsWith("at FileBrowser (")
  );
}

const METHODS = ["error", "warn", "log", "info", "debug"] as const;
const trace = Boolean(process.env.TERMIHUB_TEST_CONSOLE_TRACE);

let fileBytes = 0;
let fatalHits: string[] = [];

/** Whether a formatted console message is one of the {@link FATAL_CONSOLE_PATTERNS}. */
export function isFatalConsoleMessage(text: string): boolean {
  return FATAL_CONSOLE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Wrap the console methods once, at setup-module load, so tests that
 * `vi.spyOn(console, …)` (at module level or in hooks) layer on top of the
 * wrapper and `mockRestore()` returns to it.
 */
export function installConsoleGuard(): void {
  for (const method of METHODS) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      const text = format(...args);
      if (isSilencedConsoleMessage(method, text, expect.getState().testPath)) return;
      fileBytes += text.length + 1;
      if (isFatalConsoleMessage(text)) {
        fatalHits.push(text.split("\n", 1)[0]);
      }
      if (trace) {
        original(`${text}\n[console trace]${new Error().stack?.replace(/^Error/, "") ?? ""}`);
      } else {
        original(...args);
      }
    };
  }

  afterEach(() => {
    if (fatalHits.length === 0) return;
    const hits = fatalHits;
    fatalHits = [];
    throw new Error(
      `This test logged a warning that means the test environment is misconfigured ` +
        `(#3356):\n  ${hits[0]}\n(${hits.length} occurrence(s)). See src/test/consoleGuard.ts.`
    );
  });

  afterAll(() => {
    if (fileBytes <= CONSOLE_BYTES_PER_FILE_BUDGET) return;
    const kib = (n: number) => `${Math.round(n / 1024)} KiB`;
    throw new Error(
      `This test file wrote ${kib(fileBytes)} of console output, over the ` +
        `${kib(CONSOLE_BYTES_PER_FILE_BUDGET)} per-file budget (#3356). Fix the warnings ` +
        `(usually an async update landing outside act(): await it inside ` +
        `\`await act(async () => …)\` or use flushAsync()); rerun the file with ` +
        `TERMIHUB_TEST_CONSOLE_TRACE=1 to see what triggers each one.`
    );
  });
}
