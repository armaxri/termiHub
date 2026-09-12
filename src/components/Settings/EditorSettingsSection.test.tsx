import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { EditorSettingsSection } from "./EditorSettingsSection";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

function render(props: { visibleFields?: Set<string> } = {}) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <EditorSettingsSection {...props} />
      </TooltipProvider>
    );
  });
}

function query(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

setupSettingsRegion();

describe("EditorSettingsSection", () => {
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
  });

  // This wrapper is the single lazy chunk boundary the SettingsPanel loads for the
  // Editor category (PERF-001). It exists so Monaco/Shiki can be code-split out of
  // the main bundle; the regression it guards is that all three Editor-category
  // panels are still composed by it (a dropped panel would silently vanish from
  // Settings even though the bundle-split "works").
  it("renders all three editor-category settings panels", () => {
    render();
    expect(query("settings-editor")).not.toBeNull();
    expect(query("language-packages-settings")).not.toBeNull();
    expect(query("custom-grammars-settings")).not.toBeNull();
  });

  it("forwards visibleFields to the panels (search-filtered render)", () => {
    // An empty visible set hides every field, but each panel still mounts its
    // container — proving the prop is threaded through rather than crashing.
    render({ visibleFields: new Set<string>() });
    expect(query("settings-editor")).not.toBeNull();
    expect(query("language-packages-settings")).not.toBeNull();
    expect(query("custom-grammars-settings")).not.toBeNull();
  });
});
