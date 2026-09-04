import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TerminalPortalProvider, useTerminalRegistry, PASTE_DEBOUNCE_MS } from "./TerminalRegistry";
import { sendInput } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { ensureBroadcastSubscribed } from "@/store/broadcastBridge";
import { installBroadcastHarness } from "@/test/broadcastHarness";
import type { TerminalTab } from "@/types/terminal";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", () => ({
  sendInput: vi.fn().mockResolvedValue(undefined),
}));

const mockReadClipboard = vi.fn().mockResolvedValue("");
const mockWriteClipboard = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: (...args: unknown[]) => mockReadClipboard(...args),
  writeText: (...args: unknown[]) => mockWriteClipboard(...args),
}));

/** Creates a mock xterm instance with configurable selection state. */
function createMockXterm(selection?: string): XTerm {
  return {
    hasSelection: vi.fn(() => selection !== undefined),
    getSelection: vi.fn(() => selection ?? ""),
    // Immediately invoke the optional write callback so downstream logic (e.g.
    // clearTerminal) that chains work in the callback can be tested synchronously.
    write: vi.fn((_data: unknown, cb?: () => void) => cb?.()),
    clear: vi.fn(),
    scrollToBottom: vi.fn(),
    refresh: vi.fn(),
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        length: 1,
        getLine: vi.fn(() => ({ translateToString: () => "line content" })),
      },
    },
  } as unknown as XTerm;
}

/** Creates a minimal mock FitAddon for testing. */
function createMockFitAddon(): FitAddon {
  return { fit: vi.fn() } as unknown as FitAddon;
}

let container: HTMLDivElement;
let root: Root;
let registryActions: ReturnType<typeof useTerminalRegistry>;

/** Test component that captures registry context for assertions. */
function TestConsumer() {
  registryActions = useTerminalRegistry();
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(
      <TerminalPortalProvider>
        <TestConsumer />
      </TerminalPortalProvider>
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("getTerminalSelection", () => {
  it("returns undefined when no terminal is registered for the tabId", () => {
    expect(registryActions.getTerminalSelection("nonexistent")).toBeUndefined();
  });

  it("returns undefined when the terminal has no selection", () => {
    const xterm = createMockXterm(undefined);
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-1", el, xterm, createMockFitAddon());
    });

    expect(registryActions.getTerminalSelection("tab-1")).toBeUndefined();
    expect(xterm.hasSelection).toHaveBeenCalled();
  });

  it("returns the selection text when the terminal has a selection", () => {
    const xterm = createMockXterm("selected text");
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-1", el, xterm, createMockFitAddon());
    });

    expect(registryActions.getTerminalSelection("tab-1")).toBe("selected text");
    expect(xterm.hasSelection).toHaveBeenCalled();
    expect(xterm.getSelection).toHaveBeenCalled();
  });
});

describe("copySelectionToClipboard", () => {
  beforeEach(() => {
    mockWriteClipboard.mockClear();
  });

  it("does not write to clipboard when there is no selection", async () => {
    const xterm = createMockXterm(undefined);
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-1", el, xterm, createMockFitAddon());
    });

    await act(async () => {
      await registryActions.copySelectionToClipboard("tab-1");
    });

    expect(mockWriteClipboard).not.toHaveBeenCalled();
  });

  it("copies selection text via the OS clipboard plugin (not navigator.clipboard)", async () => {
    // The web clipboard API rejects on macOS/WKWebView when the document isn't
    // focused, silently dropping the copy. Route through the Tauri plugin (like
    // paste) so copy works regardless of window focus.
    const navigatorWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: navigatorWriteText } });

    const xterm = createMockXterm("hello world");
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-1", el, xterm, createMockFitAddon());
    });

    await act(async () => {
      await registryActions.copySelectionToClipboard("tab-1");
    });

    expect(mockWriteClipboard).toHaveBeenCalledWith("hello world");
    expect(navigatorWriteText).not.toHaveBeenCalled();
  });
});

