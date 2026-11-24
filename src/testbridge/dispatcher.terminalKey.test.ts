/**
 * The `terminalKey` bridge verb (#5966) against a real opened xterm: the key
 * reaches xterm's own key handler (and the app's custom key handler behind it)
 * the way a real keystroke does, which a `pressKey` on the wrapper does not.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";

interface Mounted {
  term: Terminal;
  host: HTMLElement;
  data: string[];
  seen: string[];
  deps: BridgeDeps;
}

let mounted: Mounted | undefined;

/** Open a real xterm for tab `t1`; `swallowEnter` makes its custom handler eat Enter. */
function mount(swallowEnter = false): Mounted {
  const term = new Terminal();
  const host = document.createElement("div");
  host.setAttribute("data-testid", "terminal-wrapper");
  document.body.appendChild(host);
  term.open(host);
  const data: string[] = [];
  const seen: string[] = [];
  term.onData((d) => data.push(d));
  term.attachCustomKeyEventHandler((e) => {
    seen.push(`${e.type}:${e.key}`);
    return !(swallowEnter && e.key === "Enter");
  });
  const deps: BridgeDeps = {
    root: document.body,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => "t1",
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "data:image/png;base64,AAAA",
    emitEvent: async () => {},
    getTerminalInputElement: (tabId) => (tabId === "t1" ? term.textarea : undefined),
  };
  mounted = { term, host, data, seen, deps };
  return mounted;
}

afterEach(() => {
  mounted?.term.dispose();
  mounted?.host.remove();
  mounted = undefined;
});

describe("terminalKey", () => {
  it("delivers Enter through xterm's key path: the handler sees it and onData gets \\r", async () => {
    const { deps, data, seen } = mount();
    const res = await dispatchCommand({ action: "terminalKey", key: "Enter" }, deps);
    expect(res).toEqual({ ok: true, action: "terminalKey" });
    expect(seen).toContain("keydown:Enter");
    expect(data.join("")).toBe("\r");
  });

  it("a key the custom handler swallows sends nothing (the ended-terminal Enter)", async () => {
    const { deps, data, seen } = mount(true);
    await dispatchCommand({ action: "terminalKey", key: "Enter", tabId: "t1" }, deps);
    expect(seen).toContain("keydown:Enter");
    expect(data).toEqual([]);
  });

  it("a printable key arrives once, through keypress as in a browser", async () => {
    const { deps, data } = mount();
    await dispatchCommand({ action: "terminalKey", key: "a" }, deps);
    expect(data.join("")).toBe("a");
  });

  it("pressKey on the terminal's wrapper never reaches xterm (why this verb exists)", async () => {
    const { deps, data, seen } = mount();
    await dispatchCommand({ action: "pressKey", key: "Enter", testId: "terminal-wrapper" }, deps);
    expect(seen).toEqual([]);
    expect(data).toEqual([]);
  });

  it("fails for an unknown tab, without a terminal input, or without a key", async () => {
    const { deps } = mount();
    const ghost = await dispatchCommand({ action: "terminalKey", key: "a", tabId: "x" }, deps);
    expect(ghost.ok).toBe(false);
    expect(ghost.error).toContain('"x"');
    const bare = await dispatchCommand(
      { action: "terminalKey", key: "a" },
      { ...deps, getTerminalInputElement: undefined }
    );
    expect(bare.error).toContain("not available");
    const none = await dispatchCommand(
      { action: "terminalKey", key: "a" },
      { ...deps, getActiveTabId: () => undefined }
    );
    expect(none.error).toContain("no active terminal");
    const empty = await dispatchCommand({ action: "terminalKey", key: "" }, deps);
    expect(empty.error).toContain("needs a `key`");
  });
});
