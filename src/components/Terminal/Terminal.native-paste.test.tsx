/**
 * Regression test for the Windows/WebView2 double-paste bug (#2595).
 *
 * A single right-click in the terminal inserted the clipboard TWICE. The first
 * insertion is termiHub's own right-click quick action (handleQuickAction →
 * pasteToTerminal), which is correctly debounced and in-flight-guarded. The
 * SECOND insertion is a *native* `paste` event that WebView2/RDP injects into
 * xterm's focused helper <textarea>; xterm's own `paste` listener reads the
 * clipboard and re-emits the text as terminal input via onData → sendInput,
 * bypassing every guard on termiHub's paste path.
 *
 * The fix attaches a capture-phase `paste` listener on xterm's textarea that
 * preventDefaults and stopImmediatePropagation's the event, so xterm's own
 * (bubble-phase) paste handler never runs and the native route can no longer
 * reach onData/sendInput. Every deliberate paste route (Ctrl+V, the right-click
 * quick action, the context-menu "Paste") goes through pasteToTerminal() and
 * does not dispatch a DOM paste event, so it is unaffected.
 *
 * This mock reproduces xterm's native paste path (a bubble-phase textarea `paste`
 * listener that emits via onData) so the test fails without the fix and passes
 * with it, while confirming ordinary typed input on onData still flows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";

// --- Mocks (mirror Terminal.strictmode-teardown.test.tsx) ---

// Captured by the mock xterm so the test can drive onData and the native paste
// route. Reset in beforeEach.
let capturedOnData: ((data: string) => void) | undefined;
let mockTextarea: HTMLTextAreaElement | undefined;

vi.mock("@xterm/xterm", async () => {
  const { MockXTerm } = await import("@/test/mockXterm");
  const { vi: vitest } = await import("vitest");

  class PasteMockXTerm extends MockXTerm {
    textarea: HTMLTextAreaElement;

    constructor(options?: Record<string, unknown>) {
      super(options);
      this.textarea = document.createElement("textarea");
    }

    // Capture the component's onData handler so the test can emit input the way
    // xterm would (both typed input and the native paste route below).
    onData = vitest.fn((cb: (data: string) => void) => {
      capturedOnData = cb;
      return { dispose: vitest.fn() };
    });

    // Faithful stand-in for xterm's open(): attach the helper textarea inside the
    // terminal element (mounted under the parent) and register xterm's OWN
    // native-paste listener — a bubble-phase `paste` handler on the textarea that
    // reads the clipboard and re-emits it via onData. This is exactly the path
    // #2595's second insertion travels; the component's capture-phase suppressor
    // must stop it.
    open = vitest.fn((parent: HTMLElement) => {
      this.element.appendChild(this.textarea);
      parent.appendChild(this.element);
      mockTextarea = this.textarea;
      this.textarea.addEventListener("paste", (e: Event) => {
        const clip = (e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
        capturedOnData?.(clip);
      });
    });
  }

  return { Terminal: PasteMockXTerm };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    dispose = vi.fn();
  }
  return { FitAddon: MockFitAddon };
});

vi.mock("@xterm/addon-unicode11", () => {
  class MockUnicode11Addon {
    dispose = vi.fn();
  }
  return { Unicode11Addon: MockUnicode11Addon };
});

vi.mock("@xterm/addon-search", () => {
  class MockSearchAddon {
    onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
  }
  return { SearchAddon: MockSearchAddon };
});

vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockCreateTerminal = vi.fn().mockResolvedValue("fresh-session");
const mockSendInput = vi.fn().mockResolvedValue(undefined);

vi.mock("@/services/api", () => ({
  createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
  sendInput: (...args: unknown[]) => mockSendInput(...args),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  detachPersistentTab: vi.fn().mockResolvedValue(0),
  getAgentSessionBuffer: vi.fn().mockResolvedValue(new Uint8Array()),
}));

vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: vi.fn(() => vi.fn()),
    subscribeExit: vi.fn(() => vi.fn()),
    clearPendingExit: vi.fn(),
    clearPendingOutput: vi.fn(),
  },
}));

vi.mock("@/services/keybindings", () => ({
  processKeyEvent: vi.fn(() => null),
  isAppShortcut: vi.fn(() => false),
  isChordPending: vi.fn(() => false),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn().mockResolvedValue(""),
}));

globalThis.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  mockCreateTerminal.mockClear();
  mockCreateTerminal.mockResolvedValue("fresh-session");
  mockSendInput.mockClear();
  capturedOnData = undefined;
  mockTextarea = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  container.remove();
});

const LOCAL_CONFIG = { type: "local" as const, config: {} };

/** Let the async setupTerminal settle so onData is wired and the session live. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** Dispatch a native `paste` event carrying `text` on the given textarea. */
function dispatchNativePaste(textarea: HTMLTextAreaElement, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  textarea.dispatchEvent(event);
  return event;
}

describe("Terminal — native paste suppression (#2595)", () => {
  it("does NOT let a native textarea paste reach onData/sendInput", async () => {
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal
            tabId="tab-1"
            config={LOCAL_CONFIG}
            isVisible={true}
            existingSessionId="session-1"
          />
        </TerminalPortalProvider>
      );
    });
    await settle();

    expect(mockTextarea).toBeDefined();
    expect(capturedOnData).toBeDefined();
    mockSendInput.mockClear();

    // A single native right-click paste on the focused helper textarea — the
    // #2595 duplicate route. The capture-phase suppressor must swallow it.
    const event = dispatchNativePaste(mockTextarea!, "duplicate-paste");

    expect(event.defaultPrevented).toBe(true);
    // xterm's own paste→onData handler never ran, so no input was sent.
    expect(mockSendInput).not.toHaveBeenCalled();
  });

  it("still forwards ordinary typed input via onData", async () => {
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal
            tabId="tab-1"
            config={LOCAL_CONFIG}
            isVisible={true}
            existingSessionId="session-1"
          />
        </TerminalPortalProvider>
      );
    });
    await settle();

    expect(capturedOnData).toBeDefined();
    mockSendInput.mockClear();

    // Typed input (not a DOM paste event) must still reach the backend exactly
    // once — proving the suppressor did not break the normal onData path.
    act(() => {
      capturedOnData!("ls\r");
    });

    expect(mockSendInput).toHaveBeenCalledTimes(1);
    expect(mockSendInput).toHaveBeenCalledWith("session-1", "ls\r");
  });
});
