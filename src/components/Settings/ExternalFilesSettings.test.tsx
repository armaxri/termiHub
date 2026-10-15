import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
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
    root.render(
      <TooltipProvider delayDuration={0}>
        <ExternalFilesSettings />
      </TooltipProvider>
    );
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

  it("keeps the header actions in their own wrapping group beside the title (#4728)", () => {
    render();
    const header = container.querySelector(".settings-panel__section-header");
    expect(header).not.toBeNull();
    // Title first, then one actions group: the header can wrap the group below
    // the title as a unit instead of squeezing the title next to the buttons.
    const children = Array.from(header?.children ?? []);
    expect(children).toHaveLength(2);
    expect(children[0].tagName).toBe("H3");
    expect(children[0].textContent).toBe("External Connection Files");
    expect(children[1].classList.contains("settings-panel__section-actions")).toBe(true);
    const actions = children[1];
    // Every header control, including the primary Add button, lives in that group.
    expect(actions.contains(query("external-files-add"))).toBe(true);
    expect(actions.contains(buttonByText("Reload"))).toBe(true);
    expect(actions.contains(buttonByText("Create File"))).toBe(true);
  });
});

// The #4728 regression is a layout one jsdom cannot measure (the Add button sat
// off-screen at 800x600), so pin the stylesheet's load-bearing wrap rules.
describe("SettingsPanel.css – section header wraps instead of clipping (#4728)", () => {
  // Vitest runs from the repo root, so resolve the stylesheet against cwd.
  const css = readFileSync("src/components/Settings/SettingsPanel.css", "utf8");

  /** Return the declaration body of `<selector> { ... }` (first match), or "". */
  function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    return match ? match[1] : "";
  }

  it("wraps the header so the actions move below the title when narrow", () => {
    const header = ruleBody(".settings-panel__section-header");
    expect(header).toContain("display: flex");
    expect(header).toContain("flex-wrap: wrap");
  });

  it("wraps the actions group so a long button strip never overflows", () => {
    const actions = ruleBody(".settings-panel__section-actions");
    expect(actions).toContain("flex-wrap: wrap");
  });

  it("lets a long header title break instead of forcing the row wider", () => {
    const title = ruleBody(".settings-panel__section-header > :is(h3, h4)");
    expect(title).toContain("min-width: 0");
    expect(title).toContain("overflow-wrap: anywhere");
  });

  it("wraps the create-file prompt so Save and Cancel stay reachable", () => {
    expect(ruleBody(".settings-panel__create-prompt")).toContain("flex-wrap: wrap");
  });
});
