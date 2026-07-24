import { describe, it, expect } from "vitest";
import {
  createCustomTheme,
  customThemeId,
  customThemeSetting,
  dedupeThemeName,
  findCustomTheme,
  generateThemeId,
  isCustomThemeSetting,
  resolveBaseTheme,
  resolveCustomTheme,
} from "./customThemes";
import { COLOR_TOKEN_KEYS } from "./colorTokens";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import type { ThemeDefinition } from "./types";

describe("custom theme setting encoding", () => {
  it("round-trips an id through custom:<id>", () => {
    const setting = customThemeSetting("abc-123");
    expect(setting).toBe("custom:abc-123");
    expect(isCustomThemeSetting(setting)).toBe(true);
    expect(customThemeId(setting)).toBe("abc-123");
  });

  it("recognizes non-custom settings", () => {
    expect(isCustomThemeSetting("dark")).toBe(false);
    expect(isCustomThemeSetting("system")).toBe(false);
    expect(isCustomThemeSetting(undefined)).toBe(false);
    expect(customThemeId("light")).toBeNull();
  });

  it("returns null for an empty custom id", () => {
    expect(customThemeId("custom:")).toBeNull();
  });
});

describe("generateThemeId", () => {
  it("produces unique non-empty ids", () => {
    const a = generateThemeId();
    const b = generateThemeId();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe("resolveBaseTheme", () => {
  it("resolves known base ids", () => {
    expect(resolveBaseTheme("light").id).toBe("light");
    expect(resolveBaseTheme("solarized-dark").id).toBe("solarized-dark");
  });

  it("defaults unknown or missing bases to dark", () => {
    expect(resolveBaseTheme(undefined).id).toBe("dark");
    expect(resolveBaseTheme("nope").id).toBe("dark");
  });
});

describe("createCustomTheme", () => {
  it("copies all colors from the base and records provenance", () => {
    const theme = createCustomTheme("light", "My Theme");
    expect(theme.name).toBe("My Theme");
    expect(theme.baseTheme).toBe("light");
    expect(theme.colorScheme).toBe("light");
    expect(theme.id).toBeTruthy();
    for (const key of COLOR_TOKEN_KEYS) {
      expect(theme.colors[key]).toBe(lightTheme.colors[key]);
    }
    // Mutating the copy must not affect the built-in theme.
    theme.colors.bgPrimary = "#123456";
    expect(lightTheme.colors.bgPrimary).not.toBe("#123456");
  });
});

describe("dedupeThemeName", () => {
  const existing: ThemeDefinition[] = [
    { ...darkTheme, id: "a", name: "Ocean" },
    { ...darkTheme, id: "b", name: "Ocean (2)" },
  ];

  it("keeps a unique name unchanged", () => {
    expect(dedupeThemeName("Sunset", existing)).toBe("Sunset");
  });

  it("appends the next free numeric suffix on collision", () => {
    expect(dedupeThemeName("Ocean", existing)).toBe("Ocean (3)");
  });
});

describe("findCustomTheme", () => {
  const themes: ThemeDefinition[] = [{ ...darkTheme, id: "x", name: "X" }];
  it("finds by id and returns undefined when absent", () => {
    expect(findCustomTheme(themes, "x")?.name).toBe("X");
    expect(findCustomTheme(themes, "y")).toBeUndefined();
    expect(findCustomTheme(undefined, "x")).toBeUndefined();
  });
});

describe("resolveCustomTheme", () => {
  it("fills missing colors from the base theme", () => {
    const partial: ThemeDefinition = {
      id: "p",
      name: "Partial",
      colorScheme: "dark",
      baseTheme: "dark",
      // Only one color specified; the rest must fall back to dark.
      colors: { bgPrimary: "#010203" } as ThemeDefinition["colors"],
    };
    const resolved = resolveCustomTheme(partial);
    expect(resolved.colors.bgPrimary).toBe("#010203");
    expect(resolved.colors.textPrimary).toBe(darkTheme.colors.textPrimary);
    // Every token key is present after resolution.
    for (const key of COLOR_TOKEN_KEYS) {
      expect(resolved.colors[key]).toBeTruthy();
    }
  });

  it("treats blank color values as missing", () => {
    const theme: ThemeDefinition = {
      ...createCustomTheme("dark", "Blank"),
      colors: { ...darkTheme.colors, accentColor: "   " },
    };
    const resolved = resolveCustomTheme(theme);
    expect(resolved.colors.accentColor).toBe(darkTheme.colors.accentColor);
  });

  it("survives a full serialize/deserialize round-trip", () => {
    const created = createCustomTheme("light", "Trip");
    created.colors.accentColor = "#abcdef";
    const restored = JSON.parse(JSON.stringify(created)) as ThemeDefinition;
    const resolved = resolveCustomTheme(restored);
    expect(resolved.colors.accentColor).toBe("#abcdef");
    expect(resolved.colors.bgPrimary).toBe(lightTheme.colors.bgPrimary);
    expect(resolved.colorScheme).toBe("light");
  });
});
