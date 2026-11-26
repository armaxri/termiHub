/**
 * Plain copy on the File browser, Command marks and Updates settings (#5846),
 * with the long hints of General and Terminal behind the "?" help tip (#5900).
 *
 * Each hint is one short line; protocol names (OSC 133) and the details only
 * appear in the help tip, and the File browser says "SSH connections", not
 * "SSH agent sessions".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AppSettings } from "@/types/connection";
import { TooltipProvider } from "@/components/ui";
import { GeneralSettings } from "./GeneralSettings";
import { ConnectionDefaultsSettings } from "./ConnectionDefaultsSettings";
import { TerminalSettings } from "./TerminalSettings";

vi.mock("@/utils/shell-detection", () => ({
  detectAvailableShells: vi.fn().mockResolvedValue([]),
  getWslDistroName: vi.fn(() => null),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
  frontendError: vi.fn(),
}));

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  getLogFilePath: vi.fn().mockResolvedValue("/tmp/termihub.log"),
  setFileLogLevel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/themes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/themes")>();
  return { ...actual, applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) };
});

const SETTINGS: AppSettings = {
  version: "2",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

/** A hint fits one line at the 640px content width beside an inline control. */
const MAX_HINT_CHARS = 90;

let container: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(<TooltipProvider delayDuration={0}>{node}</TooltipProvider>);
  });
}

function text(testId: string): string {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

function helpText(testId: string): string {
  const help = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(help, testId).not.toBeNull();
  act(() => help!.focus());
  const content = document.querySelector(`[data-testid="${testId}-content"]`);
  const out = content?.textContent ?? "";
  act(() => help!.blur());
  return out;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState(useAppStore.getInitialState());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Connections ▸ Connection defaults ▸ File browser (R-030, #5860)", () => {
  it("says SSH connections, not SSH agent sessions", async () => {
    await render(<ConnectionDefaultsSettings settings={SETTINGS} onChange={vi.fn()} />);
    const hint = text("settings-file-browser-hint");
    expect(hint).toBe(
      "Show the file browser for SSH connections. Each connection can override it."
    );
    expect(hint).not.toContain("agent");
    expect(hint).not.toContain("SFTP");
  });

  it("says what turning it off does, without claiming sessions disconnect", async () => {
    await render(<ConnectionDefaultsSettings settings={SETTINGS} onChange={vi.fn()} />);
    const help = helpText("settings-file-browser-help");
    expect(help).toContain("closes the file browser");
    expect(help).toContain("terminals stay connected");
    expect(help).not.toContain("disconnects");
  });

  it("flips without a confirmation, because nothing disconnects", async () => {
    const onChange = vi.fn();
    await render(<ConnectionDefaultsSettings settings={SETTINGS} onChange={onChange} />);
    act(() => container.querySelector<HTMLElement>("[data-testid='toggle-file-browser']")!.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[role='alertdialog'], [role='dialog']")).toBeNull();
  });

  it("keeps every connection-default hint touched by #5900 to one short line with a help tip", async () => {
    await render(<ConnectionDefaultsSettings settings={SETTINGS} onChange={vi.fn()} />);
    for (const id of ["settings-default-x11-forwarding", "settings-file-browser"]) {
      const hint = text(`${id}-hint`);
      expect(hint.length, id).toBeGreaterThan(0);
      expect(hint.length, hint).toBeLessThanOrEqual(MAX_HINT_CHARS);
      expect(helpText(`${id}-help`).length, id).toBeGreaterThan(0);
    }
  });

  it("keeps every General hint touched by #5900 to one short line with a help tip", async () => {
    await render(<GeneralSettings settings={SETTINGS} onChange={vi.fn()} />);
    for (const id of ["settings-file-log-level", "settings-copy-debug-info"]) {
      const hint = text(`${id}-hint`);
      expect(hint.length, id).toBeGreaterThan(0);
      expect(hint.length, hint).toBeLessThanOrEqual(MAX_HINT_CHARS);
      expect(helpText(`${id}-help`).length, id).toBeGreaterThan(0);
    }
  });

  it("keeps the log file path and the env override behind the help tip", async () => {
    await render(<GeneralSettings settings={SETTINGS} onChange={vi.fn()} />);
    await act(async () => {});
    const help = helpText("settings-file-log-level-help");
    expect(help).toContain("/tmp/termihub.log");
    expect(help).toContain("TERMIHUB_FILE_LOG");
  });
});

describe("Terminal ▸ Command marks (R-093)", () => {
  it("names the shells, not the protocol", async () => {
    await render(<TerminalSettings settings={SETTINGS} onChange={vi.fn()} />);
    expect(text("settings-terminal-command-decorations-hint")).toBe(
      "Works with bash, zsh, fish and PowerShell once the shell hook is on."
    );
    expect(text("settings-command-marks")).not.toContain("OSC 133");
  });

  it("keeps OSC 133 only in the help tip", async () => {
    await render(<TerminalSettings settings={SETTINGS} onChange={vi.fn()} />);
    expect(helpText("settings-terminal-command-decorations-help")).toContain("OSC 133");
  });

  it("keeps every Terminal hint touched by #5900 to one short line with a help tip", async () => {
    await render(<TerminalSettings settings={SETTINGS} onChange={vi.fn()} />);
    for (const id of [
      "settings-line-ending",
      "settings-right-click-behavior",
      "settings-terminal-inline-images",
      "settings-terminal-combine-emoji",
      "settings-ask-open-saved-file-in-tab",
      "settings-terminal-command-decorations",
      "settings-default-shell-integration",
    ]) {
      const hint = text(`${id}-hint`);
      expect(hint.length, id).toBeGreaterThan(0);
      expect(hint.length, hint).toBeLessThanOrEqual(MAX_HINT_CHARS);
      expect(helpText(`${id}-help`).length, id).toBeGreaterThan(0);
    }
  });
});
