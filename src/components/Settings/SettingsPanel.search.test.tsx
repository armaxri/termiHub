import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { SettingsPanel } from "./SettingsPanel";

/**
 * Search-mode rendering (#3308): a query that matches a category's registry
 * entries must mount that category's section, including sections that used to
 * live outside the searchable index (Updates, External Files).
 */

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

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <SettingsPanel tabId="settings-search-tab" isVisible={true} />
      </TooltipProvider>
    );
  });
}

function search(query: string) {
  const input = container.querySelector<HTMLInputElement>(".settings-search input");
  if (!input) throw new Error("search input not found");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function navItem(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid='settings-nav-${id}']`);
}

setupSettingsRegion();

describe("SettingsPanel — search surfaces every settings section (#3308)", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    useAppStore.setState(useAppStore.getInitialState());

    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_app_info") return Promise.resolve({ version: "0.0.0", gitHash: "abc" });
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers an Updates category in the nav", () => {
    render();
    expect(navItem("updates")).not.toBeNull();
  });

  it("shows the update auto-check preference when searching 'auto-check'", () => {
    render();
    search("auto-check");
    expect(container.querySelector("[data-testid='update-settings']")).not.toBeNull();
    expect(container.querySelector("[data-testid='update-auto-check-on']")).not.toBeNull();
    // Only the matched field is shown; the status block stays hidden.
    expect(container.querySelector("[data-testid='update-check-now']")).toBeNull();
    expect(navItem("updates")?.className).not.toContain("settings-nav__item--dimmed");
  });

  it("shows the update status block when searching 'check now'", () => {
    render();
    search("check now");
    expect(container.querySelector("[data-testid='update-check-now']")).not.toBeNull();
  });

  it("shows the external connection files section when searching 'external'", () => {
    render();
    search("external");
    expect(container.querySelector("[data-testid='external-files-add']")).not.toBeNull();
    expect(navItem("external-files")?.className).not.toContain("settings-nav__item--dimmed");
  });

  it("still reports no results for a query nothing matches", () => {
    render();
    search("zzz-no-such-setting");
    expect(container.querySelector(".settings-panel__no-results")).not.toBeNull();
  });
});
