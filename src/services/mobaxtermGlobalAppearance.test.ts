import { describe, expect, it } from "vitest";
import type { AppSettings, MobaxtermGlobalAppearance } from "@/types/connection";
import { createCustomTheme, customThemeSetting } from "@/themes/customThemes";
import { darkTheme } from "@/themes/dark";
import { lightTheme } from "@/themes/light";
import {
  appearanceChanges,
  applyMobaxtermGlobalAppearance,
  buildMobaxtermTheme,
} from "./mobaxtermGlobalAppearance";

const SETTINGS: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

const ANSI = [
  "#010203",
  "#c80000",
  "#00c800",
  "#c8c800",
  "#0000c8",
  "#c800c8",
  "#00c8c8",
  "#c8c8c8",
  "#0b0c0d",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];

const GLOBAL: MobaxtermGlobalAppearance = {
  colors: { foreground: "#ececec", background: "#1e1e1e", cursor: "#b4b4c0", ansi: ANSI },
  fontFamily: '"Example Mono", monospace',
  fontSize: 16,
  cursorStyle: "bar",
  cursorBlink: false,
};

describe("buildMobaxtermTheme", () => {
  it("maps terminal and ANSI colours onto a dark base", () => {
    const theme = buildMobaxtermTheme(GLOBAL.colors!, []);
    expect(theme.name).toBe("MobaXterm");
    expect(theme.baseTheme).toBe("dark");
    expect(theme.colors.terminalBg).toBe("#1e1e1e");
    expect(theme.colors.terminalFg).toBe("#ececec");
    expect(theme.colors.terminalCursor).toBe("#b4b4c0");
    expect(theme.colors.ansiBlack).toBe("#010203");
    expect(theme.colors.ansiWhite).toBe("#c8c8c8");
    expect(theme.colors.ansiBrightBlack).toBe("#0b0c0d");
    expect(theme.colors.ansiBrightWhite).toBe("#ffffff");
    // UI colours come from the base theme.
    expect(theme.colors.bgPrimary).toBe(darkTheme.colors.bgPrimary);
  });

  it("uses the light base for a light background and keeps missing colours", () => {
    const ansi = Array<string | null>(16).fill(null);
    ansi[1] = "#aa0000";
    const theme = buildMobaxtermTheme({ background: "#fafafa", ansi }, []);
    expect(theme.baseTheme).toBe("light");
    expect(theme.colors.ansiRed).toBe("#aa0000");
    expect(theme.colors.ansiGreen).toBe(lightTheme.colors.ansiGreen);
    expect(theme.colors.terminalFg).toBe(lightTheme.colors.terminalFg);
  });

  it("never reuses an existing theme's name", () => {
    const existing = [createCustomTheme("dark", "MobaXterm"), createCustomTheme("dark", "Other")];
    const theme = buildMobaxtermTheme(GLOBAL.colors!, existing);
    expect(theme.name).toBe("MobaXterm (2)");
    expect(existing.map((t) => t.id)).not.toContain(theme.id);
  });
});

describe("appearanceChanges", () => {
  it("lists before → after against termiHub's defaults", () => {
    expect(appearanceChanges(GLOBAL, SETTINGS)).toEqual([
      { key: "fontFamily", label: "Font", before: "termiHub default", after: "Example Mono" },
      { key: "fontSize", label: "Font size", before: "14 px", after: "16 px" },
      { key: "cursorStyle", label: "Cursor style", before: "Block", after: "Bar" },
      { key: "cursorBlink", label: "Cursor blink", before: "On", after: "Off" },
    ]);
  });

  it("leaves out values that already match", () => {
    const settings = { ...SETTINGS, fontSize: 16, cursorStyle: "bar" as const, cursorBlink: false };
    expect(appearanceChanges(GLOBAL, settings).map((c) => c.key)).toEqual(["fontFamily"]);
    expect(appearanceChanges({ fontSize: 14 }, SETTINGS)).toEqual([]);
  });
});

describe("applyMobaxtermGlobalAppearance", () => {
  it("changes nothing without an opt-in", () => {
    expect(
      applyMobaxtermGlobalAppearance(SETTINGS, GLOBAL, { theme: false, appearance: false })
    ).toBeNull();
  });

  it("adds and selects a new theme without touching existing ones or the font", () => {
    const mine = createCustomTheme("dark", "MobaXterm");
    const settings = { ...SETTINGS, customThemes: [mine], theme: customThemeSetting(mine.id) };
    const result = applyMobaxtermGlobalAppearance(settings, GLOBAL, {
      theme: true,
      appearance: false,
    });
    const next = result!.settings;
    expect(next.customThemes).toHaveLength(2);
    expect(next.customThemes![0]).toBe(mine);
    expect(next.theme).toBe(customThemeSetting(result!.theme!.id));
    expect(result!.theme!.name).toBe("MobaXterm (2)");
    expect(next.fontFamily).toBeUndefined();
    expect(next.cursorStyle).toBeUndefined();
  });

  it("applies only the font and cursor when only that is opted in", () => {
    const result = applyMobaxtermGlobalAppearance(SETTINGS, GLOBAL, {
      theme: false,
      appearance: true,
    });
    expect(result!.theme).toBeNull();
    expect(result!.settings).toEqual({
      ...SETTINGS,
      fontFamily: '"Example Mono", monospace',
      fontSize: 16,
      cursorStyle: "bar",
      cursorBlink: false,
    });
  });

  it("returns null when the opted-in part has nothing to change", () => {
    expect(
      applyMobaxtermGlobalAppearance(SETTINGS, { fontSize: 14 }, { theme: true, appearance: true })
    ).toBeNull();
  });
});
