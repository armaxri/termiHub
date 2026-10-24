/**
 * The raw terminal-output tap (#4931) and the `readTerminalOutput` /
 * `readFrontendLog` bridge verbs that expose it and the Log Viewer history.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import {
  OUTPUT_TAP_HEAD_LIMIT,
  OUTPUT_TAP_MAX_TABS,
  readTerminalOutput,
  resetTerminalOutputTaps,
  tapTerminalOutput,
  type WritableTerminal,
} from "./outputTap";
import { clearFrontendLogHistory, frontendLog, getFrontendLogHistory } from "@/utils/frontendLog";

/** A terminal stub that records what reaches the real `write`. */
function fakeTerminal(): WritableTerminal & { received: (string | Uint8Array)[] } {
  const received: (string | Uint8Array)[] = [];
  return {
    received,
    write(data: string | Uint8Array, callback?: () => void) {
      received.push(data);
      callback?.();
    },
  };
}

/** Inert deps; the verbs under test come from the caller. */
function depsWith(overrides: Partial<BridgeDeps>): BridgeDeps {
  return {
    root: document,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "",
    emitEvent: async () => {},
    ...overrides,
  };
}

afterEach(() => {
  resetTerminalOutputTaps();
  clearFrontendLogHistory();
});

describe("tapTerminalOutput", () => {
  it("records string and binary writes, escapes intact, and still forwards them", () => {
    const term = fakeTerminal();
    let clock = 100;
    tapTerminalOutput("tab-1", term, () => clock);
    let called = false;
    term.write("\x1b[2Jbanner\r\n", () => {
      called = true;
    });
    clock = 350;
    term.write(new TextEncoder().encode("héllo $ "));

    const tap = readTerminalOutput("tab-1", () => clock + 50);
    expect(tap).toEqual({
      output: "\x1b[2Jbanner\r\nhéllo $ ",
      written: 12 + 9,
      writes: 2,
      truncated: false,
      msSinceLastWrite: 50,
    });
    expect(called).toBe(true);
    expect(term.received).toHaveLength(2);
  });

  it("decodes a UTF-8 sequence split across binary writes", () => {
    const term = fakeTerminal();
    tapTerminalOutput("tab-1", term);
    const bytes = new TextEncoder().encode("日");
    term.write(bytes.slice(0, 1));
    term.write(bytes.slice(1));
    expect(readTerminalOutput("tab-1")?.output).toBe("日");
  });

  it("keeps only the head of a flood and counts the rest", () => {
    const term = fakeTerminal();
    tapTerminalOutput("tab-1", term);
    const chunk = "y\n".repeat(4096);
    for (let i = 0; i < 20; i++) term.write(chunk);
    const tap = readTerminalOutput("tab-1");
    expect(tap?.output.length).toBe(OUTPUT_TAP_HEAD_LIMIT);
    expect(tap?.written).toBe(chunk.length * 20);
    expect(tap?.truncated).toBe(true);
  });

  it("wraps an instance once and appends a remounted instance to the same tab", () => {
    const first = fakeTerminal();
    tapTerminalOutput("tab-1", first);
    tapTerminalOutput("tab-1", first);
    first.write("a");
    const second = fakeTerminal();
    tapTerminalOutput("tab-1", second);
    second.write("b");
    expect(readTerminalOutput("tab-1")?.output).toBe("ab");
    expect(first.received).toEqual(["a"]);
  });

  it("drops the oldest tab past the tracked-tab cap", () => {
    for (let i = 0; i <= OUTPUT_TAP_MAX_TABS; i++) tapTerminalOutput(`tab-${i}`, fakeTerminal());
    expect(readTerminalOutput("tab-0")).toBeUndefined();
    expect(readTerminalOutput(`tab-${OUTPUT_TAP_MAX_TABS}`)?.writes).toBe(0);
  });

  it("reports nothing written and no last write for a fresh tap", () => {
    tapTerminalOutput("tab-1", fakeTerminal());
    expect(readTerminalOutput("tab-1")).toMatchObject({ written: 0, msSinceLastWrite: null });
    expect(readTerminalOutput("never")).toBeUndefined();
  });

  it("taps a real xterm instance", async () => {
    const xterm = new XTerm({ allowProposedApi: true });
    tapTerminalOutput("tab-x", xterm);
    await new Promise<void>((resolve) => xterm.write("real-xterm\r\n", resolve));
    expect(readTerminalOutput("tab-x")?.output).toBe("real-xterm\r\n");
    xterm.dispose();
  });
});

describe("dispatchCommand readTerminalOutput", () => {
  const TAP = { output: "x", written: 1, writes: 1, truncated: false, msSinceLastWrite: 3 };

  it("reads the active tab's stream", async () => {
    const deps = depsWith({
      getActiveTabId: () => "tab-1",
      readTerminalOutput: (tabId) => (tabId === "tab-1" ? TAP : undefined),
    });
    const res = await dispatchCommand({ action: "readTerminalOutput" }, deps);
    expect(res).toEqual({ ok: true, action: "readTerminalOutput", value: TAP });
  });

  it("fails for an untapped tab, with no active tab, and when unavailable", async () => {
    const unknown = await dispatchCommand(
      { action: "readTerminalOutput", tabId: "tab-9" },
      depsWith({ readTerminalOutput: () => undefined })
    );
    expect(unknown.error).toMatch(/no output recorded for tab "tab-9"/);
    const noActive = await dispatchCommand(
      { action: "readTerminalOutput" },
      depsWith({ readTerminalOutput: () => TAP })
    );
    expect(noActive.error).toMatch(/no active terminal/);
    const missing = await dispatchCommand({ action: "readTerminalOutput" }, depsWith({}));
    expect(missing.error).toMatch(/not available/);
  });
});

describe("dispatchCommand readFrontendLog", () => {
  it("returns the history, filtered by message substring", async () => {
    frontendLog("terminal", "renderer webgl (visible) tab=t1");
    frontendLog("terminal", "something else");
    const deps = depsWith({
      readFrontendLog: () =>
        getFrontendLogHistory().map((e) => ({
          timestampMs: e.timestampMs ?? 0,
          level: e.level,
          target: e.target,
          message: e.message,
        })),
    });
    const all = await dispatchCommand({ action: "readFrontendLog" }, deps);
    expect(all.ok).toBe(true);
    expect((all.value as unknown[]).length).toBe(2);
    const some = await dispatchCommand({ action: "readFrontendLog", contains: "renderer" }, deps);
    expect(some.value).toEqual([
      expect.objectContaining({
        level: "DEBUG",
        target: "frontend::terminal",
        message: "renderer webgl (visible) tab=t1",
      }),
    ]);
  });

  it("fails when the history is not wired", async () => {
    const res = await dispatchCommand({ action: "readFrontendLog" }, depsWith({}));
    expect(res.error).toMatch(/not available/);
  });
});
