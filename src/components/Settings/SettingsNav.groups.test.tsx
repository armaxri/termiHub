import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Settings, Terminal, Shield, Puzzle, HardDrive, type LucideIcon } from "lucide-react";
import { SettingsNav, type SettingsNavGroup } from "./SettingsNav";
import { CATEGORIES, CATEGORY_GROUPS } from "./settingsRegistry";
import { checkA11y } from "@/test/axe";

type CatId = "general" | "terminal" | "security" | "plugins" | "portable";

const categories = [
  { id: "general", label: "General" },
  { id: "terminal", label: "Terminal" },
  { id: "security", label: "Security" },
  { id: "plugins", label: "Plugins" },
  { id: "portable", label: "Portable mode" },
];

const iconMap: Record<CatId, LucideIcon> = {
  general: Settings,
  terminal: Terminal,
  security: Shield,
  plugins: Puzzle,
  portable: HardDrive,
};

const groups: SettingsNavGroup<CatId>[] = [
  { id: "basics", label: "Basics", categories: ["general", "terminal"] },
  { id: "security", label: "Security", categories: ["security"] },
  { id: "advanced", label: "Advanced", categories: ["plugins", "portable"], collapsible: true },
];

let container: HTMLDivElement;
let root: Root;

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

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
        groups={groups}
        activeCategory={activeCategory}
        onCategoryChange={onChange}
        highlightedCategories={extras.highlighted}
        isCompact={extras.isCompact ?? false}
      />
    );
  });
  return onChange;
}

/** Whether the item sits in a folded group (rendered, but not shown). */
const isFolded = (id: CatId) => q(`settings-nav-${id}`)?.closest("[hidden]") !== null;

describe("SettingsNav groups (#5561)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a sentence-case heading per group above its categories", () => {
    render("general");
    expect(q("settings-navgroup-basics")?.textContent).toBe("Basics");
    expect(q("settings-navgroup-security")?.textContent).toBe("Security");
    expect(q("settings-navgroup-advanced-toggle")?.textContent).toBe("Advanced");
    const lists = container.querySelectorAll('[role="tablist"]');
    expect(lists).toHaveLength(3);
    expect(lists[0].getAttribute("aria-labelledby")).toBe("settings-navgroup-basics");
    expect(lists[0].querySelectorAll('[role="tab"]')).toHaveLength(2);
  });

  it("folds the collapsible group by default but keeps its items in the DOM", () => {
    render("general");
    const toggle = q("settings-navgroup-advanced-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(isFolded("plugins")).toBe(true);
    expect(q("settings-nav-plugins")?.getAttribute("data-group-collapsed")).toBe("true");
    expect(q("settings-nav-plugins")?.getAttribute("data-nav-group")).toBe("advanced");
    expect(isFolded("general")).toBe(false);
  });

  it("opens and folds the group from its heading", () => {
    render("general");
    act(() => q("settings-navgroup-advanced-toggle")!.click());
    expect(q("settings-navgroup-advanced-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(isFolded("portable")).toBe(false);
    expect(q("settings-nav-portable")?.getAttribute("data-group-collapsed")).toBeNull();
    act(() => q("settings-navgroup-advanced-toggle")!.click());
    expect(isFolded("portable")).toBe(true);
  });

  it("stays open while its category is active", () => {
    render("portable");
    expect(isFolded("portable")).toBe(false);
    const toggle = q("settings-navgroup-advanced-toggle")!;
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    act(() => toggle.click());
    expect(isFolded("portable")).toBe(false);
  });

  it("opens when a search matches one of its categories", () => {
    render("general", vi.fn(), { highlighted: new Set<CatId>(["plugins"]) });
    expect(isFolded("plugins")).toBe(false);
    render("general", vi.fn(), { highlighted: new Set<CatId>(["security"]) });
    expect(isFolded("plugins")).toBe(true);
  });

  it("moves with the arrow keys across groups and skips folded categories", () => {
    const onChange = render("terminal");
    act(() => {
      q("settings-nav-terminal")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });
    expect(onChange).toHaveBeenLastCalledWith("security");
    render("security", onChange);
    act(() => {
      q("settings-nav-security")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });
    // Advanced is folded, so the next reachable category wraps to the start.
    expect(onChange).toHaveBeenLastCalledWith("general");
  });

  it("ignores groups in compact mode and renders one flat tab list", () => {
    render("general", vi.fn(), { isCompact: true });
    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(q("settings-navgroup-basics")).toBeNull();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(5);
  });

  it("has no axe violations, folded and open", async () => {
    render("general");
    await checkA11y(container);
    act(() => q("settings-navgroup-advanced-toggle")!.click());
    await checkA11y(container);
  });
});

describe("SettingsNav keeps the active category in view (#5633)", () => {
  const original = Element.prototype.scrollIntoView;
  let scrolled: { id: string | null; options: unknown }[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    scrolled = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element, options?: unknown) {
      scrolled.push({ id: this.getAttribute("data-testid"), options });
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Element.prototype.scrollIntoView = original;
  });

  it("scrolls an active category under the folded Advanced group into view on open", () => {
    render("portable");
    expect(scrolled.at(-1)).toEqual({
      id: "settings-nav-portable",
      options: { block: "nearest", inline: "nearest" },
    });
  });

  it("scrolls the newly active category into view when the selection changes", () => {
    render("general");
    render("plugins");
    expect(scrolled.at(-1)?.id).toBe("settings-nav-plugins");
  });

  it("does not scroll again while the active category stays the same", () => {
    render("terminal");
    const count = scrolled.length;
    render("terminal", vi.fn(), { highlighted: new Set<CatId>(["security"]) });
    expect(scrolled).toHaveLength(count);
  });

  it("also keeps the active tab in view in the compact (horizontal) nav", () => {
    render("portable", vi.fn(), { isCompact: true });
    expect(scrolled.at(-1)?.id).toBe("settings-nav-portable");
  });

  it("exposes the nav scroll box for the product-run grade", () => {
    render("general");
    expect(q("settings-category-nav")?.classList.contains("settings-nav")).toBe(true);
  });
});

describe("CATEGORY_GROUPS (#5561)", () => {
  it("puts every category in exactly one group", () => {
    const grouped = CATEGORY_GROUPS.flatMap((g) => g.categories);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(CATEGORIES.map((c) => c.id)).toEqual(grouped);
  });

  it("keeps at most five headings and at most 14 always-visible categories", () => {
    expect(CATEGORY_GROUPS.length).toBeLessThanOrEqual(5);
    const visible = CATEGORY_GROUPS.filter((g) => !g.collapsible).flatMap((g) => g.categories);
    expect(visible.length).toBeLessThanOrEqual(14);
    expect(visible).toContain("general");
    expect(visible).toContain("security");
  });

  it("files the rare pages under the folded Advanced group", () => {
    const advanced = CATEGORY_GROUPS.find((g) => g.id === "advanced")!;
    expect(advanced.collapsible).toBe(true);
    expect(advanced.categories).toEqual(
      expect.arrayContaining(["portable", "x-server", "schedules"])
    );
  });
});
