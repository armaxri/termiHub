/**
 * Auto-save feedback tests for the Settings panel (#1342).
 *
 * The panel auto-saves General/Appearance/Terminal settings (debounced). It
 * used to also raise an unsaved-changes dialog on close — a contradictory
 * mental model. These tests pin the resolved model:
 *  - a debounced save shows a subtle transient "Saved" acknowledgment,
 *  - a close request flushes and closes directly, never showing a dialog.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { AppSettings } from "@/types/connection";
import { TooltipProvider } from "@/components/ui";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

vi.mock("@/utils/shell-detection", () => ({
  detectAvailableShells: vi.fn().mockResolvedValue([]),
  getWslDistroName: vi.fn(() => null),
}));

const { invoke } = await import("@tauri-apps/api/core");
const mockedInvoke = vi.mocked(invoke);

const FULL_SETTINGS: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
  defaultShellIntegration: true,
  defaultX11Forwarding: true,
  provideXServerAutomatically: true,
  stopXServerWhenIdle: true,
  updates: { autoCheck: true },
};

const TAB_ID = "test-settings-tab";

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <SettingsPanel tabId={TAB_ID} isVisible={true} />
      </TooltipProvider>
    );
  });
}

function ackEl(): HTMLElement | null {
  return container.querySelector("[data-testid='settings-saved-ack']");
}

setupSettingsRegion();

describe("SettingsPanel — auto-save feedback (#1342)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    useAppStore.setState(useAppStore.getInitialState());
    seedSettings(FULL_SETTINGS);

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_app_info") return Promise.resolve({ version: "0.0.0", gitHash: "abc" });
      if (cmd === "save_settings") return Promise.resolve(undefined);
      if (cmd === "list_available_shells") return Promise.resolve([]);
      if (cmd === "get_default_shell") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("shows a transient 'Saved' acknowledgment after a debounced auto-save", async () => {
    render();

    // No acknowledgment before any change.
    expect(ackEl()?.textContent ?? "").not.toContain("Saved");

    const toggle = container.querySelector<HTMLElement>(
      "[data-testid='settings-default-shell-integration']"
    );
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.click();
    });

    // Let the 300ms debounce elapse — this persists and fires the ack.
    await act(async () => {
      vi.advanceTimersByTime(350);
    });

    expect(ackEl()?.textContent ?? "").toContain("Saved");
    expect(ackEl()?.className ?? "").toContain("settings-panel__saved-ack--visible");

    // The acknowledgment is transient — it hides again after its window.
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(ackEl()?.textContent ?? "").not.toContain("Saved");
  });

  it("closes on a close request without an unsaved-changes dialog", async () => {
    const closeTab = vi.fn();
    const setPendingCloseRequest = vi.fn();
    useAppStore.setState({ closeTab, setPendingCloseRequest });

    render();

    act(() => {
      useAppStore.setState({ pendingCloseRequest: { tabId: TAB_ID, panelId: "panel-1" } });
    });
    await act(async () => {
      await Promise.resolve();
    });

    // No unsaved-changes dialog is rendered.
    expect(document.querySelector("[data-testid='unsaved-changes-save-and-close']")).toBeNull();
    // The tab is closed directly.
    expect(closeTab).toHaveBeenCalledWith(TAB_ID, "panel-1");
  });
});
