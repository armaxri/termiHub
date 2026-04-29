import { describe, it, expect } from "vitest";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import { solarizedDarkTheme } from "./solarized-dark";
import { solarizedLightTheme } from "./solarized-light";
import { ThemeColors } from "./types";

/** All keys that a complete ThemeColors object must have. */
const REQUIRED_KEYS: (keyof ThemeColors)[] = [
  "bgPrimary",
  "bgSecondary",
  "bgTertiary",
  "bgHover",
  "bgActive",
  "bgInput",
  "bgDropdown",
  "activityBarBg",
  "activityBarActive",
  "activityBarInactive",
  "activityBarIndicator",
  "sidebarBg",
  "sidebarHeaderBg",
  "tabBg",
  "tabActiveBg",
  "tabBorder",
  "textPrimary",
  "textSecondary",
  "textDisabled",
  "textAccent",
  "textLink",
  "borderPrimary",
  "borderSecondary",
  "accentColor",
  "accentHover",
  "focusBorder",
  "colorSuccess",
  "colorWarning",
  "colorError",
  "colorInfo",
  "stateConnected",
  "stateConnecting",
  "stateDisconnected",
  "terminalBg",
  "terminalFg",
  "terminalCursor",
  "terminalSelection",
  "ansiBlack",
  "ansiRed",
  "ansiGreen",
  "ansiYellow",
  "ansiBlue",
  "ansiMagenta",
  "ansiCyan",
  "ansiWhite",
  "ansiBrightBlack",
  "ansiBrightRed",
  "ansiBrightGreen",
  "ansiBrightYellow",
  "ansiBrightBlue",
  "ansiBrightMagenta",
  "ansiBrightCyan",
  "ansiBrightWhite",
  "scrollbarThumb",
  "scrollbarThumbHover",
];

describe("darkTheme", () => {
  it("has all required color keys", () => {
    for (const key of REQUIRED_KEYS) {
      expect(darkTheme.colors).toHaveProperty(key);
      expect(darkTheme.colors[key]).toBeTruthy();
    }
  });

  it("has no extra keys beyond ThemeColors", () => {
    const actualKeys = Object.keys(darkTheme.colors);
    expect(actualKeys.sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  it("has correct id and name", () => {
    expect(darkTheme.id).toBe("dark");
    expect(darkTheme.name).toBe("Dark");
  });
});

describe("lightTheme", () => {
  it("has all required color keys", () => {
    for (const key of REQUIRED_KEYS) {
      expect(lightTheme.colors).toHaveProperty(key);
      expect(lightTheme.colors[key]).toBeTruthy();
    }
  });

  it("has no extra keys beyond ThemeColors", () => {
    const actualKeys = Object.keys(lightTheme.colors);
    expect(actualKeys.sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  it("has correct id and name", () => {
    expect(lightTheme.id).toBe("light");
    expect(lightTheme.name).toBe("Light");
  });

  it("differs from dark theme in key areas", () => {
    expect(lightTheme.colors.bgPrimary).not.toBe(darkTheme.colors.bgPrimary);
    expect(lightTheme.colors.textPrimary).not.toBe(darkTheme.colors.textPrimary);
    expect(lightTheme.colors.terminalBg).not.toBe(darkTheme.colors.terminalBg);
  });
});

describe("solarizedDarkTheme", () => {
  it("has all required color keys", () => {
    for (const key of REQUIRED_KEYS) {
      expect(solarizedDarkTheme.colors).toHaveProperty(key);
      expect(solarizedDarkTheme.colors[key]).toBeTruthy();
    }
  });

  it("has no extra keys beyond ThemeColors", () => {
    const actualKeys = Object.keys(solarizedDarkTheme.colors);
    expect(actualKeys.sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  it("has correct id and name", () => {
    expect(solarizedDarkTheme.id).toBe("solarized-dark");
    expect(solarizedDarkTheme.name).toBe("Solarized Dark");
  });

  it("uses Solarized Dark base background", () => {
    expect(solarizedDarkTheme.colors.terminalBg).toBe("#002b36");
    expect(solarizedDarkTheme.colors.terminalFg).toBe("#839496");
  });
});

describe("solarizedLightTheme", () => {
  it("has all required color keys", () => {
    for (const key of REQUIRED_KEYS) {
      expect(solarizedLightTheme.colors).toHaveProperty(key);
      expect(solarizedLightTheme.colors[key]).toBeTruthy();
    }
  });

  it("has no extra keys beyond ThemeColors", () => {
    const actualKeys = Object.keys(solarizedLightTheme.colors);
    expect(actualKeys.sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  it("has correct id and name", () => {
    expect(solarizedLightTheme.id).toBe("solarized-light");
    expect(solarizedLightTheme.name).toBe("Solarized Light");
  });

  it("uses Solarized Light base background", () => {
    expect(solarizedLightTheme.colors.terminalBg).toBe("#fdf6e3");
    expect(solarizedLightTheme.colors.terminalFg).toBe("#657b83");
  });

  it("differs from solarized dark in key areas", () => {
    expect(solarizedLightTheme.colors.bgPrimary).not.toBe(solarizedDarkTheme.colors.bgPrimary);
    expect(solarizedLightTheme.colors.textPrimary).not.toBe(solarizedDarkTheme.colors.textPrimary);
    expect(solarizedLightTheme.colors.terminalBg).not.toBe(solarizedDarkTheme.colors.terminalBg);
  });
});
