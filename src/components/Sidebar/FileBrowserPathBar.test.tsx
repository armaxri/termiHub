import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { FileBrowserPathBar } from "./FileBrowserPathBar";
import { TooltipProvider } from "@/components/ui";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function queryAll(testId: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(`[data-testid="${testId}"]`));
}

function render(currentPath: string, onNavigate = vi.fn()) {
  act(() => {
    root.render(
      <TooltipProvider>
        <FileBrowserPathBar currentPath={currentPath} onNavigate={onNavigate} />
      </TooltipProvider>
    );
  });
  return onNavigate;
}

function keyDown(el: HTMLElement, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

/** Set a controlled input's value the way React detects (native setter + input event). */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("FileBrowserPathBar", () => {
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

  it("renders one clickable breadcrumb per path segment", () => {
    render("/usr/local");
    const crumbs = queryAll("file-browser-crumb");
    // "/", "usr", "local"
    expect(crumbs.map((c) => c.textContent)).toEqual(["/", "usr", "local"]);
  });

  it("navigates to a crumb's cumulative path when an ancestor crumb is clicked", () => {
    const onNavigate = render("/usr/local");
    const crumbs = queryAll("file-browser-crumb");
    act(() => crumbs[1].click()); // "usr"
    expect(onNavigate).toHaveBeenCalledWith("/usr");
  });

  it("disables the crumb for the current path (no navigation on click)", () => {
    const onNavigate = render("/usr/local");
    const crumbs = queryAll("file-browser-crumb");
    const last = crumbs[crumbs.length - 1] as HTMLButtonElement;
    expect(last.disabled).toBe(true);
    act(() => last.click());
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("switches to a pre-filled text input when the edit affordance is clicked", () => {
    render("/etc");
    act(() => query("file-browser-path-edit")?.click());
    const input = query("file-browser-path-input") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.value).toBe("/etc");
    // Breadcrumbs are replaced by the editor.
    expect(query("file-browser-current-path")).toBeNull();
  });

  it("navigates to the typed path on Enter", () => {
    const onNavigate = render("/etc");
    act(() => query("file-browser-path-edit")?.click());
    const input = query("file-browser-path-input") as HTMLInputElement;
    typeInto(input, "/var/log");
    keyDown(input, "Enter");
    expect(onNavigate).toHaveBeenCalledWith("/var/log");
    // Editor closes back to breadcrumbs after committing.
    expect(query("file-browser-current-path")).not.toBeNull();
  });

  it("cancels editing on Escape without navigating", () => {
    const onNavigate = render("/etc");
    act(() => query("file-browser-path-edit")?.click());
    const input = query("file-browser-path-input") as HTMLInputElement;
    typeInto(input, "/should/not/apply");
    keyDown(input, "Escape");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(query("file-browser-current-path")).not.toBeNull();
  });

  it("does not navigate on Enter when the typed path is unchanged", () => {
    const onNavigate = render("/etc");
    act(() => query("file-browser-path-edit")?.click());
    const input = query("file-browser-path-input") as HTMLInputElement;
    keyDown(input, "Enter");
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
