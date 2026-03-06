import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ShortcutsOverlay } from "./ShortcutsOverlay";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

let container: HTMLDivElement;
let root: Root;

describe("ShortcutsOverlay", () => {
  beforeEach(() => {
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

  it("renders nothing when closed", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={false} onOpenChange={vi.fn()} />);
    });
    expect(document.querySelector('[data-testid="shortcuts-overlay"]')).toBeNull();
  });

  it("renders the overlay when open", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const overlay = document.querySelector('[data-testid="shortcuts-overlay"]');
    expect(overlay).not.toBeNull();
  });

  it("shows the title", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    expect(document.querySelector(".shortcuts-overlay__title")?.textContent).toBe(
      "Keyboard Shortcuts"
    );
  });

  it("renders the search input", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    expect(document.querySelector('[data-testid="shortcuts-overlay-search"]')).not.toBeNull();
  });

  it("shows binding rows for known actions", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const content = document.querySelector('[data-testid="shortcuts-overlay"]')?.textContent ?? "";
    expect(content).toContain("Toggle Sidebar");
    expect(content).toContain("Close Tab");
    expect(content).toContain("Copy Selection");
    expect(content).toContain("Paste");
  });

  it("shows both Win/Linux and macOS column headers", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const headers = document.querySelectorAll(".shortcuts-overlay__table th");
    const headerTexts = Array.from(headers).map((h) => h.textContent);
    expect(headerTexts).toContain("Win / Linux");
    expect(headerTexts).toContain("macOS");
  });

  it("shows category group labels", () => {
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />);
    });
    const labels = document.querySelectorAll(".shortcuts-overlay__group-label");
    const texts = Array.from(labels).map((l) => l.textContent);
    expect(texts).toContain("General");
    expect(texts).toContain("Clipboard");
    expect(texts).toContain("Terminal");
  });

  it("calls onOpenChange when close button is clicked", () => {
    const onOpenChange = vi.fn();
    act(() => {
      root.render(<ShortcutsOverlay open={true} onOpenChange={onOpenChange} />);
    });
    const closeBtn = document.querySelector(
      '[data-testid="shortcuts-overlay-close"]'
    ) as HTMLElement;
    act(() => {
      closeBtn.click();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
