import { describe, it, expect, vi } from "vitest";
import { runScenario, type RunOptions } from "./runner";
import type { Driver, ReadTerminalOptions } from "./driver";
import { BridgeError } from "./driver";
import type { Scenario } from "./scenario";

/**
 * An in-memory {@link Driver} for runner tests. Backing data is public and
 * mutable; methods mirror the real driver's failure semantics (a missing element
 * or terminal rejects with a {@link BridgeError}).
 */
class FakeDriver implements Driver {
  clicks: string[] = [];
  typed: Array<{ testId: string; text: string }> = [];
  elements = new Map<string, { text?: string }>();
  terminalText = "";
  hasTerminal = true;
  readTerminalCalls = 0;
  state: Record<string, unknown> = {};
  /** Optional override so tests can model `exists` changing over time. */
  existsImpl?: (testId: string) => boolean;

  async click(testId: string): Promise<void> {
    if (!this.elements.has(testId)) throw new BridgeError("click", `no element "${testId}"`);
    this.clicks.push(testId);
  }

  async type(testId: string, text: string): Promise<void> {
    if (!this.elements.has(testId)) throw new BridgeError("type", `no element "${testId}"`);
    this.typed.push({ testId, text });
  }

  async exists(testId: string): Promise<boolean> {
    return this.existsImpl ? this.existsImpl(testId) : this.elements.has(testId);
  }

  async getText(testId: string): Promise<string> {
    const el = this.elements.get(testId);
    if (!el) throw new BridgeError("getText", `no element "${testId}"`);
    return el.text ?? "";
  }

  async getAttribute(): Promise<string | null> {
    return null;
  }

  async readTerminal(_options?: ReadTerminalOptions): Promise<string> {
    this.readTerminalCalls++;
    if (!this.hasTerminal) throw new BridgeError("readTerminal", "no active terminal");
    return this.terminalText;
  }

