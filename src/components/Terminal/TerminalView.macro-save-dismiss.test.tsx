/**
 * TerminalView wires the "Save Recorded Macro" dialog to the macro store slice
 * (#5201). A passive dismiss (Escape, a scrim click, the X) must keep the
 * captured steps; only a confirmed discard clears them, and Save persists them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { Macro } from "@/types/macro";
import { flushAsync } from "@/test/flushAsync";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("./TerminalRegistry", () => ({
  TerminalPortalProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./TerminalCommandBridge", () => ({ TerminalCommandBridge: () => null }));
vi.mock("@/testbridge/TestBridge", () => ({ TestBridge: () => null }));
vi.mock("./Terminal", () => ({ Terminal: () => null }));
vi.mock("@/components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui")>()),
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
vi.mock("./TabGroupChips", () => ({ TabGroupChips: () => null }));
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

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** Record two inputs, then stop so the save dialog opens with them pending. */
async function openSaveDialogWithSteps() {
  act(() => {
    const s = useAppStore.getState();
    s.startMacroRecording();
    s.recordMacroInput("ls\r");
    s.recordMacroInput("pwd\r");
    s.stopMacroRecording();
  });
  await flushAsync();
}

function setName(value: string) {
  const input = q("macro-save-name") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const dismissPaths: Array<[string, () => void]> = [
  [
    "Escape",
    () =>
      act(() => {
        q("macro-save-name")!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      }),
  ],
  [
    "a scrim click",
    () =>
      act(() => {
        q("macro-save-dialog-overlay")!.dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
        );
      }),
  ],
  ["the X button", () => act(() => q("modal-close")!.click())],
];

describe("TerminalView — macro save dialog dismissal (#5201)", () => {
  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<TerminalView />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it.each(dismissPaths)("%s keeps the recorded steps and the dialog", async (_label, dismiss) => {
    await openSaveDialogWithSteps();
    expect(useAppStore.getState().macroSaveDialogOpen).toBe(true);

    dismiss();
    // Backing out of the prompt returns to the dialog with the capture intact.
    act(() => q("unsaved-changes-cancel")!.click());

    const state = useAppStore.getState();
    expect(state.macroRecordingSteps).toHaveLength(2);
    expect(state.macroSaveDialogOpen).toBe(true);
    expect(q("macro-save-dialog")).not.toBeNull();
  });

  it("Discard recording clears the steps only after confirmation", async () => {
    await openSaveDialogWithSteps();

    act(() => q("macro-save-discard")!.click());
    expect(useAppStore.getState().macroRecordingSteps).toHaveLength(2);

    act(() => q("unsaved-changes-just-close")!.click());
    const state = useAppStore.getState();
    expect(state.macroRecordingSteps).toHaveLength(0);
    expect(state.macroSaveDialogOpen).toBe(false);
  });

  it("Save persists the recorded steps", async () => {
    const saveMacroToBackend = vi.fn((macro: Macro) => Promise.resolve(macro));
    useAppStore.setState({ saveMacroToBackend });
    await openSaveDialogWithSteps();

    setName("Deploy");
    await act(async () => q("macro-save-confirm")!.click());

    expect(saveMacroToBackend).toHaveBeenCalledTimes(1);
    const saved = saveMacroToBackend.mock.calls[0][0];
    expect(saved.name).toBe("Deploy");
    expect(saved.steps).toHaveLength(2);
    expect(useAppStore.getState().macroSaveDialogOpen).toBe(false);
  });
});
