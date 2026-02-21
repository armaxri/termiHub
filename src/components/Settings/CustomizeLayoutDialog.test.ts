import { describe, it, expect } from "vitest";
import { getActivePreset } from "./CustomizeLayoutDialog";
import { DEFAULT_LAYOUT, LAYOUT_PRESETS } from "@/types/connection";
import type { LayoutConfig } from "@/types/connection";

describe("getActivePreset", () => {
  it("returns 'default' for DEFAULT_LAYOUT", () => {
    expect(getActivePreset(DEFAULT_LAYOUT)).toBe("default");
  });

  it("returns 'focus' for LAYOUT_PRESETS.focus", () => {
    expect(getActivePreset(LAYOUT_PRESETS.focus)).toBe("focus");
  });

  it("returns 'zen' for LAYOUT_PRESETS.zen", () => {
    expect(getActivePreset(LAYOUT_PRESETS.zen)).toBe("zen");
  });

  it("returns null for a custom config matching no preset", () => {
    const custom: LayoutConfig = {
      activityBarPosition: "right",
      sidebarPosition: "right",
      sidebarVisible: true,
      statusBarVisible: false,
    };
    expect(getActivePreset(custom)).toBeNull();
  });

  it("returns null for a partial match (one field different)", () => {
    const almostDefault: LayoutConfig = {
      ...DEFAULT_LAYOUT,
      statusBarVisible: false,
    };
    expect(getActivePreset(almostDefault)).toBeNull();
  });
});
