/**
 * OSC 133 command-mark tracking (#3415, PROD-059), exercised against the REAL
 * xterm.js parser and buffer (jsdom) so marker positions, scrollback trimming,
 * selection and buffer readback are the library's own behaviour, not a mock's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  type CommandMarkTerminal,
  CommandMarkTracker,
  COMMAND_MARK_ACTIONS,
  OSC_133,
  PROMPT_FLASH_MS,
  getCommandMarkTracker,
  parseOsc133,
  registerCommandMarkTracker,
} from "./commandMarks";

const ESC = "\x1b";
const BEL = "\x07";
const A = `${ESC}]133;A${BEL}`;
const B = `${ESC}]133;B${BEL}`;
const C = `${ESC}]133;C${BEL}`;
const D = (code?: number) => `${ESC}]133;D${code === undefined ? "" : `;${code}`}${BEL}`;

/** One full prompt → command → output → finish cycle, as bash emits it. */
function cycle(command: string, output: string, code: number): string {
  return `${A}$ ${B}${command}\r\n${C}${output}${D(code)}`;
}

/**
 * jsdom has no layout, so real xterm cannot scroll its viewport there
 * (`scrollToLine` leaves `viewportY` pinned to `baseY`). Navigation tests run the
 * tracker against this view instead: the real terminal's parser, buffer and
 * markers, with a viewport position that `scrollToLine` / `scrollToBottom`
 * move (clamped to `baseY`, exactly like xterm).
 */
function scrollableView(term: XTerm): CommandMarkTerminal & { scrollToLine(line: number): void } {
  let viewportY: number | null = null; // null = pinned to the bottom
  return {
    registerMarker: (offset?: number) => term.registerMarker(offset),
    registerDecoration: (options) => term.registerDecoration(options),
    get cols() {
      return term.cols;
    },
    select: (column: number, row: number, length: number) => term.select(column, row, length),
    scrollToLine: (line: number) => {
      viewportY = Math.max(0, Math.min(line, term.buffer.active.baseY));
    },
    scrollToBottom: () => {
      viewportY = null;
    },
    get buffer() {
      const real = term.buffer;
      return new Proxy(real, {
        get(target, prop) {
          if (prop !== "active") return Reflect.get(target, prop) as unknown;
          return new Proxy(target.active, {
            get(active, key) {
              if (key === "viewportY") return viewportY ?? active.baseY;
              const value = Reflect.get(active, key) as unknown;
              return typeof value === "function" ? value.bind(active) : value;
            },
          });
        },
      });
    },
  } as CommandMarkTerminal & { scrollToLine(line: number): void };
}

