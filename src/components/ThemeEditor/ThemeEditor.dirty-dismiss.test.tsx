/**
 * Regression tests for UX2-004 (#4314): the theme editor must not drop its
 * colour picks on Escape, a scrim click or Cancel. A dirty draft asks first; an
 * untouched one cancels immediately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ThemeEditor } from "./ThemeEditor";
import { createCustomTheme } from "@/themes";
import { flushAsync } from "@/test/flushAsync";
import { click, clickScrim, pressEscape, typeInto, unsavedPromptOpen } from "@/test/dirtyDismiss";

vi.mock("@/themes", async (orig) => ({
  ...(await orig<typeof import("@/themes")>()),
  previewTheme: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

const theme = createCustomTheme("dark", "Mine");

async function render() {
  const onCancel = vi.fn();
  act(() => {
    root.render(<ThemeEditor open initialTheme={theme} onSave={vi.fn()} onCancel={onCancel} />);
  });
  await flushAsync();
  return onCancel;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ThemeEditor — dirty dismiss (UX2-004)", () => {
  it.each([
    ["Escape", () => pressEscape("theme-editor-name")],
    ["scrim click", () => clickScrim("theme-editor-dialog")],
    ["Cancel", () => click("theme-editor-cancel")],
  ])("%s after a colour pick asks before discarding", async (_label, dismiss) => {
    const onCancel = await render();
    typeInto("theme-editor-hex-accentColor", "#ff8800");
    dismiss();
    expect(onCancel).not.toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(true);
  });

  it("a renamed theme counts as unsaved too", async () => {
    const onCancel = await render();
    typeInto("theme-editor-name", "Mine 2");
    pressEscape("theme-editor-name");
    expect(onCancel).not.toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(true);
  });

  it("Discard on the prompt cancels the edit", async () => {
    const onCancel = await render();
    typeInto("theme-editor-hex-accentColor", "#ff8800");
    click("theme-editor-cancel");
    click("unsaved-changes-just-close");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("an untouched draft cancels on Escape without asking", async () => {
    const onCancel = await render();
    pressEscape("theme-editor-name");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(unsavedPromptOpen()).toBe(false);
  });
});
