/**
 * SM-003 (single-attach): while another desktop/window controls a tab's session
 * (region status `evicted`), typed input must never be sent — and after an
 * explicit Reclaim (`evicted → connected`) input flows again and this terminal
 * re-asserts its PTY size (the other desktop may have resized it).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { ensureSessionSubscribed } from "@/store/sessionBridge";
import {
  connected,
  evicted,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";

let capturedOnData: ((data: string) => void) | undefined;

vi.mock("@xterm/xterm", async () => {
  const { MockXTerm } = await import("@/test/mockXterm");
  const { vi: vitest } = await import("vitest");

  class InputMockXTerm extends MockXTerm {
    onData = vitest.fn((cb: (data: string) => void) => {
      capturedOnData = cb;
      return { dispose: vitest.fn() };
    });
  }

  return { Terminal: InputMockXTerm };
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
const mockResizeTerminal = vi.fn().mockResolvedValue(undefined);

vi.mock("@/services/api", () => ({
  createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
  sendInput: (...args: unknown[]) => mockSendInput(...args),
  resizeTerminal: (...args: unknown[]) => mockResizeTerminal(...args),
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

const harness = installSessionLifecycleHarness();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  mockCreateTerminal.mockClear();
  mockSendInput.mockClear();
  mockResizeTerminal.mockClear();
  capturedOnData = undefined;
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

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function mountTerminal() {
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
}

describe("Terminal — no input while evicted (SM-003)", () => {
  it("drops typed input while the tab is evicted and resumes after Reclaim", async () => {
    await ensureSessionSubscribed();
    harness.transport.setSession("tab-1", connected());
    await flushSessionRegion();
    await mountTerminal();

    // Another desktop takes the session over.
    harness.transport.setSession("tab-1", evicted());
    await flushSessionRegion();
    mockSendInput.mockClear();
    mockResizeTerminal.mockClear();

    act(() => {
      capturedOnData!("rm -rf build\r");
    });
    expect(mockSendInput).not.toHaveBeenCalled();

    // The user reclaims: the backend folds evicted → connected.
    harness.transport.setSession("tab-1", connected());
    await flushSessionRegion();
    expect(mockResizeTerminal).toHaveBeenCalledWith(
      "session-1",
      expect.any(Number),
      expect.any(Number)
    );

    act(() => {
      capturedOnData!("ls\r");
    });
    expect(mockSendInput).toHaveBeenCalledTimes(1);
    expect(mockSendInput).toHaveBeenCalledWith("session-1", "ls\r");
  });

  it("forwards input normally when the tab was never evicted", async () => {
    await ensureSessionSubscribed();
    harness.transport.setSession("tab-1", connected());
    await flushSessionRegion();
    await mountTerminal();
    mockSendInput.mockClear();
    mockResizeTerminal.mockClear();

    // A plain connected → connected refresh must not trigger the reclaim resize.
    harness.transport.setSession("tab-1", connected());
    await flushSessionRegion();
    expect(mockResizeTerminal).not.toHaveBeenCalled();

    act(() => {
      capturedOnData!("pwd\r");
    });
    expect(mockSendInput).toHaveBeenCalledWith("session-1", "pwd\r");
  });
});
