/**
 * Settings ▸ Serial per platform (#5712). The `/dev` prefix scan only runs on
 * Linux, so on macOS / Windows the 40-odd built-in prefixes fold behind a
 * one-line note and a disclosure; on Linux they render as a compact chip grid.
 * The platform is injected through the component's `platform` prop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import type { Platform } from "@/utils/platform";
import { SerialPortSettings } from "./SerialPortSettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

setupSettingsRegion();

const PREFIXES = [
  { prefix: "ttyAMA", enabled: true, builtIn: true },
  { prefix: "ttyS", enabled: false, builtIn: true },
  { prefix: "uart", enabled: true, builtIn: true },
  { prefix: "ttyTEST", enabled: true, builtIn: false },
];

let container: HTMLDivElement;
let root: Root;

async function render(platform: Platform) {
  act(() => seedSettings({ serialPortScanPrefixes: PREFIXES }));
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <SerialPortSettings platform={platform} />
      </TooltipProvider>
    );
  });
  await act(async () => await Promise.resolve());
}

const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const prefixToggles = () => container.querySelectorAll('[aria-label^="Toggle serial port prefix"]');

describe("SerialPortSettings per platform (#5712)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the built-in prefixes as a chip grid on Linux", async () => {
    await render("linux");
    const grid = q("settings-serial-prefix-grid");
    expect(grid).not.toBeNull();
    expect(grid?.querySelectorAll(".settings-panel__prefix-chip")).toHaveLength(3);
    expect(grid?.querySelector(".settings-panel__file-item")).toBeNull();
    expect(prefixToggles()).toHaveLength(4);
    expect(q("settings-serial-prefixes-note")).toBeNull();
    expect(q("settings-serial-prefixes-disclosure")).toBeNull();
  });

  it.each<Platform>(["macos", "windows"])(
    "folds every prefix behind a one-line note on %s",
    async (platform) => {
      await render(platform);
      const note = q("settings-serial-prefixes-note");
      expect(note?.textContent).toContain("Prefix scanning only runs on Linux");
      expect(prefixToggles()).toHaveLength(0);
      expect(q("settings-serial-prefixes-list")).toBeNull();
      // The section badge still summarises the shared settings.
      expect(container.querySelector(".settings-panel__section-badge")?.textContent).toBe(
        "3 / 4 enabled"
      );
      const disclosure = q("settings-serial-prefixes-disclosure");
      expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
      expect(disclosure?.textContent).toBe("Show Linux prefixes (4)");
    }
  );

  it("expands and collapses the Linux list off Linux", async () => {
    await render("macos");
    const disclosure = q("settings-serial-prefixes-disclosure") as HTMLButtonElement;
    act(() => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(disclosure.textContent).toBe("Hide Linux prefixes");
    const list = q("settings-serial-prefixes-list");
    expect(list?.id).toBe(disclosure.getAttribute("aria-controls"));
    expect(prefixToggles()).toHaveLength(4);
    expect(q("settings-serial-prefix-grid")).not.toBeNull();
    act(() => disclosure.click());
    expect(prefixToggles()).toHaveLength(0);
  });

  it("keeps the expanded list editable off Linux", async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ updateSettings });
    await render("windows");
    act(() => (q("settings-serial-prefixes-disclosure") as HTMLButtonElement).click());
    act(() =>
      (
        container.querySelector(
          '[aria-label="Toggle serial port prefix ttyS"]'
        ) as HTMLButtonElement
      ).click()
    );
    const arg = updateSettings.mock.calls[0][0] as {
      serialPortScanPrefixes?: { prefix: string; enabled: boolean }[];
    };
    expect(arg.serialPortScanPrefixes?.find((p) => p.prefix === "ttyS")?.enabled).toBe(true);
  });
});
