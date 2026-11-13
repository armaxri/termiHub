import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createRef } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  FileBrowserPathBar,
  isEditPathShortcut,
  type FileBrowserPathBarHandle,
} from "./FileBrowserPathBar";
import { TooltipProvider } from "@/components/ui";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

/** Every breadcrumb segment (`file-browser-crumb-<label>`), in order. */
function crumbsAll(): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-testid^="file-browser-crumb-"]'));
}

const handle = createRef<FileBrowserPathBarHandle>();

function render(currentPath: string, onNavigate = vi.fn(), disabled = false) {
  act(() => {
    root.render(
      <TooltipProvider>
        <FileBrowserPathBar
          ref={handle}
          currentPath={currentPath}
          onNavigate={onNavigate}
          disabled={disabled}
        />
      </TooltipProvider>
    );
  });
  return onNavigate;
}

/** Run `fn` with a macOS user agent (the keybinding defaults are per platform). */
function asMac<T>(fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "userAgent", {
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    configurable: true,
  });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(navigator, "userAgent", original);
    else delete (navigator as { userAgent?: string }).userAgent;
  }
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
    const crumbs = crumbsAll();
    // "/", "usr", "local"
    expect(crumbs.map((c) => c.textContent)).toEqual(["/", "usr", "local"]);
    // Each segment carries its own id, so a drag can target one ancestor.
    expect(crumbs.map((c) => c.dataset.testid)).toEqual([
      "file-browser-crumb-/",
      "file-browser-crumb-usr",
      "file-browser-crumb-local",
    ]);
  });

  it("navigates to a crumb's cumulative path when an ancestor crumb is clicked", () => {
    const onNavigate = render("/usr/local");
    const crumbs = crumbsAll();
    act(() => crumbs[1].click()); // "usr"
    expect(onNavigate).toHaveBeenCalledWith("/usr");
  });

  it("edits the path, not navigates, when the current (leaf) folder is clicked", () => {
    const onNavigate = render("/usr/local");
    const crumbs = crumbsAll();
    const last = crumbs[crumbs.length - 1] as HTMLButtonElement;
    // Still a focusable button, so the keyboard reaches the editor too.
    expect(last.disabled).toBe(false);
    expect(last.getAttribute("aria-current")).toBe("location");
    act(() => last.click());
    expect(onNavigate).not.toHaveBeenCalled();
    const input = query("file-browser-path-input") as HTMLInputElement | null;
    expect(input?.value).toBe("/usr/local");
  });

  it("switches to a pre-filled text input when the empty part of the bar is clicked", () => {
    render("/etc");
    act(() => query("file-browser-path-edit")?.click());
    const input = query("file-browser-path-input") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.value).toBe("/etc");
    // Breadcrumbs are replaced by the editor.
    expect(query("file-browser-current-path")).toBeNull();
  });

  it("has no separate edit button", () => {
    render("/etc");
    expect(container.querySelector('button[aria-label="Edit path"]')).toBeNull();
    // The empty-space trigger is pointer-only; it is not a tab stop.
    expect(query("file-browser-path-edit")?.tagName).toBe("SPAN");
  });

  it("selects the full path when the editor opens", async () => {
    render("/var/www/vhosts/example.com");
    act(() => handle.current?.startEditing());
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const input = query("file-browser-path-input") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("/var/www/vhosts/example.com".length);
  });

  it("opens the editor through the imperative handle (the shortcut path)", () => {
    render("/etc");
    act(() => handle.current?.startEditing());
    expect((query("file-browser-path-input") as HTMLInputElement).value).toBe("/etc");
  });

  it("stays read-only while disabled", () => {
    render("/etc", vi.fn(), true);
    expect(query("file-browser-path-edit")).toBeNull();
    act(() => handle.current?.startEditing());
    expect(query("file-browser-path-input")).toBeNull();
  });

  it("cancels editing on blur", () => {
    const onNavigate = render("/etc");
    act(() => query("file-browser-path-edit")?.click());
    const input = query("file-browser-path-input") as HTMLInputElement;
    typeInto(input, "/tmp");
    act(() => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(query("file-browser-current-path")).not.toBeNull();
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

describe("isEditPathShortcut (#5540)", () => {
  const key = (init: KeyboardEventInit) =>
    new KeyboardEvent("keydown", { key: "l", code: "KeyL", ...init });

  it("matches Ctrl+L on Windows/Linux", () => {
    expect(isEditPathShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isEditPathShortcut(key({}))).toBe(false);
    expect(isEditPathShortcut(key({ metaKey: true }))).toBe(false);
  });

  it("matches Cmd+L on macOS", () => {
    asMac(() => {
      expect(isEditPathShortcut(key({ metaKey: true }))).toBe(true);
      expect(isEditPathShortcut(key({ ctrlKey: true }))).toBe(false);
    });
  });

  it("ignores a key typed while an IME composes", () => {
    expect(isEditPathShortcut(key({ ctrlKey: true, isComposing: true }))).toBe(false);
  });
});
