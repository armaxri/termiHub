import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { currentSettingsView } from "@/store/settingsBridge";
import { TooltipProvider } from "@/components/ui";
import {
  LanguagePackagesSettings,
  resetPendingLanguagePackageUninstalls,
} from "./LanguagePackagesSettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/utils/monacoCustomLanguages", () => ({
  registerCustomMonacoLanguages: vi.fn().mockResolvedValue(undefined),
  registerAdditionalLanguagePackages: vi.fn().mockResolvedValue(undefined),
  getLoadedLanguagePackageIds: vi.fn(() => new Set<string>()),
}));

let container: HTMLDivElement;
let root: Root;

function render(props: { visibleFields?: Set<string> } = {}) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <LanguagePackagesSettings {...props} />
      </TooltipProvider>
    );
  });
}

function query(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function click(testId: string) {
  act(() => {
    (container.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click();
  });
}

setupSettingsRegion();

describe("LanguagePackagesSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    resetPendingLanguagePackageUninstalls();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the settings panel", () => {
    render();
    expect(query("language-packages-settings")).not.toBeNull();
  });

  it("shows built-in packages as always active", () => {
    render();
    // Built-in badges should appear
    const badges = container.querySelectorAll(".settings-panel__badge");
    const builtInBadges = Array.from(badges).filter((b) => b.textContent === "built-in");
    expect(builtInBadges.length).toBeGreaterThan(0);
  });

  it("shows empty state when no user packages are installed", () => {
    render();
    expect(container.textContent).toContain("No additional packages installed.");
  });

  it("shows install button for available packages not yet installed", () => {
    render();
    // The mock has astro, svelte, zig as available (non-built-in)
    expect(query("lang-pkg-install-astro")).not.toBeNull();
    expect(query("lang-pkg-install-svelte")).not.toBeNull();
  });

  it("does not show install button for built-in packages", () => {
    render();
    expect(query("lang-pkg-install-cmake")).toBeNull();
    expect(query("lang-pkg-install-toml")).toBeNull();
  });

  it("shows installed badge and uninstall button for installed packages", () => {
    seedSettings({ installedLanguagePackages: ["astro"] });
    render();

    // Should show uninstall button
    expect(query("lang-pkg-uninstall-astro")).not.toBeNull();
    // Should show installed badge in the package browser
    const installedBadges = Array.from(container.querySelectorAll(".settings-panel__badge")).filter(
      (b) => b.textContent === "installed"
    );
    expect(installedBadges.length).toBeGreaterThan(0);
    // Should not show install button for astro
    expect(query("lang-pkg-install-astro")).toBeNull();
  });

  it("renders install and uninstall buttons as shared ghost Button primitives (not the bespoke shell)", () => {
    seedSettings({ installedLanguagePackages: ["astro"] });
    render();

    const uninstall = query("lang-pkg-uninstall-astro") as HTMLButtonElement;
    expect(uninstall.classList.contains("ui-btn")).toBe(true);
    expect(uninstall.classList.contains("ui-btn--ghost")).toBe(true);
    expect(uninstall.classList.contains("settings-panel__file-remove")).toBe(false);

    const install = query("lang-pkg-install-svelte") as HTMLButtonElement;
    expect(install.classList.contains("ui-btn")).toBe(true);
    expect(install.classList.contains("ui-btn--ghost")).toBe(true);
    expect(install.classList.contains("settings-panel__file-remove")).toBe(false);
  });

  it("installs a package and calls registerAdditionalLanguagePackages", async () => {
    const { registerAdditionalLanguagePackages } = await import("@/utils/monacoCustomLanguages");
    render();

    click("lang-pkg-install-astro");
    await act(async () => {});

    const settings = currentSettingsView();
    expect(settings.installedLanguagePackages).toContain("astro");
    expect(registerAdditionalLanguagePackages).toHaveBeenCalledWith(["astro"]);
  });

  it("uninstalls a package and saves updated settings", async () => {
    seedSettings({ installedLanguagePackages: ["astro"] });
    render();

    click("lang-pkg-uninstall-astro");
    await act(async () => {});

    const settings = currentSettingsView();
    expect(settings.installedLanguagePackages ?? []).not.toContain("astro");
  });

  function restartBadgeIn(el: Element | null): boolean {
    return Array.from(el?.querySelectorAll(".settings-panel__badge") ?? []).some(
      (b) => b.textContent === "restart required"
    );
  }

  it("shows restart required badge after uninstalling", async () => {
    seedSettings({ installedLanguagePackages: ["astro"] });
    render();

    click("lang-pkg-uninstall-astro");
    await act(async () => {});

    // The settings update has landed: astro is no longer installed...
    expect(currentSettingsView().installedLanguagePackages ?? []).not.toContain("astro");
    // ...but its grammar stays loaded until restart, so the row stays with the badge.
    const row = query("lang-pkg-installed-astro");
    expect(row).not.toBeNull();
    expect(restartBadgeIn(row)).toBe(true);
    // Already uninstalled: no second uninstall button, and no empty state.
    expect(query("lang-pkg-uninstall-astro")).toBeNull();
    expect(container.textContent).not.toContain("No additional packages installed.");
  });

  it("keeps the restart required row after the panel is closed and reopened", async () => {
    seedSettings({ installedLanguagePackages: ["astro"] });
    render();

    click("lang-pkg-uninstall-astro");
    await act(async () => {});

    act(() => root.unmount());
    root = createRoot(container);
    render();

    expect(restartBadgeIn(query("lang-pkg-installed-astro"))).toBe(true);
  });

  it("reinstalling a package pending uninstall clears the restart badge", async () => {
    seedSettings({ installedLanguagePackages: ["astro"] });
    render();

    click("lang-pkg-uninstall-astro");
    await act(async () => {});
    click("lang-pkg-install-astro");
    await act(async () => {});

    expect(currentSettingsView().installedLanguagePackages).toContain("astro");
    const row = query("lang-pkg-installed-astro");
    expect(row).not.toBeNull();
    expect(restartBadgeIn(row)).toBe(false);
    expect(query("lang-pkg-uninstall-astro")).not.toBeNull();
  });

  it("filters packages by search query", () => {
    render();

    const searchInput = query("lang-pkg-search") as HTMLInputElement;
    expect(searchInput.classList.contains("ui-input")).toBe(true);
    act(() => {
      searchInput.value = "astro";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    render();

    // astro install button should still exist
    expect(query("lang-pkg-install-astro")).not.toBeNull();
  });

  it("clears the query via the SearchInput clear button", () => {
    render();

    const searchInput = query("lang-pkg-search") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(searchInput, "zzz-no-such-language");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    render();

    // A non-matching query narrows the list to nothing and reveals the clear button.
    const clear = container.querySelector<HTMLButtonElement>(".ui-search-input__clear")!;
    expect(clear).not.toBeNull();

    act(() => clear.click());
    render();

    // Clearing restores the full catalog (a built-in package row is present again).
    expect((query("lang-pkg-search") as HTMLInputElement).value).toBe("");
    expect(container.querySelector(".ui-search-input__clear")).toBeNull();
  });

  it("hides all content when installedLanguagePackages not in visibleFields", () => {
    render({ visibleFields: new Set(["someOtherField"]) });
    expect(container.textContent).not.toContain("Language Packages");
    expect(query("lang-pkg-search")).toBeNull();
  });

  it("shows content when installedLanguagePackages is in visibleFields", () => {
    render({ visibleFields: new Set(["installedLanguagePackages"]) });
    expect(container.textContent).toContain("Language Packages");
  });
});