function write(term: XTerm, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

describe("parseOsc133", () => {
  it("parses the four marks", () => {
    expect(parseOsc133("A")).toEqual({ kind: "A" });
    expect(parseOsc133("B")).toEqual({ kind: "B" });
    expect(parseOsc133("C")).toEqual({ kind: "C" });
    expect(parseOsc133("D")).toEqual({ kind: "D" });
  });

  it("parses exit codes on D", () => {
    expect(parseOsc133("D;0")).toEqual({ kind: "D", exitCode: 0 });
    expect(parseOsc133("D;130")).toEqual({ kind: "D", exitCode: 130 });
    expect(parseOsc133("D;-1")).toEqual({ kind: "D", exitCode: -1 });
    expect(parseOsc133("D;2;aid=123")).toEqual({ kind: "D", exitCode: 2 });
  });

  it("tolerates options appended by newer emitters (fish 4)", () => {
    expect(parseOsc133("A;click_events=1")).toEqual({ kind: "A" });
    expect(parseOsc133("C;cmdline_url=echo%20hi")).toEqual({ kind: "C" });
  });

  it("treats a malformed exit code as unknown", () => {
    expect(parseOsc133("D;abc")).toEqual({ kind: "D" });
    expect(parseOsc133("D;")).toEqual({ kind: "D" });
  });

  it("ignores other kinds and garbage", () => {
    expect(parseOsc133("")).toBeNull();
    expect(parseOsc133("P;k=i")).toBeNull();
    expect(parseOsc133("L")).toBeNull();
    expect(parseOsc133("a")).toBeNull();
  });
});

describe("CommandMarkTracker (real xterm)", () => {
  let term: XTerm;
  let host: HTMLDivElement;
  let tracker: CommandMarkTracker;

  beforeEach(() => {
    term = new XTerm({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    term.open(host);
    tracker = new CommandMarkTracker(term);
    term.parser.registerOscHandler(OSC_133, tracker.handleOsc);
  });

  afterEach(() => {
    tracker.dispose();
    term.dispose();
    host.remove();
  });

  describe("sequence handling", () => {
    it("stays empty and inert when the shell emits no OSC 133", async () => {
      await write(term, "$ ls\r\nfile\r\n$ ");
      expect(tracker.hasMarks()).toBe(false);
      expect(tracker.getCommands()).toEqual([]);
      expect(tracker.jumpToPreviousPrompt()).toBe(false);
      expect(tracker.jumpToNextPrompt()).toBe(false);
      expect(tracker.selectLastCommandOutput()).toBe(false);
      expect(tracker.getLastCommandOutput()).toBeNull();
    });

    it("tracks a full A/B/C/D cycle with its exit code and output lines", async () => {
      await write(term, cycle("echo hi", "hi\r\n", 0));
      await write(term, `${A}$ ${B}`);
      const commands = tracker.getCommands();
      expect(commands).toHaveLength(2);
      expect(commands[0]).toEqual({
        promptLine: 0,
        state: "finished",
        exitCode: 0,
        outputLines: [1, 1],
      });
      expect(commands[1]).toMatchObject({ promptLine: 2, state: "input" });
      expect(tracker.getLastCommandOutput()).toBe("hi");
    });

    it("records non-zero exit codes", async () => {
      await write(term, cycle("false", "", 1));
      await write(term, cycle("grep x", "nope\r\n", 2));
      expect(tracker.getCommands().map((c) => c.exitCode)).toEqual([1, 2]);
    });

    it("ignores a D with no command in flight (first prompt, empty Enter)", async () => {
      // First prompt: bash's hook emits D before the very first A.
      await write(term, `${D(0)}${A}$ ${B}`);
      // Empty Enter: no C, then D + the next prompt.
      await write(term, `\r\n${D(0)}${A}$ ${B}`);
      const commands = tracker.getCommands();
      expect(commands).toHaveLength(2);
      expect(commands.every((c) => c.state === "input" && c.exitCode === undefined)).toBe(true);
    });

    it("collapses a repeated A on the same line (native + injected marks)", async () => {
      await write(term, `${A}${ESC}]133;A;click_events=1${BEL}$ ${B}`);
      expect(tracker.getCommands()).toHaveLength(1);
    });

    it("ignores duplicate C and D marks", async () => {
      await write(term, `${A}$ ${B}ls\r\n${C}${C}out\r\n${D(0)}${D(0)}`);
      const commands = tracker.getCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ state: "finished", exitCode: 0, outputLines: [1, 1] });
    });

    it("closes a command whose D was lost with an unknown exit status", async () => {
      await write(term, `${A}$ ${B}sleep\r\n${C}partial\r\n${A}$ ${B}`);
      const [first, second] = tracker.getCommands();
      expect(first).toMatchObject({ state: "finished", exitCode: undefined, outputLines: [1, 1] });
      expect(second).toMatchObject({ state: "input", promptLine: 2 });
    });

    it("synthesizes a record when marks arrive without A (partial support)", async () => {
      await write(term, `$ ${B}ls\r\n${C}out\r\n${D(0)}`);
      expect(tracker.getCommands()).toEqual([
        { promptLine: 0, state: "finished", exitCode: 0, outputLines: [1, 1] },
      ]);
    });

    it("falls back to the line after the input when C is missing", async () => {
      await write(term, `${A}$ ${B}ls\r\nout1\r\nout2\r\n${D(0)}`);
      const [cmd] = tracker.getCommands();
      expect(cmd).toMatchObject({ state: "finished", exitCode: 0, outputLines: [1, 2] });
      expect(tracker.getLastCommandOutput()).toBe("out1\nout2");
    });

    it("does not treat an empty Enter as a command when C is missing", async () => {
      await write(term, `${A}$ ${B}\r\n${D(0)}${A}$ ${B}`);
      const commands = tracker.getCommands();
      expect(commands[0]).toMatchObject({ exitCode: undefined, outputLines: null });
    });

    it("accepts D without an exit code", async () => {
      await write(term, `${A}$ ${B}x\r\n${C}y\r\n${D()}`);
      expect(tracker.getCommands()[0]).toMatchObject({ state: "finished", exitCode: undefined });
    });

    it("ignores marks while the alternate buffer is active", async () => {
      await write(term, `${ESC}[?1049h${A}${B}${C}${D(0)}`);
      expect(tracker.hasMarks()).toBe(false);
      await write(term, `${ESC}[?1049l`);
    });

    it("never throws on garbage payloads", async () => {
      await write(term, `${ESC}]133;${BEL}${ESC}]133;Z;1${BEL}${ESC}]133;D;x${BEL}`);
      expect(tracker.hasMarks()).toBe(false);
    });
  });

  describe("scrollback trimming", () => {
    it("prunes commands whose prompt was trimmed out of the scrollback", async () => {
      const small = new XTerm({ cols: 20, rows: 5, scrollback: 10, allowProposedApi: true });
      const el = document.createElement("div");
      document.body.appendChild(el);
      small.open(el);
      const t = new CommandMarkTracker(small);
      small.parser.registerOscHandler(OSC_133, t.handleOsc);
      try {
        await write(small, cycle("one", "a\r\n", 0));
        await write(small, cycle("two", "b\r\n", 3));
        expect(t.getCommands()).toHaveLength(2);
        // Push far more than scrollback + rows lines: both prompts are trimmed.
        await write(small, "x\r\n".repeat(40));
        expect(t.getCommands()).toEqual([]);
        expect(t.getLastCommandOutput()).toBeNull();
        // New marks after trimming still work.
        await write(small, cycle("three", "c\r\n", 0));
        expect(t.getCommands()).toHaveLength(1);
        expect(t.getLastCommandOutput()).toBe("c");
      } finally {
        t.dispose();
        small.dispose();
        el.remove();
      }
    });

    it("drops the output of a command whose output start was trimmed", async () => {
      const small = new XTerm({ cols: 20, rows: 5, scrollback: 5, allowProposedApi: true });
      const el = document.createElement("div");
      document.body.appendChild(el);
      small.open(el);
      const t = new CommandMarkTracker(small);
      small.parser.registerOscHandler(OSC_133, t.handleOsc);
      try {
        await write(small, `${A}$ ${B}big\r\n${C}${"line\r\n".repeat(30)}${D(0)}`);
        expect(t.getLastCommandOutput()).toBeNull();
      } finally {
        t.dispose();
        small.dispose();
        el.remove();
      }
    });
  });

  describe("output selection and copy", () => {
    it("returns the last finished command's output, not the running one's", async () => {
      await write(term, cycle("echo a", "alpha\r\nbeta\r\n", 0));
      await write(term, `${A}$ ${B}sleep 9\r\n${C}still running`);
      expect(tracker.getLastCommandOutput()).toBe("alpha\nbeta");
    });

    it("includes a final line without a trailing newline", async () => {
      await write(term, `${A}$ ${B}printf x\r\n${C}no-newline${D(0)}`);
      expect(tracker.getLastCommandOutput()).toBe("no-newline");
    });

    it("rejoins soft-wrapped rows", async () => {
      const long = "0123456789".repeat(6); // 60 chars on a 40-col terminal
      await write(term, cycle("cat", `${long}\r\nnext\r\n`, 0));
      expect(tracker.getLastCommandOutput()).toBe(`${long}\nnext`);
    });

    it("returns null for a command with no output", async () => {
      await write(term, cycle("true", "", 0));
      expect(tracker.getLastCommandOutput()).toBeNull();
      expect(tracker.selectLastCommandOutput()).toBe(false);
    });

    it("selects exactly the last command's output", async () => {
      await write(term, cycle("echo a", "first\r\n", 0));
      await write(term, cycle("echo b", "second\r\nthird\r\n", 0));
      await write(term, `${A}$ ${B}`);
      expect(tracker.selectLastCommandOutput()).toBe(true);
      expect(term.getSelection().replace(/\s+$/, "")).toBe("second\nthird");
    });
  });

  describe("prompt navigation", () => {
    let view: ReturnType<typeof scrollableView>;
    let nav: CommandMarkTracker;

    beforeEach(() => {
      view = scrollableView(term);
      nav = new CommandMarkTracker(view);
      term.parser.registerOscHandler(OSC_133, nav.handleOsc);
    });

    afterEach(() => nav.dispose());

    const viewportY = () => view.buffer.active.viewportY;
    const baseY = () => view.buffer.active.baseY;

    /** Fill enough commands that the buffer scrolls (rows = 10). */
    async function fillCommands(n: number): Promise<number[]> {
      for (let i = 0; i < n; i++) {
        await write(term, cycle(`cmd${i}`, `out${i}a\r\nout${i}b\r\n`, i % 2));
      }
      await write(term, `${A}$ ${B}`);
      return nav.getCommands().map((c) => c.promptLine);
    }

    it("jumps back through prompts from the bottom, then forward again", async () => {
      const prompts = await fillCommands(8); // 8 commands x 3 lines + the active prompt
      expect(prompts).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24]);
      expect(viewportY()).toBe(baseY());

      // From the bottom, "previous" skips the (idle) active prompt and lands on
      // the last command's prompt (21). Prompts already on screen cannot scroll
      // further than baseY (15) — the flash highlight shows the target — so the
      // next presses continue from the prompt last jumped to (18, 15), not from
      // the unchanged viewport, until one is above it (12).
      expect(baseY()).toBe(15);
      expect(nav.jumpToPreviousPrompt()).toBe(true);
      expect(viewportY()).toBe(15);
      expect(nav.jumpToPreviousPrompt()).toBe(true);
      expect(viewportY()).toBe(15);
      expect(nav.jumpToPreviousPrompt()).toBe(true);
      expect(viewportY()).toBe(15);
      expect(nav.jumpToPreviousPrompt()).toBe(true);
      expect(viewportY()).toBe(12);

      // Walk all the way to the first prompt; then there is nothing earlier.
      let guard = 0;
      while (nav.jumpToPreviousPrompt() && guard++ < 20) {
        // keep going
      }
      expect(viewportY()).toBe(0);
      expect(nav.jumpToPreviousPrompt()).toBe(false);

      // Forward: each "next" lands on the following prompt…
      expect(nav.jumpToNextPrompt()).toBe(true);
      expect(viewportY()).toBe(3);
      expect(nav.jumpToNextPrompt()).toBe(true);
      expect(viewportY()).toBe(6);
      // …until past the last one, which scrolls back to the bottom.
      guard = 0;
      while (nav.jumpToNextPrompt() && guard++ < 20) {
        // keep going
      }
      expect(viewportY()).toBe(baseY());
      expect(nav.jumpToNextPrompt()).toBe(false);
    });

    it("uses the viewport as the reference after a manual scroll", async () => {
      await fillCommands(8);
      view.scrollToLine(9);
      expect(nav.jumpToPreviousPrompt()).toBe(true);
      expect(viewportY()).toBe(6);

      view.scrollToLine(9); // user scrolls: the last jump no longer applies
      expect(nav.jumpToNextPrompt()).toBe(true);
      expect(viewportY()).toBe(12);
    });

    it("jumps to the running command's own prompt first", async () => {
      await fillCommands(8);
      await write(term, `ls\r\n${C}${"row\r\n".repeat(12)}`);
      const commands = nav.getCommands();
      const running = commands[commands.length - 1];
      expect(running.state).toBe("running");
      expect(nav.jumpToPreviousPrompt()).toBe(true);
      expect(viewportY()).toBe(running.promptLine);
    });

    it("next at the bottom is a no-op", async () => {
      await fillCommands(3);
      expect(nav.jumpToNextPrompt()).toBe(false);
    });

    it("flashes the target prompt row and clears the highlight", async () => {
      const spy = vi.spyOn(term, "registerDecoration");
      await fillCommands(4);
      spy.mockClear();
      // Fake timers only after the writes: xterm's write queue runs on timers.
      vi.useFakeTimers();
      try {
        expect(nav.jumpToPreviousPrompt()).toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toMatchObject({ width: term.cols });
        const flash = spy.mock.results[0].value as { isDisposed: boolean };
        vi.advanceTimersByTime(PROMPT_FLASH_MS);
        expect(flash.isDisposed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("decorations", () => {
    it("decorates finished commands with a known exit code only", async () => {
      const spy = vi.spyOn(term, "registerDecoration");
      await write(term, cycle("ok", "x\r\n", 0));
      await write(term, cycle("bad", "y\r\n", 1));
      await write(term, `${A}$ ${B}lost\r\n${C}z\r\n${A}$ ${B}`); // unknown exit
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("renders nothing when disabled, and applies retroactively when toggled", async () => {
      tracker.setDecorationsEnabled(false);
      const spy = vi.spyOn(term, "registerDecoration");
      await write(term, cycle("ok", "x\r\n", 0));
      await write(term, cycle("bad", "y\r\n", 1));
      expect(spy).not.toHaveBeenCalled();

      tracker.setDecorationsEnabled(true);
      expect(spy).toHaveBeenCalledTimes(2);
      const decorations = spy.mock.results.map((r) => r.value as { isDisposed: boolean });
      tracker.setDecorationsEnabled(false);
      expect(decorations.every((d) => d.isDisposed)).toBe(true);
    });

    it("honours the decorations option at construction", async () => {
      tracker.dispose();
      tracker = new CommandMarkTracker(term, { decorations: false });
      term.parser.registerOscHandler(OSC_133, tracker.handleOsc);
      const spy = vi.spyOn(term, "registerDecoration");
      await write(term, cycle("ok", "x\r\n", 0));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("dispose() disposes the markers it owns and clears state", async () => {
    await write(term, cycle("ok", "x\r\n", 0));
    tracker.dispose();
    expect(tracker.hasMarks()).toBe(false);
    // Further marks after dispose are ignored.
    await write(term, cycle("again", "y\r\n", 0));
    expect(tracker.hasMarks()).toBe(false);
  });
});

describe("command-mark tracker registry", () => {
  it("registers, resolves and unregisters per tab", () => {
    const fake = {} as CommandMarkTracker;
    const unregister = registerCommandMarkTracker("tab-1", fake);
    expect(getCommandMarkTracker("tab-1")).toBe(fake);
    unregister();
    expect(getCommandMarkTracker("tab-1")).toBeUndefined();
  });

  it("a stale unregister does not remove a newer tracker for the same tab", () => {
    const first = {} as CommandMarkTracker;
    const second = {} as CommandMarkTracker;
    const unregisterFirst = registerCommandMarkTracker("tab-2", first);
    const unregisterSecond = registerCommandMarkTracker("tab-2", second);
    unregisterFirst();
    expect(getCommandMarkTracker("tab-2")).toBe(second);
    unregisterSecond();
  });

  it("lists the four command-mark actions", () => {
    expect([...COMMAND_MARK_ACTIONS].sort()).toEqual([
      "copy-last-command-output",
      "jump-next-prompt",
      "jump-prev-prompt",
      "select-last-command-output",
    ]);
  });
});