describe("copyTerminalToClipboard", () => {
  beforeEach(() => {
    mockWriteClipboard.mockClear();
  });

  it("copies the whole buffer via the OS clipboard plugin (not navigator.clipboard)", async () => {
    // Same focus-independence requirement as copySelectionToClipboard: the
    // whole-buffer copy must also go through the Tauri plugin.
    const navigatorWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: navigatorWriteText } });

    const xterm = {
      buffer: {
        active: {
          length: 1,
          getLine: vi.fn(() => ({
            isWrapped: false,
            translateToString: (trimRight?: boolean) => (trimRight ? "hello" : "hello   "),
          })),
        },
      },
    } as unknown as XTerm;

    const el = document.createElement("div");
    act(() => {
      registryActions.register("tab-plugin", el, xterm, createMockFitAddon());
    });

    await act(async () => {
      await registryActions.copyTerminalToClipboard("tab-plugin");
    });

    expect(mockWriteClipboard).toHaveBeenCalledWith("hello\n");
    expect(navigatorWriteText).not.toHaveBeenCalled();
  });

  it("trims trailing spaces from each line", async () => {
    const xterm = {
      buffer: {
        active: {
          length: 2,
          getLine: vi.fn((i: number) => {
            if (i === 0)
              return {
                isWrapped: false,
                translateToString: (trimRight?: boolean) => (trimRight ? "hello" : "hello     "),
              };
            if (i === 1)
              return {
                isWrapped: false,
                translateToString: (trimRight?: boolean) => (trimRight ? "world" : "world     "),
              };
            return null;
          }),
        },
      },
    } as unknown as XTerm;

    const el = document.createElement("div");
    act(() => {
      registryActions.register("tab-trim", el, xterm, createMockFitAddon());
    });

    await act(async () => {
      await registryActions.copyTerminalToClipboard("tab-trim");
    });

    expect(mockWriteClipboard).toHaveBeenCalledWith("hello\nworld\n");
  });

  it("joins wrapped continuation rows into a single logical line", async () => {
    // Simulates "Hello World" in a 10-column terminal:
    // row 0: "Hello Worl" fills the terminal width (isWrapped=false)
    // row 1: "d         " is the continuation (isWrapped=true)
    const xterm = {
      buffer: {
        active: {
          length: 2,
          getLine: vi.fn((i: number) => {
            if (i === 0)
              return {
                isWrapped: false,
                translateToString: (_trimRight?: boolean) => "Hello Worl",
              };
            if (i === 1)
              return {
                isWrapped: true,
                translateToString: (trimRight?: boolean) => (trimRight ? "d" : "d         "),
              };
            return null;
          }),
        },
      },
    } as unknown as XTerm;

    const el = document.createElement("div");
    act(() => {
      registryActions.register("tab-wrap", el, xterm, createMockFitAddon());
    });

    await act(async () => {
      await registryActions.copyTerminalToClipboard("tab-wrap");
    });

    expect(mockWriteClipboard).toHaveBeenCalledWith("Hello World\n");
  });
});

describe("clearTerminal", () => {
  it("does nothing when no terminal is registered for the tabId", () => {
    // Should not throw
    act(() => {
      registryActions.clearTerminal("nonexistent");
    });
  });

  it("erases the entire display and resets cursor to (0,0) via VT sequence", () => {
    const xterm = createMockXterm();
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-clear", el, xterm, createMockFitAddon());
    });

    act(() => {
      registryActions.clearTerminal("tab-clear");
    });

    // \x1b[2J erases the entire viewport (including the prompt line that
    // xterm.clear() would otherwise preserve as the "new first line").
    // \x1b[H then moves the cursor to (0,0) so subsequent output starts at the
    // top rather than at the old cursor position.
    expect(xterm.write).toHaveBeenCalledWith("\x1b[2J\x1b[H", expect.any(Function));
  });

  it("clears the scrollback buffer after the VT erase is processed", () => {
    const xterm = createMockXterm();
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-scrollback", el, xterm, createMockFitAddon());
    });

    act(() => {
      registryActions.clearTerminal("tab-scrollback");
    });

    // xterm.clear() must run inside the write callback so it executes after the
    // VT erase sequence is applied — if called before, it would preserve the old
    // prompt line as the first line (xterm.js v6 "prompt line" semantics).
    expect(xterm.clear).toHaveBeenCalled();
  });
});

