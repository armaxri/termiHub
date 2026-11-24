/**
 * Long paths in the file browser's path bar (#5521): the middle segments fold
 * into a "…" menu so the leaf stays visible; the full path stays the tooltip.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const width = vi.hoisted(() => ({ value: null as number | null }));
vi.mock("@/hooks/useElementWidth", () => ({
  useElementWidth: () => [() => {}, width.value],
}));

import { TooltipProvider } from "@/components/ui";
import { CollapsingBreadcrumbs } from "./FileBrowserBreadcrumbs";

/** Measured width of a segment: 7px per character, plus 11px for a separator. */
function segmentWidth(el: Element): number {
  return (el.textContent ?? "").length * 7 + (el.querySelector("svg") ? 11 : 0);
}

let container: HTMLDivElement;
let root: Root;
const realRect = Element.prototype.getBoundingClientRect;

function render(currentPath: string, onNavigate = vi.fn(), onCopyPath?: () => void) {
  act(() => {
    root.render(
      <TooltipProvider>
        <CollapsingBreadcrumbs
          currentPath={currentPath}
          onNavigate={onNavigate}
          onCopyPath={onCopyPath}
        />
      </TooltipProvider>
    );
  });
  return onNavigate;
}

/** Labels of the visible segments ("…" for the fold), in order. */
function visible(): string[] {
  const nav = container.querySelector('[data-testid="file-browser-current-path"]')!;
  return Array.from(nav.querySelectorAll(":scope > .file-browser__crumb-group button")).map((b) =>
    (b.textContent ?? "").trim()
  );
}

