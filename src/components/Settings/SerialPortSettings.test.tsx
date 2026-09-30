import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { SerialPortSettings } from "./SerialPortSettings";
import { SETTINGS_REGISTRY } from "./settingsRegistry";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockedInvoke = vi.mocked(invoke);

setupSettingsRegion();

let container: HTMLDivElement;
let root: Root;

/** Render and let the settings region's async subscribe settle inside act(). */
async function render() {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <SerialPortSettings />
      </TooltipProvider>
    );
  });
  await act(async () => await Promise.resolve());
}

/** Find the Add button by its label (migrated to the shared Button primitive). */
function addButton(): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll("button"));
  return (buttons.find((b) => b.textContent?.includes("Add")) as HTMLButtonElement) ?? null;
}

function typePrefix(value: string) {
  const input = container.querySelector(
    ".settings-panel__add-row input"
  ) as HTMLInputElement | null;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SerialPortSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockedInvoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the section", async () => {
    await render();
    expect(container.querySelector('[data-testid="settings-serial-port-prefixes"]')).not.toBeNull();
  });

  it("renders the Add control as a real button element", async () => {
    await render();
    const btn = addButton();
    expect(btn).not.toBeNull();
    expect(btn?.tagName).toBe("BUTTON");
    expect(btn?.className).toContain("ui-btn");
  });

  it("disables Add while the prefix input is empty", async () => {
    await render();
    expect(addButton()?.disabled).toBe(true);
  });

  it("enables Add and persists a new prefix on click", async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ updateSettings });
    await render();
    typePrefix("ttyXYZ");
    const btn = addButton();
    expect(btn?.disabled).toBe(false);
    act(() => {
      btn?.click();
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    const arg = updateSettings.mock.calls[0][0] as {
      serialPortScanPrefixes?: { prefix: string }[];
    };
    expect(arg.serialPortScanPrefixes?.some((p) => p.prefix === "ttyXYZ")).toBe(true);
  });

  // --- Former manual items MT-SER-06 / MT-SER-08 (#3683) ---------------------

  const PREFIXES = [
    { prefix: "ttyAMA", enabled: true, builtIn: true },
    { prefix: "ttyS", enabled: false, builtIn: true },
    { prefix: "uart", enabled: true, builtIn: true },
    { prefix: "ttyTEST", enabled: true, builtIn: false },
  ];

  async function renderSeeded() {
    act(() => seedSettings({ serialPortScanPrefixes: PREFIXES }));
    await render();
  }

  it("lives in the Serial settings category (MT-SER-06)", () => {
    const def = SETTINGS_REGISTRY.find((d) => d.id === "serialPortScanPrefixes");
    expect(def?.category).toBe("serial");
  });

  it("shows the enabled / total badge (MT-SER-06)", async () => {
    await renderSeeded();
    const badge = container.querySelector(".settings-panel__section-badge");
    expect(badge?.textContent).toBe("3 / 4 enabled");
  });

  it("renders one toggle per built-in prefix reflecting its state (MT-SER-06)", async () => {
    await renderSeeded();
    for (const p of PREFIXES) {
      const toggle = container.querySelector(
        `[aria-label="Toggle serial port prefix ${p.prefix}"]`
      );
      expect(toggle, p.prefix).not.toBeNull();
      expect(toggle?.getAttribute("aria-checked")).toBe(String(p.enabled));
    }
    const builtInToggles = Array.from(
      container.querySelectorAll('[aria-label^="Toggle serial port prefix"]')
    ).filter((el) => !el.closest("li")?.querySelector('[aria-label="Remove custom prefix"]'));
    expect(builtInToggles).toHaveLength(PREFIXES.filter((p) => p.builtIn).length);
  });

  it("offers delete only for custom prefixes (MT-SER-08)", async () => {
    await renderSeeded();
    const removes = container.querySelectorAll('[aria-label="Remove custom prefix"]');
    expect(removes).toHaveLength(1);
    expect(removes[0].closest("li")?.textContent).toContain("ttyTEST");
  });

  it("persists the list without a deleted custom prefix (MT-SER-08)", async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ updateSettings });
    await renderSeeded();
    const remove = container.querySelector(
      '[aria-label="Remove custom prefix"]'
    ) as HTMLButtonElement;
    act(() => {
      remove.click();
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    const arg = updateSettings.mock.calls[0][0] as {
      serialPortScanPrefixes?: { prefix: string }[];
    };
    expect(arg.serialPortScanPrefixes?.map((p) => p.prefix)).toEqual(["ttyAMA", "ttyS", "uart"]);
  });

  it("persists a toggled-off prefix as disabled (MT-SER-07)", async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ updateSettings });
    await renderSeeded();
    const toggle = container.querySelector(
      '[aria-label="Toggle serial port prefix ttyAMA"]'
    ) as HTMLButtonElement;
    act(() => {
      toggle.click();
    });
    const arg = updateSettings.mock.calls[0][0] as {
      serialPortScanPrefixes?: { prefix: string; enabled: boolean }[];
    };
    expect(arg.serialPortScanPrefixes?.find((p) => p.prefix === "ttyAMA")?.enabled).toBe(false);
  });
});
