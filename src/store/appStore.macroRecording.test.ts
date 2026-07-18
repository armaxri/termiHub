/**
 * Tests for the macro *recording* Zustand slice (#1674).
 *
 * Pins the recorder logic: starting a recording clears prior state, each
 * captured input chunk is appended as a `MacroStep` whose `delayMs` is the
 * elapsed time since the previous chunk (0 for the first), stopping opens the
 * save dialog only when something was captured, saving builds a macro payload
 * from the recorded steps, and cancelling/discarding drops the buffer without
 * persisting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the service modules the store imports at module load. The store pulls in
// the full graph, so stub the ones with side effects on import.
vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/macroApi", () => ({
  listMacros: vi.fn(() => Promise.resolve([])),
  getMacro: vi.fn(),
  saveMacro: vi.fn((m) => Promise.resolve(m)),
  deleteMacro: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "./appStore";
import { saveMacro as apiSaveMacro } from "@/services/macroApi";

describe("appStore — macro recording slice (#1674)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts recording with a clean, empty buffer", () => {
    // Seed some stale state to prove start clears it.
    useAppStore.setState({
      macroRecordingSteps: [{ data: "old", delayMs: 5 }],
      macroSaveDialogOpen: true,
    });

    useAppStore.getState().startMacroRecording();

    const s = useAppStore.getState();
    expect(s.macroRecording).toBe(true);
    expect(s.macroRecordingSteps).toEqual([]);
    expect(s.macroSaveDialogOpen).toBe(false);
  });

  it("appends captured input as steps with per-step delays (0 for the first)", () => {
    const now = vi.spyOn(Date, "now");

    useAppStore.getState().startMacroRecording();

    now.mockReturnValue(1000);
    useAppStore.getState().recordMacroInput("l");
    now.mockReturnValue(1200);
    useAppStore.getState().recordMacroInput("s");
    now.mockReturnValue(1250);
    useAppStore.getState().recordMacroInput("\r");

    expect(useAppStore.getState().macroRecordingSteps).toEqual([
      { data: "l", delayMs: 0 },
      { data: "s", delayMs: 200 },
      { data: "\r", delayMs: 50 },
    ]);
  });

  it("ignores input when not recording", () => {
    useAppStore.getState().recordMacroInput("noise");
    expect(useAppStore.getState().macroRecordingSteps).toEqual([]);
  });

  it("stopping after capture stops recording and opens the save dialog", () => {
    useAppStore.getState().startMacroRecording();
    useAppStore.getState().recordMacroInput("ls\r");
    useAppStore.getState().stopMacroRecording();

    const s = useAppStore.getState();
    expect(s.macroRecording).toBe(false);
    expect(s.macroSaveDialogOpen).toBe(true);
    // Steps are retained so the dialog can build the save payload.
    expect(s.macroRecordingSteps).toHaveLength(1);
  });

  it("stopping with no captured input does not open the save dialog", () => {
    useAppStore.getState().startMacroRecording();
    useAppStore.getState().stopMacroRecording();

    const s = useAppStore.getState();
    expect(s.macroRecording).toBe(false);
    expect(s.macroSaveDialogOpen).toBe(false);
    expect(s.macroRecordingSteps).toEqual([]);
  });

  it("toggle starts then stops recording", () => {
    useAppStore.getState().toggleMacroRecording();
    expect(useAppStore.getState().macroRecording).toBe(true);

    useAppStore.getState().recordMacroInput("x");
    useAppStore.getState().toggleMacroRecording();
    expect(useAppStore.getState().macroRecording).toBe(false);
    expect(useAppStore.getState().macroSaveDialogOpen).toBe(true);
  });

  it("cancelling discards the buffer without persisting", () => {
    useAppStore.getState().startMacroRecording();
    useAppStore.getState().recordMacroInput("secret");
    useAppStore.getState().cancelMacroRecording();

    const s = useAppStore.getState();
    expect(s.macroRecording).toBe(false);
    expect(s.macroRecordingSteps).toEqual([]);
    expect(s.macroSaveDialogOpen).toBe(false);
    expect(apiSaveMacro).not.toHaveBeenCalled();
  });

  it("saveRecordedMacro builds a macro payload from the recorded steps and clears state", async () => {
    const now = vi.spyOn(Date, "now");

    useAppStore.getState().startMacroRecording();
    now.mockReturnValue(1000);
    useAppStore.getState().recordMacroInput("echo hi");
    now.mockReturnValue(1300);
    useAppStore.getState().recordMacroInput("\r");
    useAppStore.getState().stopMacroRecording();

    await useAppStore.getState().saveRecordedMacro({
      name: "Greeting",
      description: "says hi",
      tags: ["demo"],
    });

    expect(apiSaveMacro).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(apiSaveMacro).mock.calls[0][0];
    expect(payload.name).toBe("Greeting");
    expect(payload.description).toBe("says hi");
    expect(payload.tags).toEqual(["demo"]);
    expect(payload.id).toBeTruthy();
    expect(payload.steps).toEqual([
      { data: "echo hi", delayMs: 0 },
      { data: "\r", delayMs: 300 },
    ]);

    // After a successful save the recording state is fully reset.
    const s = useAppStore.getState();
    expect(s.macroRecordingSteps).toEqual([]);
    expect(s.macroSaveDialogOpen).toBe(false);
  });

  it("discardRecordedMacro closes the dialog and drops the buffer", () => {
    useAppStore.getState().startMacroRecording();
    useAppStore.getState().recordMacroInput("x");
    useAppStore.getState().stopMacroRecording();
    expect(useAppStore.getState().macroSaveDialogOpen).toBe(true);

    useAppStore.getState().discardRecordedMacro();

    const s = useAppStore.getState();
    expect(s.macroSaveDialogOpen).toBe(false);
    expect(s.macroRecordingSteps).toEqual([]);
    expect(apiSaveMacro).not.toHaveBeenCalled();
  });
});
