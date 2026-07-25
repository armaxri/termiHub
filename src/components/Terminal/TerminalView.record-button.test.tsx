/**
 * The terminal toolbar exposes a record/stop button wired to the macro
 * recording store slice (#1674): it toggles recording and reflects the active
 * state so the user always sees whether input is being captured.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";

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
vi.mock("@/components/SplitView", () => ({ SplitView: () => null }));
vi.mock("@/services/events", () => ({ terminalDispatcher: { init: vi.fn() } }));
vi.mock("@/services/api", () => ({
  listAgentSessions: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { TerminalView } from "./TerminalView";

let container: HTMLDivElement;
let root: Root;

function recordButton(): HTMLButtonElement {
  return document.querySelector('[data-testid="terminal-view-record-macro"]') as HTMLButtonElement;
}

describe("TerminalView — macro record button (#1674)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<TerminalView />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the record button in an idle state", () => {
    const btn = recordButton();
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.className).not.toContain("terminal-view__toolbar-action--recording");
  });

  it("clicking starts recording and reflects the active state", () => {
    act(() => recordButton().click());

    expect(useAppStore.getState().macroRecording).toBe(true);
    const btn = recordButton();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.className).toContain("terminal-view__toolbar-action--recording");
  });

  it("clicking again stops recording (opening the save dialog after capture)", () => {
    act(() => recordButton().click());
    // Simulate captured input so stopping routes to the save dialog.
    act(() => useAppStore.getState().recordMacroInput("ls\r"));
    act(() => recordButton().click());

    expect(useAppStore.getState().macroRecording).toBe(false);
    expect(useAppStore.getState().macroSaveDialogOpen).toBe(true);
  });
});
