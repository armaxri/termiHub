import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
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

async function render() {
  await act(async () => {
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

/**
 * Search, then let the mounted sections' async loads settle inside act(). A
 * query that matches General mounts its log-path and shell lookups, whose
 * late state updates would otherwise each log an act() warning.
 */
async function searchSettled(query: string) {
  search(query);
  await act(async () => {
    await Promise.resolve();
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
      // The Security trust lists (#5365 tests open that category).
      if (cmd === "rdp_trust_list" || cmd === "ssh_trust_list") return Promise.resolve([]);
      // The Plugins lists: "advanced" finds Plugins, folded under Advanced until #5860.
      if (cmd.startsWith("list_")) return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers an Updates category in the nav", async () => {
    await render();
    expect(navItem("updates")).not.toBeNull();
  });

  it("shows the update auto-check preference when searching 'auto-check'", async () => {
    await render();
    search("auto-check");
    expect(container.querySelector("[data-testid='update-settings']")).not.toBeNull();
    expect(container.querySelector("[data-testid='update-auto-check']")).not.toBeNull();
    // Only the matched field is shown; the status block stays hidden.
    expect(container.querySelector("[data-testid='update-check-now']")).toBeNull();
    expect(navItem("updates")?.className).not.toContain("settings-nav__item--dimmed");
  });

  it("shows the update status block when searching 'check now'", async () => {
    await render();
    search("check now");
    expect(container.querySelector("[data-testid='update-check-now']")).not.toBeNull();
  });

  it("shows the external connection files section when searching 'external'", async () => {
    await render();
    search("external");
    expect(container.querySelector("[data-testid='external-files-add']")).not.toBeNull();
    expect(navItem("external-files")?.className).not.toContain("settings-nav__item--dimmed");
  });

  it("offers a Monitoring category with the host-monitoring settings (#5775)", async () => {
    await render();
    expect(navItem("monitoring")).not.toBeNull();
    act(() => navItem("monitoring")!.click());
    const page = container.querySelector("[data-testid='settings-monitoring']");
    expect(page).not.toBeNull();
    for (const id of [
      "toggle-power-monitoring",
      "toggle-monitor-local-shells",
      "settings-status-bar-metrics",
    ]) {
      expect(page!.querySelector(`[data-testid='${id}']`)).not.toBeNull();
    }
    act(() => navItem("external-files")!.click());
    expect(container.querySelector("[data-testid='toggle-power-monitoring']")).toBeNull();
  });

  it("shows the File browser toggle under Connection defaults, not External files (#5786, #5860)", async () => {
    await render();
    act(() => navItem("external-files")!.click());
    expect(container.querySelector("[data-testid='external-files-add']")).not.toBeNull();
    expect(container.querySelector("[data-testid='toggle-file-browser']")).toBeNull();
    await act(async () => navItem("general")!.click());
    expect(container.querySelector("[data-testid='toggle-file-browser']")).toBeNull();
    expect(container.querySelector("[data-testid='settings-default-user']")).toBeNull();
    await act(async () => navItem("connection-defaults")!.click());
    expect(container.querySelector("[data-testid='settings-default-user']")).not.toBeNull();
    const toggle = container.querySelector("[data-testid='toggle-file-browser']");
    expect(toggle).not.toBeNull();
    expect(
      container.querySelector("[data-testid='settings-default-x11-forwarding']")
    ).not.toBeNull();
  });

  it("finds the File browser toggle by its old and new search words (#5786)", async () => {
    await render();
    for (const query of [
      "file browser",
      "sftp",
      "advanced",
      "external",
      "new connection",
      "general",
      "connection defaults",
    ]) {
      await searchSettled(query);
      expect(container.querySelector("[data-testid='toggle-file-browser']"), query).not.toBeNull();
      expect(navItem("connection-defaults")?.className, query).not.toContain(
        "settings-nav__item--dimmed"
      );
    }
  });

  it.each(["monitoring", "advanced", "external"])(
    "finds the monitoring settings by searching '%s' (#5775)",
    async (query) => {
      await render();
      await searchSettled(query);
      expect(container.querySelector("[data-testid='toggle-power-monitoring']")).not.toBeNull();
      expect(container.querySelector("[data-testid='toggle-monitor-local-shells']")).not.toBeNull();
      expect(navItem("monitoring")?.className).not.toContain("settings-nav__item--dimmed");
    }
  );

  it("offers a Schedules category and finds it by searching 'pause' (#4623)", async () => {
    await render();
    expect(navItem("schedules")).not.toBeNull();
    search("schedule");
    expect(container.querySelector("[data-testid='schedules-settings']")).not.toBeNull();
    expect(navItem("schedules")?.className).not.toContain("settings-nav__item--dimmed");
    search("pause");
    expect(container.querySelector("[data-testid='schedules-settings']")).not.toBeNull();
    // Its old home's word (#5860).
    search("advanced");
    expect(container.querySelector("[data-testid='schedules-settings']")).not.toBeNull();
  });

  it("says which page each result is on, and goes there (#5860, G-002)", async () => {
    await render();
    await searchSettled("default user");
    const path = container.querySelector(
      "[data-testid='settings-result-path-connection-defaults']"
    );
    expect(path?.textContent).toContain("Connections ▸ Connection defaults");
    const show = container.querySelector<HTMLElement>(
      "[data-testid='settings-result-show-connection-defaults']"
    )!;
    expect(show.textContent).toBe("Show in Connection defaults");
    await act(async () => show.click());
    expect(container.querySelector(".settings-search input")).toHaveProperty("value", "");
    expect(navItem("connection-defaults")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("[data-testid^='settings-result-path-']")).toBeNull();
  });

  it("opens Plugins with the installed plugins, then browsing, then the gates (G-008)", async () => {
    await render();
    await act(async () => navItem("plugins")!.click());
    const headings = Array.from(
      container.querySelectorAll(
        "[data-testid='settings-panel-content'] h3, [data-testid='settings-panel-content'] h2"
      )
    ).map((h) => h.textContent?.trim());
    expect(headings.slice(0, 2)).toEqual(["Installed plugins", "Browse plugins"]);
  });

  it("ends a search when a page is chosen in the nav (#5860)", async () => {
    await render();
    await searchSettled("vault");
    await act(async () => navItem("backup")!.click());
    expect(container.querySelector(".settings-search input")).toHaveProperty("value", "");
    expect(container.querySelector("[data-testid='backup-restore-settings']")).not.toBeNull();
    expect(container.querySelector("[data-testid='password-backup']")).toBeNull();
  });

  it("lands every old deep link on a page that exists (#5860)", async () => {
    await render();
    for (const category of [
      "general",
      "keyboard",
      "plugins",
      "import",
      "backup",
      "security",
      "schedules",
      "monitoring",
      "x-server",
      "portable",
      "external-files",
      "shell-integration",
    ]) {
      await act(async () => {
        useAppStore.setState({ pendingSettingsCategory: category });
      });
      expect(navItem(category)?.getAttribute("aria-selected"), category).toBe("true");
    }
  });

  it("still reports no results for a query nothing matches", async () => {
    await render();
    search("zzz-no-such-setting");
    expect(container.querySelector(".settings-panel__no-results")).not.toBeNull();
  });

  describe("RDP certificates follow the experimental gate (#5365)", () => {
    const rdpSection = () => container.querySelector("[data-testid='settings-rdp-trust']");
    const sshSection = () => container.querySelector("[data-testid='settings-ssh-trust']");

    function openSecurity() {
      act(() => navItem("security")?.click());
    }

    it("hides the section and its search entry while experimental features are off", async () => {
      seedSettings({ experimentalFeaturesEnabled: false });
      await render();
      openSecurity();
      expect(rdpSection()).toBeNull();
      expect(sshSection()).not.toBeNull();

      // "rdp" finds the switch that turns RDP on (its hint names it, #5858),
      // never the hidden certificate list.
      search("rdp");
      expect(rdpSection()).toBeNull();
      expect(
        container.querySelector("[data-testid='settings-experimental-features']")
      ).not.toBeNull();

      search("certificate");
      expect(rdpSection()).toBeNull();
    });

    it("shows the section and finds it by search while experimental features are on", async () => {
      seedSettings({ experimentalFeaturesEnabled: true });
      await render();
      openSecurity();
      expect(rdpSection()).not.toBeNull();

      search("remote desktop");
      expect(rdpSection()).not.toBeNull();
      expect(navItem("security")?.className).not.toContain("settings-nav__item--dimmed");
    });
  });
});
