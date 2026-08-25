/**
 * Clipboard-feedback test for the "Connection failed" dialog's suggested fix
 * commands (#1829).
 *
 * When a connection fails with a recoverable error (e.g. a serial permission
 * error), the dialog shows a shell command the user is meant to run. It used to
 * be display-only; this pins that a dedicated copy button writes the command to
 * the clipboard and confirms with a success toast, and that the command lives in
 * a copyable (selectable) element.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

const writeText = vi.fn((_text?: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string) => writeText(text),
}));

import { TerminalConnectionOverlay } from "./TerminalConnectionOverlay";
import { useAppStore } from "@/store/appStore";

const TAB_ID = "tab-copy";
const PANEL_ID = "panel-copy";
const SERIAL_COMMAND = "sudo usermod -aG dialout $USER";

let container: HTMLDivElement;
let root: Root;

function resetStore() {
  useAppStore.setState({
    terminalSpawnErrors: {},
    terminalAutoRetryCount: {},
    terminalWaitingForAgent: {},
    terminalRetryCounters: {},
    terminalReattaching: {},
  });
}

function renderSerialPermissionFailure() {
  useAppStore.setState({
    terminalSpawnErrors: { [TAB_ID]: "Permission denied on '/dev/ttyUSB0'" },
  });
  act(() => {
    root.render(
      <TerminalConnectionOverlay
        tabId={TAB_ID}
        panelId={PANEL_ID}
        tabTitle="Poseidon uP1 Serial"
        isVisible={true}
        sessionType="serial"
      />
    );
  });
}

function query(testId: string): Element | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalConnectionOverlay — copy fix command (#1829)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("copies the serial fix command and confirms with a success toast", async () => {
    renderSerialPermissionFailure();

    const copyButton = query("terminal-connection-serial-copy-btn") as HTMLButtonElement | null;
    expect(copyButton).not.toBeNull();

    act(() => copyButton!.click());
    await flush();

    expect(writeText).toHaveBeenCalledWith(SERIAL_COMMAND);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("renders the fix command in a selectable element", () => {
    renderSerialPermissionFailure();

    const commandEl = document.querySelector<HTMLElement>(
      ".terminal-connection-overlay__command-row .terminal-connection-overlay__hint-code"
    );
    expect(commandEl).not.toBeNull();
    expect(commandEl?.textContent).toBe(SERIAL_COMMAND);
  });
});