  async getState(path?: string): Promise<unknown> {
    if (path === undefined) return this.state;
    let cur: unknown = this.state;
    for (const key of path.split(".")) {
      if (cur == null || typeof cur !== "object" || !(key in (cur as object))) {
        throw new BridgeError("getState", `path "${path}" does not resolve`);
      }
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur;
  }
}

/** Run options with an instant sleep so timing-based steps don't wait in tests. */
function instant(extra: Partial<RunOptions> = {}): RunOptions {
  return { sleep: async () => {}, ...extra };
}

describe("runScenario", () => {
  it("runs steps in order then passes when all checks hold", async () => {
    const driver = new FakeDriver();
    driver.elements.set("name", {});
    driver.elements.set("save", {});
    driver.terminalText = "user@host:~$ echo hi\nhi\n";

    const scenario: Scenario = {
      name: "happy path",
      requirement: "typing then saving shows output",
      steps: [
        { action: "type", testId: "name", text: "hi" },
        { action: "click", testId: "save" },
      ],
      checks: [{ assert: "terminalContains", value: "hi" }],
    };

    const result = await runScenario(scenario, driver, instant());

    expect(result.passed).toBe(true);
    expect(result.scenario).toBe("happy path");
    expect(result.requirement).toBe("typing then saving shows output");
    expect(driver.typed).toEqual([{ testId: "name", text: "hi" }]);
    expect(driver.clicks).toEqual(["save"]);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.checks[0].passed).toBe(true);
    expect(result.terminalSnapshot).toBeUndefined();
  });

  it("reports a failing check with expected and actual, and captures a snapshot", async () => {
    const driver = new FakeDriver();
    driver.terminalText = "prompt$ \n";

    const scenario: Scenario = {
      name: "missing output",
      steps: [],
      checks: [{ assert: "terminalContains", value: "HELLO_MARKER" }],
    };

    const result = await runScenario(scenario, driver, instant());

    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({
      passed: false,
      expected: "HELLO_MARKER",
      actual: "prompt$ \n",
    });
    expect(result.terminalSnapshot).toBe("prompt$ \n");
  });

  it("stops at a failing step and does not evaluate later steps or checks", async () => {
    const driver = new FakeDriver();
    driver.elements.set("present", {});
    // "ghost" is absent, so clicking it rejects.

    const scenario: Scenario = {
      name: "broken step",
      steps: [
        { action: "click", testId: "ghost" },
        { action: "click", testId: "present" },
      ],
      checks: [{ assert: "exists", testId: "present" }],
    };

    const result = await runScenario(scenario, driver, instant());

    expect(result.passed).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ ok: false });
    expect(result.steps[0].error).toContain("ghost");
    expect(driver.clicks).toEqual([]); // second step never ran
    expect(result.checks).toEqual([]); // checks skipped after a failed step
  });

  describe("waitFor", () => {
    it("polls until the element appears", async () => {
      const driver = new FakeDriver();
      let calls = 0;
      driver.existsImpl = () => ++calls >= 3; // appears on the third poll

      const scenario: Scenario = {
        name: "wait",
        steps: [{ action: "waitFor", testId: "late", timeoutMs: 500, intervalMs: 100 }],
        checks: [],
      };

      const result = await runScenario(scenario, driver, instant());
      expect(result.passed).toBe(true);
      expect(calls).toBe(3);
    });

    it("fails the step when the element never appears", async () => {
      const driver = new FakeDriver();
      driver.existsImpl = () => false;

      const scenario: Scenario = {
        name: "wait-timeout",
        steps: [{ action: "waitFor", testId: "never", timeoutMs: 300, intervalMs: 100 }],
        checks: [],
      };

      const result = await runScenario(scenario, driver, instant());
      expect(result.passed).toBe(false);
      expect(result.steps[0].ok).toBe(false);
      expect(result.steps[0].error).toMatch(/timed out/i);
    });
  });

  it("pause waits via the injected sleep", async () => {
    const driver = new FakeDriver();
    const sleep = vi.fn(async () => {});
    const scenario: Scenario = {
      name: "pause",
      steps: [{ action: "pause", ms: 250 }],
      checks: [],
    };

    await runScenario(scenario, driver, { sleep });
    expect(sleep).toHaveBeenCalledWith(250);
  });

  describe("checks", () => {
    it("terminalMatches evaluates a regex with flags", async () => {
      const driver = new FakeDriver();
      driver.terminalText = "Exit code: 0\n";
      const result = await runScenario(
        {
          name: "regex",
          steps: [],
          checks: [{ assert: "terminalMatches", pattern: "exit code: \\d+", flags: "i" }],
        },
        driver,
        instant()
      );
      expect(result.passed).toBe(true);
    });

    it("textEquals compares element text", async () => {
      const driver = new FakeDriver();
      driver.elements.set("status", { text: "Connected" });
      const result = await runScenario(
        {
          name: "text",
          steps: [],
          checks: [{ assert: "textEquals", testId: "status", value: "Connected" }],
        },
        driver,
        instant()
      );
      expect(result.passed).toBe(true);
    });

    it("exists honors the present flag", async () => {
      const driver = new FakeDriver(); // nothing present
      const result = await runScenario(
        { name: "absent", steps: [], checks: [{ assert: "exists", testId: "x", present: false }] },
        driver,
        instant()
      );
      expect(result.passed).toBe(true);
    });

    it("stateEquals deep-compares a state path", async () => {
      const driver = new FakeDriver();
      driver.state = { rootPanel: { activeTabId: "tab-7" } };
      const result = await runScenario(
        {
          name: "state",
          steps: [],
          checks: [{ assert: "stateEquals", path: "rootPanel.activeTabId", value: "tab-7" }],
        },
        driver,
        instant()
      );
      expect(result.passed).toBe(true);
    });

    it("reads each terminal only once across multiple terminal checks", async () => {
      const driver = new FakeDriver();
      driver.terminalText = "alpha beta gamma\n";
      const result = await runScenario(
        {
          name: "cached reads",
          steps: [],
          checks: [
            { assert: "terminalContains", value: "alpha" },
            { assert: "terminalMatches", pattern: "beta" },
            { assert: "terminalContains", value: "gamma" },
          ],
        },
        driver,
        instant()
      );
      expect(result.passed).toBe(true);
      expect(driver.readTerminalCalls).toBe(1);
    });

    it("reuses the cached terminal read for the failure snapshot", async () => {
      const driver = new FakeDriver();
      driver.terminalText = "only this\n";
      const result = await runScenario(
        {
          name: "snapshot reuse",
          steps: [],
          checks: [{ assert: "terminalContains", value: "MISSING" }],
        },
        driver,
        instant()
      );
      expect(result.passed).toBe(false);
      expect(result.terminalSnapshot).toBe("only this\n");
      expect(driver.readTerminalCalls).toBe(1); // not re-read for the snapshot
    });

    it("records a check that cannot be evaluated as an error, without throwing", async () => {
      const driver = new FakeDriver();
      driver.hasTerminal = false; // readTerminal will reject

      const result = await runScenario(
        { name: "no-terminal", steps: [], checks: [{ assert: "terminalContains", value: "x" }] },
        driver,
        instant()
      );
      expect(result.passed).toBe(false);
      expect(result.checks[0].passed).toBe(false);
      expect(result.checks[0].error).toMatch(/no active terminal/i);
    });
  });
});
