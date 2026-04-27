import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TerminalPortalProvider, useTerminalRegistry } from "./TerminalRegistry";
import { sendInput } from "@/services/api";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", () => ({
  sendInput: vi.fn().mockResolvedValue(undefined),
}));

const mockReadClipboard = vi.fn().mockResolvedValue("");

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: (...args: unknown[]) => mockReadClipboard(...args),
}));

/** Creates a mock xterm instance with configurable selection state. */
function createMockXterm(selection?: string): XTerm {
  return {
    hasSelection: vi.fn(() => selection !== undefined),
    getSelection: vi.fn(() => selection ?? ""),
    clear: vi.fn(),
    write: vi.fn(),
    scrollToBottom: vi.fn(),
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
  it("does not write to clipboard when there is no selection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const xterm = createMockXterm(undefined);
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-1", el, xterm, createMockFitAddon());
    });

    await act(async () => {
      await registryActions.copySelectionToClipboard("tab-1");
    });

    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies selection text to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const xterm = createMockXterm("hello world");
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-1", el, xterm, createMockFitAddon());
    });

    await act(async () => {
      await registryActions.copySelectionToClipboard("tab-1");
    });

    expect(writeText).toHaveBeenCalledWith("hello world");
  });
});

describe("copyTerminalToClipboard", () => {
  it("trims trailing spaces from each line", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

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

    expect(writeText).toHaveBeenCalledWith("hello\nworld\n");
  });

  it("joins wrapped continuation rows into a single logical line", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

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

    expect(writeText).toHaveBeenCalledWith("Hello World\n");
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
});

describe("clearTerminal", () => {
  it("does nothing when no terminal is registered for the tabId", () => {
    // Should not throw
    act(() => {
      registryActions.clearTerminal("nonexistent");
    });
  });

  it("calls xterm.clear() to wipe the buffer", () => {
    const xterm = createMockXterm();
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-clear", el, xterm, createMockFitAddon());
    });

    act(() => {
      registryActions.clearTerminal("tab-clear");
    });

    expect(xterm.clear).toHaveBeenCalledOnce();
  });

  it("resets cursor to home position after clearing to eliminate rendering artifacts", () => {
    const xterm = createMockXterm();
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-clear", el, xterm, createMockFitAddon());
    });

    act(() => {
      registryActions.clearTerminal("tab-clear");
    });

    // \x1b[2J clears the visible screen, \x1b[H moves cursor to (0,0)
    expect(xterm.write).toHaveBeenCalledWith("\x1b[2J\x1b[H");
  });
});
