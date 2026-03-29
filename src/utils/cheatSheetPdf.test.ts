import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCheatSheetHtml, exportCheatSheet } from "./cheatSheetPdf";
import { setOverride, clearOverrides } from "@/services/keybindings";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn() }));

beforeEach(async () => {
  clearOverrides();
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  const { save } = await import("@tauri-apps/plugin-dialog");
  vi.mocked(writeTextFile).mockResolvedValue(undefined);
  vi.mocked(save).mockResolvedValue("/chosen/termihub-shortcuts.html");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildCheatSheetHtml", () => {
  it("includes all category headings", () => {
    const html = buildCheatSheetHtml();
    expect(html).toContain("General");
    expect(html).toContain("Clipboard");
    expect(html).toContain("Terminal");
    expect(html).toContain("Navigation / Split");
    expect(html).toContain("Tab Groups");
  });

  it("includes known shortcut labels", () => {
    const html = buildCheatSheetHtml();
    expect(html).toContain("Toggle Sidebar");
    expect(html).toContain("New Terminal");
  });

  it("marks overridden bindings with the dagger symbol", () => {
    setOverride("toggle-sidebar", { key: "b", ctrl: true, shift: true });
    const html = buildCheatSheetHtml();
    expect(html).toContain("&dagger;");
    expect(html).toContain("Custom binding");
  });

  it("does not include the dagger symbol when there are no overrides", () => {
    const html = buildCheatSheetHtml();
    expect(html).not.toContain("&dagger;");
  });

  it("produces valid HTML with doctype", () => {
    const html = buildCheatSheetHtml();
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("</html>");
  });
});

describe("exportCheatSheet", () => {
  it("opens a save dialog with the correct default filename", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    await exportCheatSheet();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "termihub-shortcuts.html" })
    );
  });

  it("writes the cheat sheet HTML to the chosen path", async () => {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await exportCheatSheet();
    expect(writeTextFile).toHaveBeenCalledWith(
      "/chosen/termihub-shortcuts.html",
      expect.stringContaining("termiHub")
    );
  });

  it("does nothing when the save dialog is cancelled", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    vi.mocked(save).mockResolvedValue(null);
    await exportCheatSheet();
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
