/**
 * Long paths in the file browser's path bar (#5521): the middle segments fold
 * into a "…" menu so the leaf stays visible; the full path stays the tooltip.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
});
