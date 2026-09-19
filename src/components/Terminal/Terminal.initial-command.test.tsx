/**
 * Regression tests for the workspace-launch initial command (FEC-003).
 *
 * Before the fix, the initial command was sent via a naked
 * `setTimeout(() => sendInput(sessionId, cmd + "\n"), 200)`:
 *   (a) the 200 ms was a guess — if the shell/PTY was not ready the command
 *       could be lost or garbled;
 *   (b) the timer was never cleared, so an unmount / session change inside the
 *       window sent input into a torn-down or wrong session.
 *
 * The fix is readiness-gated with a safety fallback:
 *   - the command is sent when the FIRST output chunk for the session arrives
 *     (proof the backend is live and accepting input);
 *   - a bounded fallback timer (200 ms) still sends it if no output arrives, so
 *     the command is never silently dropped;
 *   - it is sent exactly once (first-output vs fallback — whichever wins);
 *   - both the timer and the output subscription are torn down on cleanup, so a
 *     command never lands in a dead/replaced session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Capture the output subscription callback so tests can simulate the backend
// emitting its first chunk for the session.
let capturedOutputCb: ((data: Uint8Array) => void) | null = null;
const mockUnsubOutput = vi.fn();

vi.mock("@xterm/xterm", async () => {
  const { MockXTerm } = await import("@/test/mockXterm");
  return { Terminal: MockXTerm };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    dispose = vi.fn();
  }
  return { FitAddon: MockFitAddon };
});

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {
    dispose = vi.fn();
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
    findNext = vi.fn();
    findPrevious = vi.fn();
    clearDecorations = vi.fn();
  },
}));

vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const SESSION_ID = "sess-fec003";
const mockSendInput = vi.fn().mockResolvedValue(undefined);

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn().mockResolvedValue("sess-fec003"),
  cancelConnecting: vi.fn().mockResolvedValue(undefined),
  sendInput: (...args: unknown[]) => mockSendInput(...args),
  setSessionLineEnding: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  detachPersistentTab: vi.fn().mockResolvedValue(0),
  getAgentSessionBuffer: vi.fn().mockResolvedValue(new Uint8Array()),
}));

vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: vi.fn((_sid: string, cb: (data: Uint8Array) => void) => {
      capturedOutputCb = cb;
      return mockUnsubOutput;
    }),
    subscribeExit: vi.fn(() => vi.fn()),
    clearPendingExit: vi.fn(),
    clearPendingOutput: vi.fn(),
  },
}));

vi.mock("@/services/keybindings", () => ({
  processKeyEvent: vi.fn(() => null),
  isAppShortcut: vi.fn(() => false),
  isChordPending: vi.fn(() => false),
  isShellReservedKey: vi.fn(() => false),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
  },
}));

globalThis.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

// ── Helpers ───────────────────────────────────────────────────────────────────

const LOCAL_CONFIG = { type: "local" as const, config: { shell: "/bin/bash" } };
const INITIAL_COMMAND = "echo ready";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  capturedOutputCb = null;
  mockSendInput.mockClear();
  mockUnsubOutput.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// Flush the async connect (all promise-driven, no real timers) so the output
// subscription is registered and the fallback timer is armed. Works under both
// real and fake timers.
async function mountAndConnect(props: Record<string, unknown> = {}) {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal
          tabId="tab-fec003"
          config={LOCAL_CONFIG}
          isVisible={true}
          initialCommand={INITIAL_COMMAND}
          {...props}
        />
      </TerminalPortalProvider>
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Terminal — initial command readiness (FEC-003)", () => {
  it("sends the initial command once when the first output chunk arrives", async () => {
    vi.useFakeTimers();
    try {
      await mountAndConnect();

      expect(capturedOutputCb).not.toBeNull();
      // Nothing sent yet — we have neither seen output nor hit the fallback.
      expect(mockSendInput).not.toHaveBeenCalled();

      // First output chunk = readiness signal → command is sent.
      act(() => capturedOutputCb!(new Uint8Array([0x24])));

      expect(mockSendInput).toHaveBeenCalledTimes(1);
      expect(mockSendInput).toHaveBeenCalledWith(SESSION_ID, INITIAL_COMMAND + "\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the initial command via the fallback timer when no output arrives", async () => {
    vi.useFakeTimers();
    try {
      await mountAndConnect();

      // No output emitted; before the fallback window nothing is sent.
      expect(mockSendInput).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(mockSendInput).toHaveBeenCalledTimes(1);
      expect(mockSendInput).toHaveBeenCalledWith(SESSION_ID, INITIAL_COMMAND + "\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never double-sends when output arrives and the fallback also elapses", async () => {
    vi.useFakeTimers();
    try {
      await mountAndConnect();

      // Several output chunks, then let the fallback window elapse.
      act(() => {
        capturedOutputCb!(new Uint8Array([0x24]));
        capturedOutputCb!(new Uint8Array([0x25]));
        capturedOutputCb!(new Uint8Array([0x26]));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(mockSendInput).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send into a dead session after unmount before output or fallback", async () => {
    vi.useFakeTimers();
    try {
      await mountAndConnect();
      const cb = capturedOutputCb!;

      // Tab closes inside the readiness window — before any output / fallback.
      act(() => root.unmount());

      // A late first-output chunk (racing teardown) must not send.
      act(() => cb(new Uint8Array([0x24])));
      // The fallback timer must have been cleared on cleanup.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(mockSendInput).not.toHaveBeenCalled();
    } finally {
      // afterEach unmounts again; harmless — cleanup is idempotent.
      vi.useRealTimers();
    }
  });

  it("does not send an initial command when attaching to an existing session", async () => {
    vi.useFakeTimers();
    try {
      // existingSessionId set → this is a reattach, not a fresh workspace launch;
      // the initial-command feature must stay inert (guard preserved).
      await mountAndConnect({ existingSessionId: "prior-session" });

      if (capturedOutputCb) act(() => capturedOutputCb!(new Uint8Array([0x24])));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(mockSendInput).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
