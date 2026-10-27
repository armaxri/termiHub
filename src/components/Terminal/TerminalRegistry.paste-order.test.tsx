/**
 * A paste keeps its place in keystroke order (#5026).
 *
 * The paste shortcut reads the clipboard asynchronously before it sends the
 * text. Keys typed after the shortcut used to go straight out, so a fast typist
 * (or injected input) could see the paste land after the following keys — the
 * Windows os-input run typed `echo PASTE_`, Ctrl+Shift+V, `_`, Enter and got the
 * pasted marker after the Enter. A real terminal inserts the paste where the
 * shortcut was pressed.
 *
 * `sendInput` here goes through the real session input gate, so the test sees
 * the order the backend would receive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TerminalPortalProvider, useTerminalRegistry } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import {
  isSessionInputHeld,
  resetSessionInputGatesForTests,
  whenSessionInputOpen,
} from "@/services/sessionInputGate";

const sent: string[] = [];

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
  getXtermTheme: vi.fn(() => ({})),
}));

vi.mock("@/services/api", () => ({
  // Mirrors the real sendInput: every send passes the session input gate.
  sendInput: vi.fn((sessionId: string, data: string) =>
    whenSessionInputOpen(sessionId, () => {
      sent.push(data);
      return Promise.resolve();
    })
  ),
}));

const mockReadClipboard = vi.fn();

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: (...args: unknown[]) => mockReadClipboard(...args),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

setupSettingsRegion();

const xtermModes = { bracketedPasteMode: false };

function mockXterm(): XTerm {
  return {
    cols: 80,
    rows: 24,
    modes: xtermModes,
    buffer: { active: { length: 0, getLine: vi.fn() } },
  } as unknown as XTerm;
}

function mockFit(): FitAddon {
  return {
    fit: vi.fn(),
    proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
  } as unknown as FitAddon;
}

/** A clipboard read the test resolves (or rejects) by hand. */
function slowClipboard() {
  let resolve!: (text: string) => void;
  let reject!: (err: Error) => void;
  mockReadClipboard.mockImplementationOnce(
    () =>
      new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      })
  );
  return { resolve: (t: string) => resolve(t), reject: (e: Error) => reject(e) };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** A keystroke as the terminal's onData path sends it. */
function typeKey(data: string): void {
  void whenSessionInputOpen("session-paste", () => {
    sent.push(data);
    return Promise.resolve();
  });
}

let container: HTMLDivElement;
let root: Root;
let registry: ReturnType<typeof useTerminalRegistry>;

function Consumer() {
  registry = useTerminalRegistry();
  return null;
}

beforeEach(() => {
  sent.length = 0;
  xtermModes.bracketedPasteMode = false;
  resetSessionInputGatesForTests();
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
    registry.register("tab-paste", document.createElement("div"), mockXterm(), mockFit());
    registry.registerSession("tab-paste", "session-paste");
  });
});

afterEach(() => {
  act(() => useAppStore.getState().closeLargePasteDialog());
  act(() => root.unmount());
  container.remove();
});

describe("paste keeps keystroke order (#5026)", () => {
  it("sends keys typed during a slow clipboard read after the pasted text", async () => {
    const clip = slowClipboard();
    let pasted!: Promise<void>;
    act(() => {
      pasted = registry.pasteToTerminal("tab-paste");
    });
    typeKey("_");
    typeKey("\r");
    await flush();
    expect(sent).toEqual([]);

    clip.resolve("PASTE_");
    await act(async () => {
      await pasted;
    });
    await flush();
    expect(sent).toEqual(["PASTE_", "_", "\r"]);
    expect(isSessionInputHeld("session-paste")).toBe(false);
  });

  it("keeps the bracketed-paste markers around the pasted text, ahead of later keys", async () => {
    xtermModes.bracketedPasteMode = true;
    const clip = slowClipboard();
    let pasted!: Promise<void>;
    act(() => {
      pasted = registry.pasteToTerminal("tab-paste");
    });
    typeKey("x");
    clip.resolve("ab");
    await act(async () => {
      await pasted;
    });
    await flush();
    expect(sent).toEqual(["\x1b[200~ab\x1b[201~", "x"]);
  });

  it("releases the slot when the clipboard read fails, sending later keys", async () => {
    const clip = slowClipboard();
    let pasted!: Promise<void>;
    act(() => {
      pasted = registry.pasteToTerminal("tab-paste");
    });
    typeKey("k");
    clip.reject(new Error("clipboard unavailable"));
    await act(async () => {
      await expect(pasted).rejects.toThrow("clipboard unavailable");
    });
    await flush();
    expect(sent).toEqual(["k"]);
    expect(isSessionInputHeld("session-paste")).toBe(false);
  });

  it("releases the slot when the clipboard is empty", async () => {
    const clip = slowClipboard();
    let pasted!: Promise<void>;
    act(() => {
      pasted = registry.pasteToTerminal("tab-paste");
    });
    typeKey("k");
    clip.resolve("");
    await act(async () => {
      await pasted;
    });
    await flush();
    expect(sent).toEqual(["k"]);
  });

  it("holds later keys behind a large paste until it is confirmed", async () => {
    const text = "y".repeat(5001);
    const clip = slowClipboard();
    let pasted!: Promise<void>;
    act(() => {
      pasted = registry.pasteToTerminal("tab-paste");
    });
    typeKey("k");
    clip.resolve(text);
    await act(async () => {
      await pasted;
    });
    const dialog = useAppStore.getState().largePasteDialog;
    expect(dialog.open).toBe(true);
    await flush();
    expect(sent).toEqual([]);

    await act(async () => {
      await dialog.onConfirm?.();
    });
    await flush();
    expect(sent).toEqual([text, "k"]);
  });

  it("releases the slot without dropping later keys when a large paste is declined", async () => {
    const clip = slowClipboard();
    let pasted!: Promise<void>;
    act(() => {
      pasted = registry.pasteToTerminal("tab-paste");
    });
    typeKey("k");
    clip.resolve("z".repeat(5001));
    await act(async () => {
      await pasted;
    });
    const dialog = useAppStore.getState().largePasteDialog;
    expect(dialog.open).toBe(true);

    act(() => dialog.onCancel?.());
    await flush();
    expect(sent).toEqual(["k"]);
    expect(isSessionInputHeld("session-paste")).toBe(false);
  });
});
