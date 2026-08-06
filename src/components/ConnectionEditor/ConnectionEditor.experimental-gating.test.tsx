/**
 * Experimental gating of the connection-type picker (#1705).
 *
 * The New Connection type picker must not offer graphical remote-desktop types
 * (those reporting `capabilities.graphical`) unless `experimentalFeaturesEnabled`
 * is on. When it is on, those types appear labelled "— Experimental".
 */
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
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
  displayName: "Local Shell",
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

function renderNew(experimentalFeaturesEnabled: boolean) {
  const initial = useAppStore.getInitialState();
  useAppStore.setState({
    ...initial,
    connectionTypes: [LOCAL_TYPE, MOCK_RD_TYPE],
  });
  seedConnectionsRegion({ connections: [] });
  seedSettings({ experimentalFeaturesEnabled });
  act(() => {
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
  it("omits graphical remote-desktop types when the flag is off", () => {
    renderNew(false);
    const options = openTypeOptions();
    const values = options.map((o) => o.getAttribute("data-value"));
    expect(values).toContain("local");
    expect(values).not.toContain("mock-remote-desktop");
  });

  it("offers graphical types labelled '— Experimental' when the flag is on", () => {
    renderNew(true);
    const options = openTypeOptions();
    const rd = options.find((o) => o.getAttribute("data-value") === "mock-remote-desktop");
    expect(rd).toBeTruthy();
    expect(rd?.textContent).toContain("Experimental");
    const local = options.find((o) => o.getAttribute("data-value") === "local");
    expect(local?.textContent).not.toContain("Experimental");
  });
});
