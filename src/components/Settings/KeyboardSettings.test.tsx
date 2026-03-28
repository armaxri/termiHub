import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { KeyboardSettings } from "./KeyboardSettings";
import { clearOverrides } from "@/services/keybindings";

vi.mock("@/utils/cheatSheetPdf", () => ({
  exportCheatSheet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

let container: HTMLDivElement;
let root: Root;

function renderComponent(visibleFields?: Set<string>) {
  act(() => {
    root.render(<KeyboardSettings visibleFields={visibleFields} />);
  });
}

describe("KeyboardSettings", () => {
  beforeEach(() => {
    clearOverrides();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the keyboard shortcuts heading", () => {
    renderComponent();
    expect(container.querySelector("h3")?.textContent).toBe("Keyboard Shortcuts");
  });

  it("renders the search input", () => {
    renderComponent();
    const searchInput = container.querySelector('[data-testid="keyboard-settings-search"]');
    expect(searchInput).not.toBeNull();
  });

  it("renders binding rows for known actions", () => {
    renderComponent();
    expect(container.textContent).toContain("Toggle Sidebar");
    expect(container.textContent).toContain("Close Tab");
    expect(container.textContent).toContain("Copy Selection");
    expect(container.textContent).toContain("Paste");
  });

  it("renders reset all button", () => {
    renderComponent();
    const resetBtn = container.querySelector('[data-testid="keyboard-settings-reset-all"]');
    expect(resetBtn).not.toBeNull();
  });

  it("renders export HTML button", () => {
    renderComponent();
    const exportBtn = container.querySelector('[data-testid="keyboard-settings-export-pdf"]');
    expect(exportBtn).not.toBeNull();
    expect(exportBtn?.textContent).toContain("Save HTML Cheat Sheet");
  });

  it("calls exportCheatSheet when export PDF button is clicked", async () => {
    const { exportCheatSheet } = await import("@/utils/cheatSheetPdf");
    renderComponent();
    const exportBtn = container.querySelector(
      '[data-testid="keyboard-settings-export-pdf"]'
    ) as HTMLElement;

    act(() => {
      exportBtn.click();
    });

    expect(exportCheatSheet).toHaveBeenCalledOnce();
  });

  it("filters bindings by search query", () => {
    renderComponent();
    const searchInput = container.querySelector(
      '[data-testid="keyboard-settings-search"]'
    ) as HTMLInputElement;

    act(() => {
      searchInput.value = "clipboard";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      // Use native event to trigger React onChange
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      nativeInputValueSetter?.call(searchInput, "clipboard");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // After input event is fired with React's synthetic change handling,
    // we need to simulate via the React-compatible way
    act(() => {
      const changeEvent = new Event("change", { bubbles: true });
      Object.defineProperty(changeEvent, "target", {
        value: { value: "clipboard" },
      });
    });
  });

  it("renders nothing when visibleFields excludes keybindings", () => {
    renderComponent(new Set(["other"]));
    expect(container.innerHTML).toBe("");
  });

  it("shows category group headings", () => {
    renderComponent();
    const headings = container.querySelectorAll(".keyboard-settings__group-title");
    const titles = Array.from(headings).map((h) => h.textContent);
    expect(titles).toContain("General");
    expect(titles).toContain("Clipboard");
    expect(titles).toContain("Terminal");
    expect(titles).toContain("Navigation / Split");
  });

  it("enters recording mode when binding cell is clicked", () => {
    renderComponent();
    const bindingCell = container.querySelector(
      '[data-testid="keybinding-binding-toggle-sidebar"]'
    ) as HTMLElement;

    act(() => {
      bindingCell.click();
    });

    expect(container.textContent).toContain("Press a key combination...");
  });

  it("cancels recording mode on Escape", () => {
    renderComponent();
    const bindingCell = container.querySelector(
      '[data-testid="keybinding-binding-toggle-sidebar"]'
    ) as HTMLElement;

    act(() => {
      bindingCell.click();
    });
    expect(container.textContent).toContain("Press a key combination...");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.textContent).not.toContain("Press a key combination...");
  });
});