describe("pasteToTerminal", () => {
  it("reads clipboard and sends text as input via registered session", async () => {
    mockReadClipboard.mockResolvedValue("pasted text");

    act(() => {
      registryActions.registerSession("tab-1", "session-1");
    });

    await act(async () => {
      await registryActions.pasteToTerminal("tab-1");
    });

    expect(mockReadClipboard).toHaveBeenCalled();
    expect(sendInput).toHaveBeenCalledWith("session-1", "pasted text");
  });

  it("does not send input when clipboard is empty", async () => {
    mockReadClipboard.mockResolvedValue("");
    vi.mocked(sendInput).mockClear();

    act(() => {
      registryActions.registerSession("tab-1", "session-1");
    });

    await act(async () => {
      await registryActions.pasteToTerminal("tab-1");
    });

    expect(mockReadClipboard).toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does nothing when no session is registered for the tab", async () => {
    mockReadClipboard.mockClear();
    mockReadClipboard.mockResolvedValue("pasted text");
    vi.mocked(sendInput).mockClear();

    await act(async () => {
      await registryActions.pasteToTerminal("tab-no-session");
    });

    expect(mockReadClipboard).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("sends input exactly once per paste (no double-paste)", async () => {
    mockReadClipboard.mockResolvedValue("hello");
    vi.mocked(sendInput).mockClear();

    const xterm = {
      ...createMockXterm(),
      modes: { bracketedPasteMode: false },
    } as unknown as XTerm;
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-dup", el, xterm, createMockFitAddon());
      registryActions.registerSession("tab-dup", "session-dup");
    });

    await act(async () => {
      await registryActions.pasteToTerminal("tab-dup");
    });

    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith("session-dup", "hello");
  });

  it("broadcasts paste to all connected targets when broadcast is active (#1981)", async () => {
    vi.mocked(sendInput).mockClear();
    mockReadClipboard.mockResolvedValueOnce("cfg");
    // Broadcast membership is sourced from the authoritative region (#2206).
    const harness = installBroadcastHarness();
    await ensureBroadcastSubscribed();
    const mkTab = (id: string): TerminalTab => ({
      id,
      sessionId: `session-${id}`,
      title: id,
      connectionType: "local",
      contentType: "terminal",
      config: { type: "local", config: {} },
      panelId: "leaf-1",
      isActive: false,
    });
    // Two connected terminals, broadcast active from the source. getBroadcast-
    // TargetTabIds treats a tab with a sessionId and no error/exit flag as
    // connected (deriveTabStatus default).
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      rootPanel: {
        type: "leaf",
        id: "leaf-1",
        tabs: [mkTab("src"), mkTab("t2")],
        activeTabId: "src",
      },
      activePanelId: "leaf-1",
    });
    // Broadcast active from the source over both connected terminals.
    harness.transport.seed({
      active: true,
      sourceTabId: "src",
      scope: "all",
      targetTabIds: ["src", "t2"],
    });
    act(() => {
      registryActions.registerSession("src", "session-src");
      registryActions.registerSession("t2", "session-t2");
    });

    await act(async () => {
      await registryActions.pasteToTerminal("src");
    });

    // Both target sessions receive the paste (not just the source).
    expect(sendInput).toHaveBeenCalledWith("session-src", "cfg");
    expect(sendInput).toHaveBeenCalledWith("session-t2", "cfg");
    expect(sendInput).toHaveBeenCalledTimes(2);
    harness.teardown();
  });
});

