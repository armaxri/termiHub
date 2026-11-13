import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { useAppStore } from "@/store/appStore";
import { AppSettings } from "@/types/connection";
import { TooltipProvider } from "@/components/ui";
import { SettingsPanel } from "./SettingsPanel";
import { SETTINGS_SECTION_HEADING_CLASS, SettingsSectionHeading } from "./SettingsSectionHeading";

vi.mock("@/themes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/themes")>()),
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

const SETTINGS_DIR = join(process.cwd(), "src/components/Settings");

const FULL_SETTINGS: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
  updates: { autoCheck: true },
};

let container: HTMLDivElement;
let root: Root;

setupSettingsRegion();

describe("SettingsSectionHeading", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders an h3 with the shared class by default", () => {
    act(() =>
      root.render(<SettingsSectionHeading id="x">Credential storage</SettingsSectionHeading>)
    );
    const h = container.querySelector("h3");
    expect(h?.className).toBe(SETTINGS_SECTION_HEADING_CLASS);
    expect(h?.id).toBe("x");
    expect(h?.textContent).toBe("Credential storage");
  });

  it("renders an h4 for a nested section and keeps extra classes", () => {
    act(() =>
      root.render(
        <SettingsSectionHeading level={4} className="extra" data-testid="t">
          Config files
        </SettingsSectionHeading>
      )
    );
    const h = container.querySelector("h4");
    expect(h?.classList.contains(SETTINGS_SECTION_HEADING_CLASS)).toBe(true);
    expect(h?.classList.contains("extra")).toBe(true);
    expect(h?.getAttribute("data-testid")).toBe("t");
  });
});

describe("Settings categories share one section heading style (#5634)", () => {
  it("no Settings component uses the retired per-page heading classes", () => {
    const offenders = readdirSync(SETTINGS_DIR)
      .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
      .filter((f) =>
        /<h[34][^>]*className="settings-panel__(category|section)-title"/.test(
          readFileSync(join(SETTINGS_DIR, f), "utf8")
        )
      );
    expect(offenders).toEqual([]);
  });

  it("the heading style uses tokens only, sentence case and a divider", () => {
    const css = readFileSync(join(SETTINGS_DIR, "SettingsSectionHeading.css"), "utf8");
    const rule = /\.settings-section__heading \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("font-size: var(--font-size-");
    expect(rule).toContain("font-weight: var(--font-weight-");
    expect(rule).toContain("border-bottom: 1px solid var(--border-secondary)");
    expect(rule).toContain("text-transform: none");
    expect(rule).not.toMatch(/#[0-9a-f]{3,6}\b|\d+px(?!\s+solid)/i);
  });

  describe("every category", () => {
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
        if (cmd === "list_available_shells") return Promise.resolve([]);
        if (cmd === "get_default_shell") return Promise.resolve(null);
        // List-shaped commands (trust stores, plugins, packages) answer empty.
        if (/(^|_)list($|_)/.test(String(cmd))) return Promise.resolve([]);
        return Promise.resolve(undefined);
      });
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      vi.clearAllMocks();
    });

    it("renders its section headings with the shared class", async () => {
      seedSettings(FULL_SETTINGS);
      await act(async () => {
        root.render(
          <TooltipProvider delayDuration={0}>
            <SettingsPanel tabId="heading-test" isVisible={true} />
          </TooltipProvider>
        );
      });

      const navIds = Array.from(
        container.querySelectorAll<HTMLElement>("[data-testid^='settings-nav-']")
      )
        .map((el) => el.getAttribute("data-testid")!.slice("settings-nav-".length))
        .filter((id, i, all) => all.indexOf(id) === i);
      expect(navIds.length).toBeGreaterThan(10);

      const report: Record<string, string[]> = {};
      for (const id of navIds) {
        await act(async () => {
          container.querySelector<HTMLElement>(`[data-testid='settings-nav-${id}']`)?.click();
        });
        const content = container.querySelector("[data-testid='settings-panel-content']");
        // Lazily-loaded categories (Editor) render once their chunk resolves;
        // poll inside act so the late render stays wrapped.
        for (let i = 0; i < 100 && !content?.querySelector("h3"); i++) {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
          });
        }
        const headings = Array.from(content?.querySelectorAll("h3") ?? []);
        const stray = headings
          .filter((h) => !h.classList.contains(SETTINGS_SECTION_HEADING_CLASS))
          .map((h) => `${h.className}: ${h.textContent}`);
        if (stray.length > 0) report[id] = stray;
      }
      expect(report).toEqual({});
    });
  });
});
