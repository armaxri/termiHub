import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCheatSheetHtml, exportCheatSheet } from "./cheatSheetPdf";
import { setOverride, clearOverrides, RELEASE_CHORD_ACTION } from "@/services/keybindings";

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

describe("buildCheatSheetHtml platforms (#4711)", () => {
  const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15";
  const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists only the running platform's bindings by default (macOS)", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
    const html = buildCheatSheetHtml();
    expect(html).toContain("<kbd>Cmd+B</kbd>");
    expect(html).not.toContain("<kbd>Ctrl+Shift+B</kbd>");
    expect(html).not.toContain("Win / Linux");
  });

  it("lists only the running platform's bindings by default (Windows)", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WIN_UA);
    const html = buildCheatSheetHtml("current");
    expect(html).toContain("<kbd>Ctrl+Shift+B</kbd>");
    expect(html).not.toContain("<kbd>Cmd+B</kbd>");
  });

  it("lists both platforms with column headers when asked for all", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
    const html = buildCheatSheetHtml("all");
    expect(html).toContain("Win / Linux");
    expect(html).toContain("macOS");
    expect(html).toContain("<kbd>Ctrl+Shift+B</kbd>");
    expect(html).toContain("<kbd>Cmd+B</kbd>");
  });

  it("applies an override to the running platform's column only", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WIN_UA);
    setOverride("toggle-sidebar", { key: "j", ctrl: true, alt: true });
    const html = buildCheatSheetHtml("all");
    expect(html).toContain("<kbd>Ctrl+Alt+J</kbd>");
    expect(html).not.toContain("<kbd>Ctrl+Shift+B</kbd>");
    expect(html).toContain("<kbd>Cmd+B</kbd>");
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

  it("writes the all-platforms sheet when asked (#4711)", async () => {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await exportCheatSheet("all");
    expect(writeTextFile).toHaveBeenCalledWith(
      "/chosen/termihub-shortcuts.html",
      expect.stringContaining("Win / Linux")
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

describe("buildCheatSheetHtml experimental gate (#5403)", () => {
  it("omits the Remote Desktop group while experimental features are off", () => {
    for (const html of [
      buildCheatSheetHtml(),
      buildCheatSheetHtml("all", { experimental: false }),
    ]) {
      expect(html).not.toContain("<h3>Remote Desktop</h3>");
      expect(html).not.toContain("Release Remote Desktop Keyboard");
      expect(html).toContain("<h3>General</h3>");
    }
  });

  it("includes the Remote Desktop group while experimental features are on", () => {
    const html = buildCheatSheetHtml("current", { experimental: true });
    expect(html).toContain("<h3>Remote Desktop</h3>");
    expect(html).toContain("Release Remote Desktop Keyboard");
  });

  it("passes the gate through when exporting", async () => {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await exportCheatSheet("current", { experimental: true });
    expect(vi.mocked(writeTextFile).mock.calls[0][1]).toContain("<h3>Remote Desktop</h3>");
    vi.mocked(writeTextFile).mockClear();
    await exportCheatSheet();
    expect(vi.mocked(writeTextFile).mock.calls[0][1]).not.toContain("<h3>Remote Desktop</h3>");
  });

  it("keeps a Remote Desktop override stored while the group is hidden", () => {
    setOverride(RELEASE_CHORD_ACTION, { key: "", ctrl: true, alt: true });
    expect(buildCheatSheetHtml()).not.toContain("Release Remote Desktop Keyboard");
    expect(buildCheatSheetHtml("current", { experimental: true })).toContain(
      "Release Remote Desktop Keyboard"
    );
  });
});
