import { describe, it, expect, vi } from "vitest";
import { runScenario, type RunOptions } from "./runner";
import type {
  Driver,
  GetComputedStyleOptions,
  GetTerminalViewportOptions,
  KeyModifiers,
  ReadTerminalOptions,
  ScrollTerminalOptions,
  TerminalInputOptions,
} from "./driver";
import type { TerminalViewport } from "./protocol";
import { BridgeError } from "./driver";
import type { Scenario } from "./scenario";

/**
 * An in-memory {@link Driver} for runner tests. Backing data is public and
 * mutable; methods mirror the real driver's failure semantics (a missing element
 * or terminal rejects with a {@link BridgeError}).
 */
class FakeDriver implements Driver {
  clicks: string[] = [];
  doubleClicks: string[] = [];
  resizes: Array<{ width: number; height: number }> = [];
  typed: Array<{ testId: string; text: string }> = [];
  selected: Array<{ testId: string; value: string }> = [];
  drags: Array<{ testId: string; dx: number; dy?: number }> = [];
  contextMenus: string[] = [];
  pressedKeys: Array<{ key: string; testId?: string; modifiers?: KeyModifiers }> = [];
  dragTos: Array<{ from: string; to: string }> = [];
  terminalInputs: Array<{ text: string; tabId?: string }> = [];
  events: Array<{ event: string; payload?: unknown }> = [];
  elements = new Map<string, { text?: string; value?: string }>();
  /** Keyed by `testId ?? ""`, then property name → computed value. */
  computedStyles = new Map<string, Record<string, string>>();
  terminalText = "";
  hasTerminal = true;
  readTerminalCalls = 0;
  scrolls: Array<{ lines?: number; toBottom?: boolean; tabId?: string }> = [];
  /** Viewport returned by `getTerminalViewport`; mutate to model scroll state. */
  viewport: TerminalViewport = { viewportY: 0, baseY: 0 };
  state: Record<string, unknown> = {};
  /** Optional override so tests can model `exists` changing over time. */
  existsImpl?: (testId: string) => boolean;

  async click(testId: string): Promise<void> {
    if (!this.elements.has(testId)) throw new BridgeError("click", `no element "${testId}"`);
    this.clicks.push(testId);
  }

  async doubleClick(testId: string): Promise<void> {
    if (!this.elements.has(testId)) throw new BridgeError("doubleClick", `no element "${testId}"`);
    this.doubleClicks.push(testId);
  }

  async resizeWindow(width: number, height: number): Promise<void> {
    this.resizes.push({ width, height });
  }

  async type(testId: string, text: string): Promise<void> {
    if (!this.elements.has(testId)) throw new BridgeError("type", `no element "${testId}"`);
    this.typed.push({ testId, text });
  }

  async select(testId: string, value: string): Promise<void> {
    if (!this.elements.has(testId)) throw new BridgeError("select", `no element "${testId}"`);
    this.selected.push({ testId, value });
  }

  async contextMenu(testId: string): Promise<void> {
    if (!this.elements.has(testId)) throw new BridgeError("contextMenu", `no element "${testId}"`);
    this.contextMenus.push(testId);
  }

  async pressKey(key: string, testId?: string, modifiers?: KeyModifiers): Promise<void> {
    // Only record modifiers when at least one is set, so plain presses still
    // compare equal to `{ key, testId }` (toEqual ignores undefined).
    const mods = modifiers && Object.values(modifiers).some(Boolean) ? modifiers : undefined;
    this.pressedKeys.push({ key, testId, modifiers: mods });
  }

  async dragTo(from: string, to: string): Promise<void> {
    if (!this.elements.has(from)) throw new BridgeError("dragTo", `no element "${from}"`);
    if (!this.elements.has(to)) throw new BridgeError("dragTo", `no element "${to}"`);
    this.dragTos.push({ from, to });
  }

