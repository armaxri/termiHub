import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal as XTerm } from "@xterm/xterm";
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
    buffer: {
      active: {
        length: 1,
        getLine: vi.fn(() => ({ translateToString: () => "line content" })),
      },
    },
  } as unknown as XTerm;
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
      registryActions.register("tab-1", el, xterm);
    });

    expect(registryActions.getTerminalSelection("tab-1")).toBeUndefined();
    expect(xterm.hasSelection).toHaveBeenCalled();
  });

  it("returns the selection text when the terminal has a selection", () => {
    const xterm = createMockXterm("selected text");
    const el = document.createElement("div");

    act(() => {
      registryActions.register("tab-1", el, xterm);
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
      registryActions.register("tab-1", el, xterm);
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
      registryActions.register("tab-1", el, xterm);
    });

    await act(async () => {
      await registryActions.copySelectionToClipboard("tab-1");
    });

    expect(writeText).toHaveBeenCalledWith("hello world");
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
});
