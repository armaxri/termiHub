import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { ExternalFilesSettings } from "./ExternalFilesSettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(<ExternalFilesSettings />);
  });
}

function query(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

/** Find a button by its (trimmed) label text — labels survive the primitive migration. */
function buttonByText(text: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll("button"));
  return (buttons.find((b) => b.textContent?.trim() === text) as HTMLButtonElement) ?? null;
}

describe("ExternalFilesSettings", () => {
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

  it("renders the migrated action buttons using the shared primitive", () => {
    render();
    const add = query("external-files-add") as HTMLButtonElement | null;
    expect(add).not.toBeNull();
    expect(add?.tagName).toBe("BUTTON");
    expect(add?.className).toContain("ui-btn--primary");
    expect(buttonByText("Reload")).not.toBeNull();
    expect(buttonByText("Create File")).not.toBeNull();
  });

  it("toggles the create-file prompt when 'Create File' is clicked", () => {
    render();
    expect(container.querySelector(".settings-panel__create-prompt")).toBeNull();
    act(() => {
      buttonByText("Create File")?.click();
    });
    expect(container.querySelector(".settings-panel__create-prompt")).not.toBeNull();
    // Save + Cancel are now shared Button primitives.
    expect(buttonByText("Save")?.className).toContain("ui-btn--primary");
    expect(buttonByText("Cancel")?.className).toContain("ui-btn--secondary");
  });

  it("hides the create-file prompt when Cancel is clicked", () => {
    render();
    act(() => {
      buttonByText("Create File")?.click();
    });
    act(() => {
      buttonByText("Cancel")?.click();
    });
    expect(container.querySelector(".settings-panel__create-prompt")).toBeNull();
  });

  it("shows the empty state when no external files are configured", () => {
    render();
    expect(container.textContent).toContain("No external connection files configured.");
  });
});
