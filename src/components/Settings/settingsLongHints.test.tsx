/**
 * The remaining long Settings hints of #5900: Accessibility, General ▸ Diagnostics,
 * Safety prompts, Terminal ▸ Syntax highlighting and Monitoring.
 *
 * Each hint is one short line; the details move behind the "?" help tip, and the
 * safety-relevant sentence (what is stored, what is kept) stays in the visible hint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AppSettings } from "@/types/connection";
import { TooltipProvider } from "@/components/ui";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { AccessibilitySettings } from "./AccessibilitySettings";
import { CrashDiagnosticsFields } from "./CrashDiagnosticsFields";
import { SafetyPromptSettings } from "./SafetyPromptSettings";
import { SyntaxHighlightingSettings } from "./SyntaxHighlightingSettings";
import { MonitoringSettingsFields } from "./MonitoringSettingsFields";

setupSettingsRegion();

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
  const out = document.querySelector(`[data-testid="${testId}-content"]`)?.textContent ?? "";
  act(() => help!.blur());
  return out;
}

/** Every `<id>-hint` is one short line and every `<id>-help` holds the details. */
function expectShortHintsWithHelp(ids: string[]) {
  for (const id of ids) {
    const hint = text(`${id}-hint`);
    expect(hint.length, id).toBeGreaterThan(0);
    expect(hint.length, hint).toBeLessThanOrEqual(MAX_HINT_CHARS);
    expect(helpText(`${id}-help`).length, id).toBeGreaterThan(0);
  }
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

describe("Accessibility ▸ Screen reader mode (#5900)", () => {
  it("is one short line with the overhead behind the help tip", async () => {
    await render(<AccessibilitySettings settings={SETTINGS} onChange={vi.fn()} />);
    expectShortHintsWithHelp(["settings-screen-reader-mode"]);
    expect(helpText("settings-screen-reader-mode-help")).toContain("rendering overhead");
  });
});

describe("General ▸ Diagnostics (#5900)", () => {
  it("keeps the crash notice and export hints short with a help tip", async () => {
    await render(<CrashDiagnosticsFields settings={SETTINGS} onChange={vi.fn()} />);
    expectShortHintsWithHelp(["settings-show-crash-report-notice", "settings-export-diagnostics"]);
  });

  it("keeps where the reports go visible", async () => {
    await render(<CrashDiagnosticsFields settings={SETTINGS} onChange={vi.fn()} />);
    expect(text("settings-show-crash-report-notice-hint")).toContain("stay on this computer");
    expect(text("settings-export-diagnostics-hint")).toContain("Nothing is sent anywhere");
  });
});

describe("Safety prompts (#5900)", () => {
  it("keeps every hint to one short line with a help tip", async () => {
    await render(<SafetyPromptSettings settings={SETTINGS} onChange={vi.fn()} />);
    expectShortHintsWithHelp([
      "settings-close-live-session-confirm",
      "settings-confirm-close-attached-tab",
      "settings-confirm-undoable-delete",
      "settings-warn-large-port-scan",
      "settings-warn-large-ping-sweep",
    ]);
  });

  it("keeps what is deleted and what keeps running in the visible hint", async () => {
    await render(<SafetyPromptSettings settings={SETTINGS} onChange={vi.fn()} />);
    expect(text("settings-confirm-undoable-delete-hint")).toBe(
      "Ask before deleting a connection folder, a custom theme or an idle tunnel or file server."
    );
    expect(text("settings-confirm-close-attached-tab-hint")).toContain("keeps running");
  });
});

describe("Terminal ▸ Syntax highlighting (#5900)", () => {
  it("is one short line with the ANSI rule behind the help tip", async () => {
    await render(<SyntaxHighlightingSettings settings={SETTINGS} onChange={vi.fn()} />);
    expectShortHintsWithHelp(["settings-syntax-highlighting-enabled"]);
    expect(helpText("settings-syntax-highlighting-enabled-help")).toContain("never overridden");
  });
});

describe("Monitoring (#5900)", () => {
  it("keeps the local-shell hint short with Power monitoring behind the help tip", async () => {
    seedSettings({ ...SETTINGS });
    await render(<MonitoringSettingsFields />);
    expectShortHintsWithHelp(["settings-monitor-local-shells"]);
    expect(helpText("settings-monitor-local-shells-help")).toContain("Power monitoring");
    expect(text("settings-status-bar-metrics-hint").length).toBeLessThanOrEqual(MAX_HINT_CHARS);
  });
});