beforeEach(() => {
  width.value = null;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const w = this.classList.contains("file-browser__crumb-group") ? segmentWidth(this) : 0;
    return { width: w, height: 16, top: 0, left: 0, right: w, bottom: 16, x: 0, y: 0 } as DOMRect;
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const LONG_LOCAL = "/Users/arne/work/git/termiHubDev/dev2/termiHub/src/components/Sidebar";

describe("CollapsingBreadcrumbs", () => {
  it("shows every segment when the path fits", () => {
    width.value = 2000;
    render(LONG_LOCAL);
    expect(visible()).toEqual(LONG_LOCAL.split("/").map((s) => s || "/"));
  });

  it("folds the middle of a long local path and keeps the leaf and root", () => {
    width.value = 200;
    render(LONG_LOCAL);
    const shown = visible();
    expect(shown[0]).toBe("/");
    expect(shown[1]).toBe("…");
    expect(shown[shown.length - 1]).toBe("Sidebar");
    expect(shown).toContain("components");
    // The full path stays the row's tooltip.
    const nav = container.querySelector('[data-testid="file-browser-current-path"]')!;
    expect(nav.getAttribute("title")).toBe(LONG_LOCAL);
    // The leaf is the current location.
    expect(
      container
        .querySelector('[data-testid="file-browser-crumb-Sidebar"]')!
        .getAttribute("aria-current")
    ).toBe("location");
  });

  it("keeps the drive of a deep Windows path", () => {
    width.value = 160;
    render("C:/Users/Administrator/AppData/Local/Programs/termiHub/resources/plugins");
    const shown = visible();
    expect(shown[0]).toBe("C:");
    expect(shown[1]).toBe("…");
    expect(shown[shown.length - 1]).toBe("plugins");
  });

  it("navigates to a folded ancestor from the fold's menu", async () => {
    width.value = 200;
    const onNavigate = render(LONG_LOCAL);
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="file-browser-crumb-overflow"]'
    )!;
    expect(trigger.getAttribute("aria-label")).toBe("Show collapsed folders");
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const item = document.querySelector<HTMLElement>(
      '[data-testid="file-browser-crumb-menu-arne"]'
    );
    expect(item).not.toBeNull();
    await act(async () => {
      item!.click();
    });
    expect(onNavigate).toHaveBeenCalledWith("/Users/arne");
  });

  it("renders the fold as a visible button and the root as an icon (#5624)", () => {
    width.value = 200;
    render(LONG_LOCAL);
    const trigger = container.querySelector('[data-testid="file-browser-crumb-overflow"]')!;
    expect(trigger.classList.contains("file-browser__crumb--overflow")).toBe(true);
    const rootCrumb = container.querySelector('[data-testid="file-browser-crumb-/"]')!;
    expect(rootCrumb.querySelector("svg")).not.toBeNull();
    expect(rootCrumb.getAttribute("aria-label")).toBe("Root folder (/)");
  });

  it("keeps the direct parent, middle-truncated, when it fits (#5624)", () => {
    const parent = "a-very-long-parent-folder-name";
    width.value = 200;
    render(`/home/${parent}/leaf`);
    expect(visible()).toEqual(["/", "…", parent, "leaf"]);
    const crumb = container.querySelector<HTMLElement>(
      `[data-testid="file-browser-crumb-${parent}"]`
    )!;
    // Head ellipsizes, tail stays: "a-very-long-pa…der-name".
    expect(crumb.querySelector(".file-browser__crumb-head")?.textContent).toBe(
      parent.slice(0, parent.length - 8)
    );
    expect(crumb.querySelector(".file-browser__crumb-tail")?.textContent).toBe(parent.slice(-8));
    expect(crumb.getAttribute("title")).toBe(parent);
    const group = crumb.closest<HTMLElement>(".file-browser__crumb-group")!;
    expect(group.classList.contains("file-browser__crumb-group--truncated")).toBe(true);
    expect(group.style.maxWidth).toMatch(/px$/);
  });

  it("copies the full path from the fold's menu (#5624)", async () => {
    width.value = 200;
    const onCopyPath = vi.fn();
    render(LONG_LOCAL, vi.fn(), onCopyPath);
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="file-browser-crumb-overflow"]'
    )!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const copy = document.querySelector<HTMLElement>(
      '[data-testid="file-browser-crumb-menu-copy-path"]'
    );
    expect(copy).not.toBeNull();
    await act(async () => {
      copy!.click();
    });
    expect(onCopyPath).toHaveBeenCalledTimes(1);
  });

  describe("a current folder wider than the row (#5833)", () => {
    /** The product run's deep path: five long folders, then a long leaf. */
    const SEGMENTS = Array.from(
      { length: 6 },
      (_, i) => `${i + 1}-a-rather-long-folder-name-for-the-path-bar-check`
    );
    const DEEP = `/home/tester/${SEGMENTS.join("/")}`;
    const LEAF = SEGMENTS[5];

    async function openFold() {
      const trigger = container.querySelector<HTMLButtonElement>(
        '[data-testid="file-browser-crumb-overflow"]'
      )!;
      await act(async () => {
        trigger.focus();
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
    }

    it.each([150, 200, 260])("keeps the whole leaf at %ipx, folding the rest first", (w) => {
      width.value = w;
      render(DEEP);
      // Root, every ancestor and the parent fold; only "…" stays beside the leaf.
      expect(visible()).toEqual(["…", LEAF]);
      const leaf = container.querySelector<HTMLElement>(
        `[data-testid="file-browser-crumb-${LEAF}"]`
      )!;
      // The leaf is never middle-truncated: no head/tail split, the whole name.
      expect(leaf.textContent).toBe(LEAF);
      expect(leaf.querySelector(".file-browser__crumb-head")).toBeNull();
      expect(leaf.getAttribute("aria-current")).toBe("location");
      const group = leaf.closest<HTMLElement>(".file-browser__crumb-group")!;
      expect(group.classList.contains("file-browser__crumb-group--leaf")).toBe(true);
      expect(group.style.maxWidth).toBe("");
    });

    it("keeps nearer ancestors beside a long leaf when there is room", () => {
      width.value = 800;
      render(DEEP);
      const shown = visible();
      expect(shown[shown.length - 1]).toBe(LEAF);
      expect(shown).toContain("…");
      expect(shown.length).toBeGreaterThan(2);
    });

    it("lists every folded folder in the '…' menu and navigates to it", async () => {
      width.value = 200;
      const onNavigate = render(DEEP);
      await openFold();
      const items = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="file-browser-crumb-menu-"]')
      ).map((el) => el.dataset.testid);
      expect(items).toEqual([
        "file-browser-crumb-menu-/",
        "file-browser-crumb-menu-home",
        "file-browser-crumb-menu-tester",
        ...SEGMENTS.slice(0, 5).map((s) => `file-browser-crumb-menu-${s}`),
      ]);
      await act(async () => {
        document
          .querySelector<HTMLElement>(`[data-testid="file-browser-crumb-menu-${SEGMENTS[4]}"]`)!
          .click();
      });
      expect(onNavigate).toHaveBeenCalledWith(`/home/tester/${SEGMENTS.slice(0, 5).join("/")}`);
    });

    it("navigates to the root from the '…' menu", async () => {
      width.value = 150;
      const onNavigate = render(DEEP);
      await openFold();
      await act(async () => {
        document.querySelector<HTMLElement>('[data-testid="file-browser-crumb-menu-/"]')!.click();
      });
      expect(onNavigate).toHaveBeenCalledWith("/");
    });

    it("carries the full path as the row's tooltip", () => {
      width.value = 150;
      render(DEEP);
      const nav = container.querySelector('[data-testid="file-browser-current-path"]')!;
      expect(nav.getAttribute("title")).toBe(DEEP);
    });

    it("styles the rendered leaf to wrap, never to ellipsize", () => {
      const css = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "FileBrowserPathBar.css"),
        "utf8"
      );
      const rule = css.match(
        /\.file-browser__breadcrumbs > \.file-browser__crumb-group--leaf \.file-browser__crumb \{([^}]*)\}/
      );
      expect(rule).not.toBeNull();
      expect(rule![1]).toMatch(/white-space:\s*normal/);
      expect(rule![1]).toMatch(/overflow-wrap:\s*anywhere/);
      expect(rule![1]).not.toMatch(/text-overflow:\s*ellipsis/);
      // The bar may grow for a wrapped leaf: a minimum, not a fixed height.
      const bar = css.match(/\.file-browser__path-bar \{([^}]*)\}/)![1];
      expect(bar).toMatch(/min-height:/);
      expect(bar).not.toMatch(/(^|[^-])height:/);
    });
  });
});