  async terminalInput(text: string, options: TerminalInputOptions = {}): Promise<void> {
    if (!this.hasTerminal) throw new BridgeError("terminalInput", "no active terminal");
    this.terminalInputs.push({ text, tabId: options.tabId });
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

  async getValue(testId: string): Promise<string> {
    const el = this.elements.get(testId);
    if (!el) throw new BridgeError("getValue", `no element "${testId}"`);
    return el.value ?? "";
  }

  async drag(testId: string, dx: number, dy?: number): Promise<void> {
    if (!this.elements.has(testId)) throw new BridgeError("drag", `no element "${testId}"`);
    this.drags.push({ testId, dx, dy });
  }

  async getComputedStyle(property: string, options: GetComputedStyleOptions = {}): Promise<string> {
    return this.computedStyles.get(options.testId ?? "")?.[property] ?? "";
  }

  async readTerminal(_options?: ReadTerminalOptions): Promise<string> {
    this.readTerminalCalls++;
    if (!this.hasTerminal) throw new BridgeError("readTerminal", "no active terminal");
    return this.terminalText;
  }

  async scrollTerminal(options: ScrollTerminalOptions = {}): Promise<void> {
    if (!this.hasTerminal) throw new BridgeError("scrollTerminal", "no active terminal");
    this.scrolls.push({ lines: options.lines, toBottom: options.toBottom, tabId: options.tabId });
  }

  async getTerminalViewport(_options?: GetTerminalViewportOptions): Promise<TerminalViewport> {
    if (!this.hasTerminal) throw new BridgeError("getTerminalViewport", "no active terminal");
    return this.viewport;
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

  async screenshot(): Promise<string> {
    return "data:image/png;base64,AAAA";
  }

  async emitEvent(event: string, payload?: unknown): Promise<void> {
    this.events.push({ event, payload });
  }

  async severAgentTransport(_agentId: string): Promise<boolean> {
    return true;
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

  it("runs a select step against the driver", async () => {
    const driver = new FakeDriver();
    driver.elements.set("connection-editor-type-select", {});

    const scenario: Scenario = {
      name: "choose a type",
      steps: [{ action: "select", testId: "connection-editor-type-select", value: "ssh" }],
      checks: [],
    };

    const result = await runScenario(scenario, driver, instant());

    expect(result.passed).toBe(true);
    expect(driver.selected).toEqual([{ testId: "connection-editor-type-select", value: "ssh" }]);
  });

  it("runs a terminalInput step and then asserts on the resulting output", async () => {
    const driver = new FakeDriver();
    driver.terminalText = "user@host:~$ whoami\nroot\n";

    const scenario: Scenario = {
      name: "drive a shell",
      requirement: "a command typed into the shell shows its output",
      steps: [{ action: "terminalInput", text: "whoami", tabId: "tab-1" }],
      checks: [{ assert: "terminalContains", value: "root" }],
    };

    const result = await runScenario(scenario, driver, instant());

    expect(result.passed).toBe(true);
    expect(driver.terminalInputs).toEqual([{ text: "whoami", tabId: "tab-1" }]);
  });

  it("runs a drag step and checks a computed style", async () => {
    const driver = new FakeDriver();
    driver.elements.set("sidebar-resize-handle", {});
    driver.computedStyles.set("sidebar-resize-handle", { cursor: "col-resize" });

    const scenario: Scenario = {
      name: "resize the sidebar",
      requirement: "the resize handle shows a col-resize cursor and accepts a drag",
      steps: [{ action: "drag", testId: "sidebar-resize-handle", dx: 100 }],
      checks: [
        {
          assert: "computedStyleEquals",
          testId: "sidebar-resize-handle",
          property: "cursor",
          value: "col-resize",
        },
      ],
    };

    const result = await runScenario(scenario, driver, instant());

    expect(result.passed).toBe(true);
    expect(driver.drags).toEqual([{ testId: "sidebar-resize-handle", dx: 100, dy: undefined }]);
    expect(result.checks[0].passed).toBe(true);
  });

  it("runs select, contextMenu, pressKey, and dragTo steps", async () => {
    const driver = new FakeDriver();
    driver.elements.set("theme-select", {});
    driver.elements.set("tab-1", {});
    driver.elements.set("tab-2", {});

    const scenario: Scenario = {
      name: "extended interactions",
      steps: [
        { action: "select", testId: "theme-select", value: "light" },
        { action: "contextMenu", testId: "tab-1" },
        { action: "pressKey", key: "Escape" },
        { action: "pressKey", key: "Enter", testId: "tab-1" },
        { action: "dragTo", fromTestId: "tab-1", toTestId: "tab-2" },
      ],
      checks: [],
    };

    const result = await runScenario(scenario, driver, instant());

    expect(result.passed).toBe(true);
    expect(driver.selected).toEqual([{ testId: "theme-select", value: "light" }]);
    expect(driver.contextMenus).toEqual(["tab-1"]);
    expect(driver.pressedKeys).toEqual([
      { key: "Escape", testId: undefined },
      { key: "Enter", testId: "tab-1" },
    ]);
    expect(driver.dragTos).toEqual([{ from: "tab-1", to: "tab-2" }]);
  });

  it("runs doubleClick and resizeWindow steps", async () => {
    const driver = new FakeDriver();
    driver.elements.set("connection-item-1", {});

    const scenario: Scenario = {
      name: "pointer + window verbs",
      steps: [
        { action: "doubleClick", testId: "connection-item-1" },
        { action: "resizeWindow", width: 640, height: 480 },
      ],
      checks: [],
    };

    const result = await runScenario(scenario, driver, instant());

    expect(result.passed).toBe(true);
    expect(driver.doubleClicks).toEqual(["connection-item-1"]);
    expect(driver.resizes).toEqual([{ width: 640, height: 480 }]);
  });

  it("reads a root-level computed style (theme variable) when testId is omitted", async () => {
    const driver = new FakeDriver();
    driver.computedStyles.set("", { "--bg-primary": "#1e1e1e" });

    const scenario: Scenario = {
      name: "theme variable",
      steps: [],
      checks: [{ assert: "computedStyleEquals", property: "--bg-primary", value: "#1e1e1e" }],
    };

    const result = await runScenario(scenario, driver, instant());
    expect(result.passed).toBe(true);
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

    it("valueEquals compares a control's live value", async () => {
      const driver = new FakeDriver();
      driver.elements.set("field-port", { value: "22" });
      const result = await runScenario(
        {
          name: "value",
          steps: [],
          checks: [{ assert: "valueEquals", testId: "field-port", value: "22" }],
        },
        driver,
        instant()
      );
      expect(result.passed).toBe(true);
    });

    it("valueEquals reports the actual value on mismatch", async () => {
      const driver = new FakeDriver();
      driver.elements.set("field-port", { value: "2222" });
      const result = await runScenario(
        {
          name: "value-mismatch",
          steps: [],
          checks: [{ assert: "valueEquals", testId: "field-port", value: "22" }],
        },
        driver,
        instant()
      );
      expect(result.passed).toBe(false);
      expect(result.checks[0].actual).toBe("2222");
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
