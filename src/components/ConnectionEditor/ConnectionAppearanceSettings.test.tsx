/**
 * ConnectionAppearanceSettings: the tab-color + icon pickers in the connection
 * editor. These tests pin the prop-driven button labels ("Set …" vs "Change"), the
 * conditional color preview / icon and Clear buttons, and that Clear invokes the
 * matching callback with `undefined`. Part of TFE-007 coverage (#2934).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ConnectionAppearanceSettings } from "./ConnectionAppearanceSettings";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(
  props: { color?: string; icon?: string },
  onColorChange = vi.fn(),
  onIconChange = vi.fn()
) {
  act(() => {
    root.render(
      <ConnectionAppearanceSettings
        color={props.color}
        onColorChange={onColorChange}
        icon={props.icon}
        onIconChange={onIconChange}
      />
    );
  });
  return { onColorChange, onIconChange };
}

describe("ConnectionAppearanceSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows 'Set Color'/'Set Icon' and no Clear buttons when unset", () => {
    render({});
    expect(query("connection-editor-color-picker")?.textContent).toContain("Set Color");
    expect(query("connection-editor-icon-picker")?.textContent).toContain("Set Icon");
    expect(query("connection-editor-clear-color")).toBeNull();
    expect(query("connection-editor-clear-icon")).toBeNull();
    expect(container.querySelector(".connection-editor__color-preview")).toBeNull();
  });

  it("shows a color preview, 'Change' label, and Clear button when a color is set", () => {
    render({ color: "#ff8800" });
    expect(query("connection-editor-color-picker")?.textContent).toContain("Change");
    expect(query("connection-editor-clear-color")).not.toBeNull();
    const preview = container.querySelector(
      ".connection-editor__color-preview"
    ) as HTMLElement | null;
    expect(preview).not.toBeNull();
    expect(preview!.style.backgroundColor).toBe("rgb(255, 136, 0)");
  });

  it("shows the icon, 'Change' label, and Clear button when an icon is set", () => {
    render({ icon: "server" });
    expect(query("connection-editor-icon-picker")?.textContent).toContain("Change");
    expect(query("connection-editor-clear-icon")).not.toBeNull();
  });

  it("clears the color via onColorChange(undefined)", () => {
    const h = render({ color: "#ff8800" });
    act(() => query("connection-editor-clear-color")!.click());
    expect(h.onColorChange).toHaveBeenCalledWith(undefined);
  });

  it("clears the icon via onIconChange(undefined)", () => {
    const h = render({ icon: "server" });
    act(() => query("connection-editor-clear-icon")!.click());
    expect(h.onIconChange).toHaveBeenCalledWith(undefined);
  });

  it("does not invoke callbacks merely by opening the color picker", () => {
    const h = render({});
    act(() => query("connection-editor-color-picker")!.click());
    expect(h.onColorChange).not.toHaveBeenCalled();
  });
});
