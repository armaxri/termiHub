import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Settings, Terminal, Shield, type LucideIcon } from "lucide-react";
import { SettingsNav } from "./SettingsNav";

type CatId = "general" | "terminal" | "safety";

const categories = [
  { id: "general", label: "General" },
  { id: "terminal", label: "Terminal" },
  { id: "safety", label: "Safety" },
];

const iconMap: Record<CatId, LucideIcon> = {
  general: Settings,
  terminal: Terminal,
  safety: Shield,
};

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(
  activeCategory: CatId,
  onChange = vi.fn(),
  extras: { highlighted?: Set<CatId>; isCompact?: boolean } = {}
) {
  act(() => {
    root.render(
      <SettingsNav<CatId>
        categories={categories}
        iconMap={iconMap}
        activeCategory={activeCategory}
        onCategoryChange={onChange}
        highlightedCategories={extras.highlighted}
        isCompact={extras.isCompact ?? false}
      />
    );
  });
  return onChange;
}

describe("SettingsNav", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a tab per category with its label", () => {
    render("general");
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(3);
    expect(query("settings-nav-general")?.textContent).toContain("General");
    expect(query("settings-nav-terminal")?.textContent).toContain("Terminal");
    expect(query("settings-nav-safety")?.textContent).toContain("Safety");
  });

  it("marks only the active category selected and focusable", () => {
    render("terminal");
    const active = query("settings-nav-terminal");
    const other = query("settings-nav-general");
    expect(active?.getAttribute("aria-selected")).toBe("true");
    expect(active?.className).toContain("settings-nav__item--active");
    expect(active?.getAttribute("tabindex")).toBe("0");
    expect(other?.getAttribute("aria-selected")).toBe("false");
    expect(other?.getAttribute("tabindex")).toBe("-1");
  });

  it("invokes onCategoryChange with the clicked category id", () => {
    const onChange = render("general");
    act(() => query("settings-nav-safety")?.click());
    expect(onChange).toHaveBeenCalledWith("safety");
  });

  it("dims categories absent from the highlighted set", () => {
    render("general", vi.fn(), { highlighted: new Set<CatId>(["general"]) });
    expect(query("settings-nav-general")?.className).not.toContain("settings-nav__item--dimmed");
    expect(query("settings-nav-terminal")?.className).toContain("settings-nav__item--dimmed");
  });

  it("dims nothing when no highlighted set is given", () => {
    render("general");
    expect(query("settings-nav-terminal")?.className).not.toContain("settings-nav__item--dimmed");
  });

  it("adds the compact modifier class when compact", () => {
    render("general", vi.fn(), { isCompact: true });
    expect(container.querySelector("nav")?.className).toContain("settings-nav--compact");
  });

  function pressKey(key: string) {
    const nav = container.querySelector("nav");
    act(() => {
      nav?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }

  it("ArrowDown moves to the next category", () => {
    const onChange = render("general");
    pressKey("ArrowDown");
    expect(onChange).toHaveBeenCalledWith("terminal");
  });

  it("ArrowUp wraps from the first to the last category", () => {
    const onChange = render("general");
    pressKey("ArrowUp");
    expect(onChange).toHaveBeenCalledWith("safety");
  });

  it("ArrowDown wraps from the last to the first category", () => {
    const onChange = render("safety");
    pressKey("ArrowDown");
    expect(onChange).toHaveBeenCalledWith("general");
  });

  it("ArrowRight/ArrowLeft mirror Down/Up", () => {
    const onChange = render("terminal");
    pressKey("ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("safety");
    pressKey("ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith("general");
  });

  it("ignores unrelated keys", () => {
    const onChange = render("general");
    pressKey("Enter");
    expect(onChange).not.toHaveBeenCalled();
  });
});
