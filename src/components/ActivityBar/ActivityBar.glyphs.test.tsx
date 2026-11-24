/**
 * Recognisable activity-bar glyphs (#5848, R-022): every item names itself
 * (accessible name, which is also its tooltip text) and tags its glyph with
 * `data-icon`; no two items share a glyph; Automations and the log viewer do
 * not draw the clapperboard and the scroll a first-time user could not place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";
import { ActivityBar } from "./ActivityBar";

vi.mock("@/components/OpenConnections/OpenConnectionsModal", () => ({
  OpenConnectionsModal: () => null,
}));

setupSettingsRegion();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState(useAppStore.getInitialState());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAppStore.setState(useAppStore.getInitialState());
});

async function render(): Promise<HTMLButtonElement[]> {
  seedSettings({ experimentalFeaturesEnabled: true });
  act(() => root.render(withTooltip(<ActivityBar />)));
  await flushAsync();
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-testid="activity-bar"] button')
  );
}

const icon = (testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`)?.getAttribute("data-icon");

describe("ActivityBar — glyphs and names (#5848)", () => {
  it("names every item and tags its glyph", async () => {
    const buttons = await render();
    expect(buttons.length).toBeGreaterThanOrEqual(10);
    for (const button of buttons) {
      const id = button.getAttribute("data-testid");
      expect(button.getAttribute("aria-label"), `${id} accessible name`).toBeTruthy();
      expect(button.getAttribute("data-icon"), `${id} glyph tag`).toBeTruthy();
      // The name comes from the tooltip, never a bare browser title.
      expect(button.getAttribute("title"), `${id} title`).toBeNull();
    }
  });

  it("gives every item its own glyph", async () => {
    const glyphs = (await render()).map((b) => b.getAttribute("data-icon"));
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("draws a bolt for Automations and a text file for the log viewer", async () => {
    await render();
    expect(icon("activity-bar-automations")).toBe("zap");
    expect(icon("activity-bar-logs")).toBe("file-text");
    const all = Array.from(container.querySelectorAll("[data-icon]"), (el) =>
      el.getAttribute("data-icon")
    );
    expect(all).not.toContain("clapperboard");
    expect(all).not.toContain("scroll-text");
  });

  it("renders the lucide glyph its tag names", async () => {
    await render();
    const svg = container.querySelector('[data-testid="activity-bar-logs"] svg');
    expect(svg?.getAttribute("class")).toContain("lucide-file-text");
    const macro = container.querySelector('[data-testid="activity-bar-automations"] svg');
    expect(macro?.getAttribute("class")).toContain("lucide-zap");
  });
});