describe("pasteToTerminal debounce against bounced mouse signals (#2595)", () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;
  let currentNow: number;

  beforeEach(() => {
    // Drive the debounce clock deterministically. A bounced right-click on
    // Windows fires two paste triggers a couple of ms apart for one gesture;
    // the guard must swallow the second. We control Date.now so no real timers
    // are involved.
    currentNow = 1_000_000;
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentNow);
    mockReadClipboard.mockResolvedValue("bounced");
    vi.mocked(sendInput).mockClear();
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it("pastes only once when two triggers for the same tab land inside the window", async () => {
    act(() => {
      registryActions.registerSession("tab-bounce", "session-bounce");
    });

    // Two triggers a few ms apart — a duplicated/bounced OS mouse signal.
    await act(async () => {
      await registryActions.pasteToTerminal("tab-bounce");
      currentNow += Math.floor(PASTE_DEBOUNCE_MS / 2);
      await registryActions.pasteToTerminal("tab-bounce");
    });

    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith("session-bounce", "bounced");
  });

  it("pastes twice when two deliberate triggers are spaced beyond the window", async () => {
    act(() => {
      registryActions.registerSession("tab-deliberate", "session-deliberate");
    });

    await act(async () => {
      await registryActions.pasteToTerminal("tab-deliberate");
      // A deliberate second paste well outside the guard window still applies.
      currentNow += PASTE_DEBOUNCE_MS + 5;
      await registryActions.pasteToTerminal("tab-deliberate");
    });

    expect(sendInput).toHaveBeenCalledTimes(2);
  });

  it("does not suppress a near-simultaneous paste into a different tab", async () => {
    act(() => {
      registryActions.registerSession("tab-a", "session-a");
      registryActions.registerSession("tab-b", "session-b");
    });

    // Same instant, different tabs — the guard is keyed by tab id, so both apply.
    await act(async () => {
      await registryActions.pasteToTerminal("tab-a");
      await registryActions.pasteToTerminal("tab-b");
    });

    expect(sendInput).toHaveBeenCalledTimes(2);
    expect(sendInput).toHaveBeenCalledWith("session-a", "bounced");
    expect(sendInput).toHaveBeenCalledWith("session-b", "bounced");
  });
});

describe("fitTerminal", () => {
  let rafSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Run the queued animation-frame callback synchronously so the post-fit
    // scroll + refresh can be asserted without waiting for a real frame.
    rafSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    rafSpy.mockRestore();
  });

  it("does nothing when no terminal is registered for the tabId", () => {
    // Should not throw
    act(() => {
      registryActions.fitTerminal("nonexistent");
    });
  });

  it("fits the addon and forces a full viewport repaint so reparented content shows", () => {
    // Regression for #1823: zooming a tab reparents the terminal element into the
    // overlay. fitAddon.fit() is a no-op when the new container yields the same
    // cols/rows, so without an explicit refresh the renderer keeps stale/blank
    // rows until the user scrolls. fitTerminal must fit AND refresh every row.
    const xterm = createMockXterm();
    const fitAddon = createMockFitAddon();
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-fit", el, xterm, fitAddon);
    });

    act(() => {
      registryActions.fitTerminal("tab-fit");
    });

    expect(fitAddon.fit).toHaveBeenCalled();
    expect(xterm.scrollToBottom).toHaveBeenCalled();
    // 80×24 mock → refresh the full 0..rows-1 range.
    expect(xterm.refresh).toHaveBeenCalledWith(0, 23);
  });
});

describe("sendInputToTerminal", () => {
  it("writes input to the registered session and reports success", async () => {
    vi.mocked(sendInput).mockClear();

    act(() => {
      registryActions.registerSession("tab-1", "session-1");
    });

    let sent: boolean | undefined;
    await act(async () => {
      sent = await registryActions.sendInputToTerminal("tab-1", "ls\n");
    });

    expect(sent).toBe(true);
    expect(sendInput).toHaveBeenCalledWith("session-1", "ls\n");
  });

  it("reports failure and sends nothing when no session is registered", async () => {
    vi.mocked(sendInput).mockClear();

    let sent: boolean | undefined;
    await act(async () => {
      sent = await registryActions.sendInputToTerminal("tab-no-session", "ls\n");
    });

    expect(sent).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();
  });
});
