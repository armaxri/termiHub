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

/**
 * Flush pending promise callbacks inside `act()`. Microtask-only (no
 * `setImmediate`), so it works under fake timers and arms no timer.
 */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

/** Mount the panel and let its async mount-time hooks (key scan, subscriptions) settle. */
async function render() {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <SettingsPanel tabId={TAB_ID} isVisible={true} />
      </TooltipProvider>
    );
  });
  await settle();
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
    await render();

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

    await render();

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

  describe("debounced save through useDebouncedCallback (#3022)", () => {
    function toggleShellIntegration() {
      const toggle = container.querySelector<HTMLElement>(
        "[data-testid='settings-default-shell-integration']"
      );
      expect(toggle).not.toBeNull();
      act(() => {
        toggle!.click();
      });
    }

    it("coalesces rapid edits into one save after 300ms, then acks", async () => {
      const updateSettings = vi.fn();
      const setEditorDirty = vi.fn();
      useAppStore.setState({ updateSettings, setEditorDirty });
      await render();

      toggleShellIntegration(); // true → false (dirty)
      act(() => {
        vi.advanceTimersByTime(200);
      });
      toggleShellIntegration(); // false → true (back to baseline: cancels the save)
      toggleShellIntegration(); // true → false (dirty again, re-arms)
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(updateSettings).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(updateSettings).toHaveBeenCalledTimes(1);
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ defaultShellIntegration: false })
      );
      expect(setEditorDirty).toHaveBeenLastCalledWith(TAB_ID, false);
      expect(ackEl()?.textContent ?? "").toContain("Saved");
    });

    it("reverting to the saved value cancels the pending save", async () => {
      const updateSettings = vi.fn();
      useAppStore.setState({ updateSettings });
      await render();

      toggleShellIntegration();
      toggleShellIntegration();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(updateSettings).not.toHaveBeenCalled();
    });

    it("flushes the last pending change on unmount without a dirty-flag write or ack", async () => {
      const updateSettings = vi.fn();
      const setEditorDirty = vi.fn();
      useAppStore.setState({ updateSettings, setEditorDirty });
      await render();

      toggleShellIntegration();
      expect(setEditorDirty).toHaveBeenCalledTimes(1);
      expect(setEditorDirty).toHaveBeenLastCalledWith(TAB_ID, true);
      expect(updateSettings).not.toHaveBeenCalled();

      act(() => root.unmount());
      // The pending edit was persisted synchronously on unmount…
      expect(updateSettings).toHaveBeenCalledTimes(1);
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ defaultShellIntegration: false })
      );
      // …without clearing the dirty flag in the store or arming an ack timer.
      expect(setEditorDirty).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);

      // Nothing fires later either.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(updateSettings).toHaveBeenCalledTimes(1);

      // Re-create a root so afterEach's unmount has something to tear down.
      root = createRoot(container);
    });

    it("a close request flushes the pending change without an ack", async () => {
      const updateSettings = vi.fn();
      const setEditorDirty = vi.fn();
      const closeTab = vi.fn();
      const setPendingCloseRequest = vi.fn();
      useAppStore.setState({ updateSettings, setEditorDirty, closeTab, setPendingCloseRequest });
      await render();

      toggleShellIntegration();
      act(() => {
        useAppStore.setState({ pendingCloseRequest: { tabId: TAB_ID, panelId: "panel-1" } });
      });

      expect(updateSettings).toHaveBeenCalledTimes(1);
      expect(setEditorDirty).toHaveBeenLastCalledWith(TAB_ID, false);
      expect(closeTab).toHaveBeenCalledWith(TAB_ID, "panel-1");
      expect(ackEl()?.textContent ?? "").not.toContain("Saved");

      // The debounce timer was consumed by the flush — no second save later.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });
  });

  describe("the acknowledgment shows near the edited control (#5562)", () => {
    function shellIntegrationToggle(): HTMLElement {
      const toggle = container.querySelector<HTMLElement>(
        "[data-testid='settings-default-shell-integration']"
      );
      expect(toggle).not.toBeNull();
      return toggle!;
    }

    function pointerDown(el: Element) {
      act(() => {
        el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      });
    }

    function marks(): HTMLElement[] {
      return Array.from(container.querySelectorAll("[data-testid='settings-saved-mark']"));
    }

    async function saveSettles() {
      await act(async () => {
        vi.advanceTimersByTime(350);
      });
    }

    it("puts a 'Saved' tick beside the label of the field that was edited", async () => {
      await render();
      const toggle = shellIntegrationToggle();
      const field = toggle.closest("[data-settings-field]");
      expect(field, "the toggle sits in a tagged SettingsField").not.toBeNull();

      pointerDown(toggle);
      await act(async () => {
        toggle.click();
      });
      expect(marks()).toHaveLength(0);
      await saveSettles();

      expect(marks()).toHaveLength(1);
      expect(field!.contains(marks()[0])).toBe(true);
      expect(marks()[0].textContent).toContain("Saved");
      // The live region still announces it, visually hidden.
      expect(ackEl()?.textContent).toContain("Saved");
      expect(ackEl()?.getAttribute("data-anchored")).toBe("field");
      expect(ackEl()?.className).toContain("sr-only");

      await act(async () => {
        vi.advanceTimersByTime(1600);
      });
      expect(marks()).toHaveLength(0);
    });

    it("anchors to the focused field when the edit came from the keyboard", async () => {
      await render();
      const toggle = shellIntegrationToggle();
      act(() => toggle.focus());
      await act(async () => {
        toggle.click();
      });
      await saveSettles();
      expect(marks()).toHaveLength(1);
      expect(toggle.closest("[data-settings-field]")!.contains(marks()[0])).toBe(true);
    });

    it("keeps the tick on the edited field when the user moves on during the debounce", async () => {
      await render();
      const toggle = shellIntegrationToggle();
      pointerDown(toggle);
      await act(async () => {
        toggle.click();
      });
      // Point at another field before the save lands.
      const other = Array.from(container.querySelectorAll("[data-settings-field]")).find(
        (f) => !f.contains(toggle)
      );
      expect(other).toBeDefined();
      pointerDown(other!);
      await saveSettles();
      expect(marks()).toHaveLength(1);
      expect(toggle.closest("[data-settings-field]")!.contains(marks()[0])).toBe(true);
    });

    it("shows a visible pill in the content column for an edit outside any field", async () => {
      await render();
      // Pointing at the page heading (no field) and then changing the setting
      // without focus leaves no field to anchor to.
      pointerDown(container.querySelector(".settings-panel__category-title")!);
      await act(async () => {
        shellIntegrationToggle().click();
      });
      await saveSettles();

      expect(marks()).toHaveLength(0);
      const ack = ackEl()!;
      expect(ack.textContent).toContain("Saved");
      expect(ack.getAttribute("data-anchored")).toBe("panel");
      expect(ack.className).not.toContain("sr-only");
      expect(ack.className).toContain("settings-panel__saved-ack--visible");
      expect(container.querySelector("[data-testid='settings-panel-content']")!.contains(ack)).toBe(
        true
      );
    });

    it("keeps the build-info footer free of the transient acknowledgment", async () => {
      await render();
      const toggle = shellIntegrationToggle();
      pointerDown(toggle);
      await act(async () => {
        toggle.click();
      });
      await saveSettles();
      const footer = container.querySelector(".settings-panel__footer")!;
      expect(footer.querySelector("[data-testid='settings-saved-ack']")).toBeNull();
      expect(footer.textContent).not.toContain("Saved");
    });
  });
});
