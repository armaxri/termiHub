/**
 * Experimental gating of the connection-type picker (#1705).
 *
 * The New Connection type picker must not offer graphical remote-desktop types
 * (those reporting `capabilities.graphical`) unless `experimentalFeaturesEnabled`
 * is on. When it is on, those types carry a neutral "Preview" badge, and selecting
 * one shows a one-line note on what that means and its known limits (#5873).
 */
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo } from "@/types/connection";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const LOCAL_TYPE: ConnectionTypeInfo = {
  typeId: "local",
  displayName: "Local shell",
  icon: "terminal",
  schema: { groups: [] },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

const MOCK_RD_TYPE: ConnectionTypeInfo = {
  typeId: "mock-remote-desktop",
  displayName: "Mock Remote Desktop",
  icon: "monitor",
  schema: { groups: [] },
  capabilities: {
    monitoring: false,
    fileBrowser: false,
    resize: true,
    persistent: false,
    graphical: true,
  },
};

let container: HTMLDivElement;
let root: Root;

async function renderNew(experimentalFeaturesEnabled: boolean) {
  const initial = useAppStore.getInitialState();
  useAppStore.setState({
    ...initial,
    connectionTypes: [LOCAL_TYPE, MOCK_RD_TYPE],
  });
  seedConnectionsRegion({ connections: [] });
  seedSettings({ experimentalFeaturesEnabled });
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId="tab-1"
          meta={{ connectionId: "new", folderId: null }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

/** Open the Radix type-select and return its rendered option elements. */
function openTypeOptions(): HTMLElement[] {
  const trigger = document.querySelector(
    '[data-testid="connection-editor-type-select"]'
  ) as HTMLElement | null;
  if (!trigger) throw new Error("type select trigger not found");
  for (let i = 0; i < 3 && document.querySelectorAll(".ui-select__item").length === 0; i++) {
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );
    });
  }
  return Array.from(document.querySelectorAll<HTMLElement>(".ui-select__item"));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

setupSettingsRegion();
setupConnectionsRegion();

describe("ConnectionEditor — experimental type-picker gating", () => {
  it("omits graphical remote-desktop types when the flag is off", async () => {
    await renderNew(false);
    const options = openTypeOptions();
    const values = options.map((o) => o.getAttribute("data-value"));
    expect(values).toContain("local");
    expect(values).not.toContain("mock-remote-desktop");
  });

  it("offers graphical types with a Preview badge when the flag is on (#5873)", async () => {
    await renderNew(true);
    const options = openTypeOptions();
    const rd = options.find((o) => o.getAttribute("data-value") === "mock-remote-desktop");
    expect(rd).toBeTruthy();
    const badge = rd!.querySelector('[data-testid="connection-type-preview-badge"]');
    expect(badge?.textContent).toBe("Preview");
    // The old suffix said nothing about what was experimental (R-166).
    expect(rd?.textContent).not.toContain("Experimental");
    expect(rd?.textContent).toContain("Mock Remote Desktop");
    const local = options.find((o) => o.getAttribute("data-value") === "local");
    expect(local?.querySelector('[data-testid="connection-type-preview-badge"]')).toBeNull();
  });

  it("shows the preview note only while a preview type is selected", async () => {
    await renderNew(true);
    expect(document.querySelector('[data-testid="connection-editor-preview-note"]')).toBeNull();
    const options = openTypeOptions();
    const rd = options.find((o) => o.getAttribute("data-value") === "mock-remote-desktop")!;
    await act(async () => {
      rd.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      rd.click();
    });
    await flushAsync();
    const note = document.querySelector('[data-testid="connection-editor-preview-note"]');
    expect(note?.textContent).toMatch(/^Preview: still being tested/);
  });
});
