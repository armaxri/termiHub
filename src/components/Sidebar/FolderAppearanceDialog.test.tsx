/**
 * FolderAppearanceDialog (#5020): starts from the folder's saved style, previews
 * edits live, saves the folder with its new colour / emoji (other fields kept),
 * drops cleared keys, and blocks Save on an invalid emoji.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FolderAppearanceDialog } from "./FolderAppearanceDialog";
import type { ConnectionFolder } from "@/types/connection";

let container: HTMLDivElement;
let root: Root;

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const click = (testId: string) => act(() => q(testId)!.click());

function folder(patch: Partial<ConnectionFolder> = {}): ConnectionFolder {
  return { id: "Work", name: "Work", parentId: null, isExpanded: true, ...patch };
}

function render(f: ConnectionFolder | null, onSave = vi.fn(), onOpenChange = vi.fn()) {
  act(() =>
    root.render(<FolderAppearanceDialog folder={f} onSave={onSave} onOpenChange={onOpenChange} />)
  );
  return { onSave, onOpenChange };
}

describe("FolderAppearanceDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("stays closed without a folder", () => {
    render(null);
    expect(q("folder-appearance-dialog")).toBeNull();
  });

  it("starts from the saved style and shows it in the preview", () => {
    render(folder({ iconColor: "teal", iconEmoji: "💼" }));
    expect(q("icon-color-swatch-teal")?.getAttribute("aria-checked")).toBe("true");
    expect((q("connection-editor-icon-emoji") as HTMLInputElement).value).toBe("💼");
    expect(q("folder-appearance-preview")?.textContent).toContain("💼");
    expect(q("folder-appearance-preview")?.textContent).toContain("Work");
  });

  it("saves the picked colour and emoji, keeping the folder's other fields", () => {
    const { onSave, onOpenChange } = render(folder({ isExpanded: false, parentId: "Root" }));
    click("icon-color-swatch-purple");
    expect(
      q("folder-appearance-preview")?.querySelector("svg")?.getAttribute("data-icon-color")
    ).toBe("purple");
    setInput(q("connection-editor-icon-emoji") as HTMLInputElement, "🚀");
    click("folder-appearance-save");

    expect(onSave).toHaveBeenCalledWith({
      id: "Work",
      name: "Work",
      parentId: "Root",
      isExpanded: false,
      iconColor: "purple",
      iconEmoji: "🚀",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("drops cleared keys so the backend stores nothing for them", () => {
    const { onSave } = render(folder({ iconColor: "red", iconEmoji: "🔥" }));
    click("icon-color-swatch-default");
    click("connection-editor-clear-icon-emoji");
    click("folder-appearance-save");

    const saved = onSave.mock.calls[0][0] as ConnectionFolder;
    expect("iconColor" in saved).toBe(false);
    expect("iconEmoji" in saved).toBe(false);
  });

  it("shows an inline error and does not save an invalid emoji", () => {
    const { onSave } = render(folder());
    setInput(q("connection-editor-icon-emoji") as HTMLInputElement, "ab");
    expect(document.body.textContent).toContain("Enter a single emoji.");
    click("folder-appearance-save");
    expect(onSave).not.toHaveBeenCalled();
  });
});
