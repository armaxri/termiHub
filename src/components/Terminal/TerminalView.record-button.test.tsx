/**
 * The terminal toolbar's "…" menu exposes a record/stop entry (#5756) wired to the macro
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
vi.mock("@/components/ui", async () =>
  (await import("@/test/terminalViewUiMock")).terminalViewUiMock()
);
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
    expect(btn.getAttribute("data-active")).toBe("false");
    expect(btn.textContent).toBe("Record macro");
    expect(document.querySelector('[data-testid="terminal-view-active-recording"]')).toBeNull();
  });

  it("clicking starts recording and reflects the active state", () => {
    act(() => recordButton().click());

    expect(useAppStore.getState().macroRecording).toBe(true);
    const btn = recordButton();
    expect(btn.getAttribute("data-active")).toBe("true");
    expect(btn.textContent).toBe("Stop recording macro");
    // #5756: the recording stays visible as a chip while the menu is closed.
    expect(
      document.querySelector('[data-testid="terminal-view-active-recording"]')?.textContent
    ).toBe("Recording");
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
