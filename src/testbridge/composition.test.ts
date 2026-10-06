/**
 * The `compose` bridge verb's IME replay (#3059), driven against the REAL
 * `@xterm/xterm` input path: xterm's `CompositionHelper` reads the textarea's
 * value around the composition events and sends the commit from a deferred
 * `setTimeout`, which is exactly where a duplicate or partial commit would come
 * from. These prove the replay commits the text once through `onData`, and pin
 * the dispatcher routing for `compose` and `readTerminalCells`. The same verb
 * runs in a real WebView (terminal + Monaco) in
 * `tests/system/tests/test_ime_composition.py` (nightly).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { isComposableControl, replayComposition } from "./composition";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import type { TerminalCellRow } from "./protocol";

/** Inert deps; the verbs under test and the active tab come from the caller. */
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

describe("replayComposition into the real xterm textarea", () => {
  let term: XTerm;
  let host: HTMLDivElement;
  let sent: string[];

  beforeEach(() => {
    term = new XTerm({ cols: 40, rows: 6, allowProposedApi: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    term.open(host);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    sent = [];
    term.onData((d) => sent.push(d));
  });

  afterEach(() => {
    term.dispose();
    host.remove();
  });

  it("sends the committed text exactly once — no preedit, no duplicate", async () => {
    await replayComposition(term.textarea!, ["に", "にほ", "にほん", "日本"], "日本語");
    expect(sent).toEqual(["日本語"]);
  });

  it("commits back-to-back compositions separately and in order", async () => {
    await replayComposition(term.textarea!, ["か", "かん"], "漢");
    await replayComposition(term.textarea!, ["じ"], "字");
    expect(sent).toEqual(["漢", "字"]);
  });

  it("commits a Korean syllable whose preedit changes shape (no partial jamo)", async () => {
    await replayComposition(term.textarea!, ["ㅎ", "하", "한"], "한");
    expect(sent).toEqual(["한"]);
  });

  it("sends nothing for a composition cancelled to an empty commit", async () => {
    await replayComposition(term.textarea!, ["に"], "");
    expect(sent).toEqual([]);
  });
});

describe("replayComposition on a plain control", () => {
  it("inserts the commit at the caret and fires the composition sequence", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.value = "ab";
    input.setSelectionRange(1, 1);
    const events: string[] = [];
    for (const type of ["compositionstart", "compositionupdate", "compositionend", "input"]) {
      input.addEventListener(type, (e) => {
        const data = (e as CompositionEvent | InputEvent).data ?? "";
        events.push(`${type}:${data}:${input.value}`);
      });
    }
    await replayComposition(input, ["に"], "日");
    expect(input.value).toBe("a日b");
    expect(events).toEqual([
      "compositionstart::ab",
      "compositionupdate:に:aにb",
      "input:に:aにb",
      "input:日:a日b",
      "compositionend:日:a日b",
    ]);
    input.remove();
  });

  it("recognises only inputs and textareas as composable", () => {
    expect(isComposableControl(document.createElement("textarea"))).toBe(true);
    expect(isComposableControl(document.createElement("input"))).toBe(true);
    expect(isComposableControl(document.createElement("div"))).toBe(false);
  });
});

describe("dispatchCommand compose", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("composes into the testId control", async () => {
    document.body.innerHTML = `<textarea data-testid="editor-input"></textarea>`;
    const res = await dispatchCommand(
      { action: "compose", testId: "editor-input", updates: ["に"], commit: "日" },
      depsWith({})
    );
    expect(res).toEqual({ ok: true, action: "compose" });
    expect(document.querySelector("textarea")!.value).toBe("日");
  });

  it("defaults to the active terminal's input textarea", async () => {
    const textarea = document.createElement("textarea");
    const res = await dispatchCommand(
      { action: "compose", updates: [], commit: "語" },
      depsWith({
        getActiveTabId: () => "tab-1",
        getTerminalInputElement: (tabId) => (tabId === "tab-1" ? textarea : undefined),
      })
    );
    expect(res.ok).toBe(true);
    expect(textarea.value).toBe("語");
  });

  it("fails clearly for a missing target, a non-control, or no terminal", async () => {
    document.body.innerHTML = `<div data-testid="plain"></div>`;
    const missing = await dispatchCommand(
      { action: "compose", testId: "ghost", updates: [], commit: "x" },
      depsWith({})
    );
    expect(missing.error).toMatch(/no element with data-testid="ghost"/);
    const plain = await dispatchCommand(
      { action: "compose", testId: "plain", updates: [], commit: "x" },
      depsWith({})
    );
    expect(plain.error).toMatch(/not an input or textarea/);
    const unwired = await dispatchCommand(
      { action: "compose", updates: [], commit: "x" },
      depsWith({ getActiveTabId: () => "t" })
    );
    expect(unwired.error).toMatch(/not available/);
    const noTab = await dispatchCommand(
      { action: "compose", updates: [], commit: "x" },
      depsWith({ getTerminalInputElement: () => undefined })
    );
    expect(noTab.error).toMatch(/no active terminal/);
  });

  it("rejects a malformed command", async () => {
    const res = await dispatchCommand(
      { action: "compose", testId: "x", commit: "x" } as unknown as Parameters<
        typeof dispatchCommand
      >[0],
      depsWith({})
    );
    expect(res.error).toMatch(/needs `updates`/);
  });
});

describe("dispatchCommand readTerminalCells", () => {
  const ROWS: TerminalCellRow[] = [{ y: 3, text: "日", cells: [{ x: 0, chars: "日", width: 2 }] }];

  it("reads the active tab with the filter, normalising a JSON null to no filter", async () => {
    const calls: [string, string | undefined][] = [];
    const deps = depsWith({
      getActiveTabId: () => "tab-1",
      readTerminalCells: (tabId, contains) => {
        calls.push([tabId, contains]);
        return ROWS;
      },
    });
    expect(await dispatchCommand({ action: "readTerminalCells", contains: "日" }, deps)).toEqual({
      ok: true,
      action: "readTerminalCells",
      value: ROWS,
    });
    await dispatchCommand(
      { action: "readTerminalCells", tabId: "tab-2", contains: null } as unknown as Parameters<
        typeof dispatchCommand
      >[0],
      deps
    );
    expect(calls).toEqual([
      ["tab-1", "日"],
      ["tab-2", undefined],
    ]);
  });

  it("fails clearly when unwired, with no active tab, or for an unknown tab", async () => {
    const unwired = await dispatchCommand(
      { action: "readTerminalCells", tabId: "t" },
      depsWith({})
    );
    expect(unwired.error).toMatch(/not available/);
    const noTab = await dispatchCommand(
      { action: "readTerminalCells" },
      depsWith({ readTerminalCells: () => ROWS })
    );
    expect(noTab.error).toMatch(/no active terminal/);
    const ghost = await dispatchCommand(
      { action: "readTerminalCells", tabId: "ghost" },
      depsWith({ readTerminalCells: () => undefined })
    );
    expect(ghost.error).toMatch(/no terminal registered for tab "ghost"/);
  });
});
