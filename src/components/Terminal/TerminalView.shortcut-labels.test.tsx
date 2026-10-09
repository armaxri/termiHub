/**
 * The Toggle Sidebar tooltip/aria-label shows the effective binding from the
 * keybinding service (#4374, WA-FE2-003) instead of a hand-built string that
 * sniffed `navigator.platform` and showed the wrong key on Windows/Linux.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { clearOverrides, setOverride } from "@/services/keybindings";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("./TerminalRegistry", () => ({
  TerminalPortalProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./TerminalCommandBridge", () => ({ TerminalCommandBridge: () => null }));
vi.mock("@/testbridge/TestBridge", () => ({ TestBridge: () => null }));
vi.mock("./Terminal", () => ({ Terminal: () => null }));
vi.mock("@/components/ui", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  Button: ({
    icon,
    children,
    className,
    variant: _variant,
    size: _size,
    iconOnly: _iconOnly,
    fullWidth: _fullWidth,
    pendingLabel: _pendingLabel,
    errorToast: _errorToast,
    ...rest
  }: {
    icon?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <button className={["ui-btn", className].filter(Boolean).join(" ")} {...rest}>
      {icon}
      {children}
    </button>
  ),
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
vi.mock("./TabGroupChips", () => ({ TabGroupChips: () => null }));
vi.mock("./MacroRecordSaveDialog", () => ({ MacroRecordSaveDialog: () => null }));
vi.mock("./MacroPlaybackDialog", () => ({ MacroPlaybackDialog: () => null }));
vi.mock("./BroadcastScopeDialog", () => ({ BroadcastScopeDialog: () => null }));
vi.mock("@/components/SplitView", () => ({ SplitView: () => null }));
vi.mock("@/services/events", () => ({ terminalDispatcher: { init: vi.fn() } }));
vi.mock("@/services/api", () => ({
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  sessionLoggingStart: vi.fn(() => Promise.resolve("/tmp/session.log")),
  sessionLoggingStop: vi.fn(() => Promise.resolve(null)),
  sessionLoggingStatus: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { TerminalView } from "./TerminalView";

let container: HTMLDivElement;
let root: Root;

const originalUserAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, get: () => ua });
}

function sidebarToggle(): HTMLButtonElement {
  return document.querySelector(
    '[data-testid="terminal-view-toggle-sidebar"]'
  ) as HTMLButtonElement;
}

function renderView(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<TerminalView />));
}

describe("TerminalView — Toggle Sidebar shortcut label (#4374, WA-FE2-003)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearOverrides();
    if (originalUserAgent) Object.defineProperty(window.navigator, "userAgent", originalUserAgent);
    else delete (window.navigator as { userAgent?: string }).userAgent;
    vi.clearAllMocks();
  });

  it("shows Ctrl+Shift+B on Windows/Linux (Ctrl+B is the tmux prefix)", () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    renderView();
    expect(sidebarToggle().getAttribute("aria-label")).toBe("Toggle Sidebar (Ctrl+Shift+B)");
  });

  it("shows the Cmd binding on macOS", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    renderView();
    expect(sidebarToggle().getAttribute("aria-label")).toBe("Toggle Sidebar (Cmd+b)");
  });

  it("shows the user's customised binding", () => {
    setOverride("toggle-sidebar", { key: "F9" });
    renderView();
    expect(sidebarToggle().getAttribute("aria-label")).toBe("Toggle Sidebar (F9)");
  });
});
