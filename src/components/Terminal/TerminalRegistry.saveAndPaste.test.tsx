/**
 * Automated replacements for legacy manual items (#3681, audit TIN-015):
 *
 * - MT-TAB-08 — "Save to File" opens the save dialog with the default filename.
 * - MT-TAB-10 — cancelling the save dialog writes nothing and offers no tab.
 * - MT-TAB-13 — "Ask again" off saves silently; on (default) offers the tab.
 * - MT-KB-05  — a single-target paste above 5000 characters asks first; at the
 *   threshold it pastes straight away.
 *
 * The native dialog itself stays covered by the guided-manual
 * `tests/system/tests/test_native_dialogs.py`; these tests lock the app-side
 * decisions around it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { TerminalPortalProvider, useTerminalRegistry } from "./TerminalRegistry";
import { sendInput } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
  getXtermTheme: vi.fn(() => ({})),
}));

vi.mock("@/services/api", () => ({
  sendInput: vi.fn().mockResolvedValue(undefined),
}));

const mockReadClipboard = vi.fn().mockResolvedValue("");

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: (...args: unknown[]) => mockReadClipboard(...args),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

setupSettingsRegion();

function mockXterm(): XTerm {
  return {
    cols: 80,
    rows: 24,
    modes: { bracketedPasteMode: false },
    buffer: {
      active: {
        length: 1,
        getLine: vi.fn(() => ({
          isWrapped: false,
          translateToString: () => "saved output",
        })),
      },
    },
  } as unknown as XTerm;
}

function mockFit(): FitAddon {
  return {
    fit: vi.fn(),
    proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
  } as unknown as FitAddon;
}

let container: HTMLDivElement;
let root: Root;
let registry: ReturnType<typeof useTerminalRegistry>;

function Consumer() {
  registry = useTerminalRegistry();
  return null;
}

beforeEach(() => {
  vi.mocked(save).mockReset();
  vi.mocked(writeTextFile).mockReset();
  vi.mocked(sendInput).mockClear();
  mockReadClipboard.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Consumer />
      </TerminalPortalProvider>
    );
  });
  act(() => {
    registry.register("tab-save", document.createElement("div"), mockXterm(), mockFit());
    registry.registerSession("tab-save", "session-save");
  });
});

afterEach(() => {
  act(() => {
    useAppStore.getState().closeLargePasteDialog();
    useAppStore.getState().closeOpenSavedFileDialog();
  });
  act(() => root.unmount());
  container.remove();
});

describe("Save to File (MT-TAB-08/10/13)", () => {
  it("opens the save dialog with the terminal-output.txt default name (MT-TAB-08)", async () => {
    vi.mocked(save).mockResolvedValue(null);
    await act(async () => {
      await registry.saveTerminalToFile("tab-save");
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "terminal-output.txt" })
    );
  });

  it("writes nothing and offers no tab when the dialog is cancelled (MT-TAB-10)", async () => {
    vi.mocked(save).mockResolvedValue(null);
    await act(async () => {
      await registry.saveTerminalToFile("tab-save");
    });
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(useAppStore.getState().openSavedFileDialog.open).toBe(false);
  });

  it("offers to open the saved file by default (MT-TAB-13, ask again on)", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/out.txt");
    await act(async () => {
      await registry.saveTerminalToFile("tab-save");
    });
    expect(writeTextFile).toHaveBeenCalledWith("/tmp/out.txt", expect.stringContaining("saved"));
    expect(useAppStore.getState().openSavedFileDialog.open).toBe(true);
  });

  it("saves silently when 'Ask again' is off (MT-TAB-13)", async () => {
    seedSettings({ askOpenSavedFileInTab: false });
    vi.mocked(save).mockResolvedValue("/tmp/out.txt");
    await act(async () => {
      await registry.saveTerminalToFile("tab-save");
    });
    expect(writeTextFile).toHaveBeenCalledWith("/tmp/out.txt", expect.any(String));
    expect(useAppStore.getState().openSavedFileDialog.open).toBe(false);
  });
});

describe("large paste confirmation (MT-KB-05)", () => {
  it("asks before pasting more than 5000 characters and sends only on confirm", async () => {
    const text = "x".repeat(5001);
    mockReadClipboard.mockResolvedValue(text);
    await act(async () => {
      await registry.pasteToTerminal("tab-save");
    });
    const dialog = useAppStore.getState().largePasteDialog;
    expect(dialog.open).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();

    await act(async () => {
      await dialog.onConfirm?.();
    });
    expect(sendInput).toHaveBeenCalledWith("session-save", text);
  });

  it("pastes exactly 5000 characters without asking", async () => {
    const text = "y".repeat(5000);
    mockReadClipboard.mockResolvedValue(text);
    await act(async () => {
      await registry.pasteToTerminal("tab-save");
    });
    expect(useAppStore.getState().largePasteDialog.open).toBe(false);
    expect(sendInput).toHaveBeenCalledWith("session-save", text);
  });
});
