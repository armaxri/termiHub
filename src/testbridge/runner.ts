import type { Driver } from "./driver";
import type {
  Scenario,
  ScenarioStep,
  ScenarioCheck,
  StepResult,
  CheckResult,
  ScenarioResult,
} from "./scenario";

/** Tunables for {@link runScenario}. */
export interface RunOptions {
  /**
   * Delay primitive used by `pause` and `waitFor` polling. Defaults to real
   * `setTimeout`; tests inject an instant resolver to avoid waiting.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Default `waitFor` timeout when a step omits one. */
  defaultWaitTimeoutMs?: number;
  /** Default `waitFor` poll interval when a step omits one. */
  defaultWaitIntervalMs?: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 5000;
const DEFAULT_WAIT_INTERVAL_MS = 100;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Extract a readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Structural deep-equality good enough for state values (primitives, ids, small objects). */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Run a {@link Scenario} through a {@link Driver} and return structured feedback.
 *
 * Steps run in order; the first failing step aborts the rest (steps are
 * sequential preconditions) and the checks are skipped. When every step
 * succeeds, all checks are evaluated — even after one fails — so the result
 * reports every assertion at once. The runner never throws: a check that cannot
 * be evaluated is recorded with an `error`, and on any failure a best-effort
 * terminal snapshot is attached for diagnostics.
 */
export async function runScenario(
  scenario: Scenario,
  driver: Driver,
  options: RunOptions = {}
): Promise<ScenarioResult> {
  const sleep = options.sleep ?? realSleep;

  const steps: StepResult[] = [];
  let stepsOk = true;
  for (const step of scenario.steps) {
    try {
      await runStep(step, driver, sleep, options);
      steps.push({ step, ok: true });
    } catch (err) {
      steps.push({ step, ok: false, error: errorMessage(err) });
      stepsOk = false;
      break;
    }
  }

  // Checks are postconditions over a single end state, so a terminal only needs
  // reading once per tab — memoize it. Over a remote (WebSocket) transport this
  // turns N terminal checks + the failure snapshot into one round-trip per tab.
  const terminalCache = new Map<string, string>();
  const readTerminal = async (tabId?: string): Promise<string> => {
    const key = tabId ?? "";
    const cached = terminalCache.get(key);
    if (cached !== undefined) return cached;
    const text = await driver.readTerminal({ tabId });
    terminalCache.set(key, text);
    return text;
  };

  const checks: CheckResult[] = [];
  if (stepsOk) {
    for (const check of scenario.checks) {
      checks.push(await runCheck(check, driver, readTerminal));
    }
  }

  const passed = stepsOk && checks.every((c) => c.passed);

  const result: ScenarioResult = { scenario: scenario.name, passed, steps, checks };
  if (scenario.requirement !== undefined) result.requirement = scenario.requirement;
  if (!passed) {
    // Reuse the active-tab read a check already made; otherwise fetch it once.
    const snapshot = terminalCache.get("") ?? (await safeReadTerminal(driver));
    if (snapshot !== undefined) result.terminalSnapshot = snapshot;
  }
  return result;
}

/** Execute a single step, throwing on failure (caught by the caller). */
async function runStep(
  step: ScenarioStep,
  driver: Driver,
  sleep: (ms: number) => Promise<void>,
  options: RunOptions
): Promise<void> {
  switch (step.action) {
    case "click":
      await driver.click(step.testId);
      return;
    case "type":
      await driver.type(step.testId, step.text);
      return;
    case "terminalInput":
      await driver.terminalInput(step.text, { tabId: step.tabId });
      return;
    case "pause":
      await sleep(step.ms);
      return;
    case "waitFor": {
      const timeout = step.timeoutMs ?? options.defaultWaitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const interval = step.intervalMs ?? options.defaultWaitIntervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
      const attempts = Math.max(1, Math.ceil(timeout / interval));
      for (let i = 0; i < attempts; i++) {
        if (await driver.exists(step.testId)) return;
        if (i < attempts - 1) await sleep(interval);
      }
      throw new Error(`waitFor "${step.testId}" timed out after ${timeout}ms`);
    }
  }
}

/** Evaluate a single check, capturing any driver error rather than throwing. */
async function runCheck(
  check: ScenarioCheck,
  driver: Driver,
  readTerminal: (tabId?: string) => Promise<string>
): Promise<CheckResult> {
  try {
    switch (check.assert) {
      case "terminalContains": {
        const actual = await readTerminal(check.tabId);
        return { check, passed: actual.includes(check.value), expected: check.value, actual };
      }
      case "terminalMatches": {
        const actual = await readTerminal(check.tabId);
        const passed = new RegExp(check.pattern, check.flags).test(actual);
        return { check, passed, expected: check.pattern, actual };
      }
      case "textEquals": {
        const actual = await driver.getText(check.testId);
        return { check, passed: actual === check.value, expected: check.value, actual };
      }
      case "exists": {
        const expected = check.present ?? true;
        const actual = await driver.exists(check.testId);
        return { check, passed: actual === expected, expected, actual };
      }
      case "stateEquals": {
        const actual = await driver.getState(check.path);
        return { check, passed: deepEqual(actual, check.value), expected: check.value, actual };
      }
    }
  } catch (err) {
    return { check, passed: false, error: errorMessage(err) };
  }
}

/** Read the active terminal for diagnostics, swallowing any error. */
async function safeReadTerminal(driver: Driver): Promise<string | undefined> {
  try {
    return await driver.readTerminal();
  } catch {
    return undefined;
  }
}
