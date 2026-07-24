import { describe, it, expect } from "vitest";
import { THEME_FILE_SCHEMA, serializeTheme, parseThemeFile, themeFileName } from "./themeIO";
import { COLOR_TOKEN_KEYS } from "./colorTokens";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import type { ThemeColors, ThemeDefinition } from "./types";

/** A full, valid custom theme derived from a base for round-trip tests. */
function fullTheme(overrides: Partial<ThemeDefinition> = {}): ThemeDefinition {
  return {
    id: "src-id",
    name: "My Custom Theme",
    colorScheme: "dark",
    baseTheme: "dark",
    colors: { ...darkTheme.colors },
    ...overrides,
  };
}

describe("serializeTheme", () => {
  it("writes the versioned on-disk shape, dropping the runtime id", () => {
    const json = serializeTheme(fullTheme());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.$schema).toBe(THEME_FILE_SCHEMA);
    expect(parsed.name).toBe("My Custom Theme");
    expect(parsed.baseTheme).toBe("dark");
    expect(parsed.colorScheme).toBe("dark");
    expect(parsed).not.toHaveProperty("id");
    expect((parsed.colors as ThemeColors).bgPrimary).toBe(darkTheme.colors.bgPrimary);
  });

  it("defaults a missing baseTheme to dark and pretty-prints with a trailing newline", () => {
    const json = serializeTheme(fullTheme({ baseTheme: undefined }));
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toContain("\n  ");
    expect((JSON.parse(json) as { baseTheme: string }).baseTheme).toBe("dark");
  });
});

describe("parseThemeFile — validation errors", () => {
  it("rejects non-JSON input", () => {
    expect(() => parseThemeFile("not json{")).toThrow(/valid JSON/);
  });

  it("rejects a JSON array or primitive", () => {
    expect(() => parseThemeFile("[]")).toThrow(/JSON object/);
    expect(() => parseThemeFile("42")).toThrow(/JSON object/);
  });

  it("rejects an unknown $schema version", () => {
    const json = JSON.stringify({ $schema: "termihub-theme-v99", name: "x" });
    expect(() => parseThemeFile(json)).toThrow(/Unsupported theme file version/);
  });

  it("rejects a missing or blank name", () => {
    expect(() => parseThemeFile(JSON.stringify({ baseTheme: "dark" }))).toThrow(/missing a name/);
    expect(() => parseThemeFile(JSON.stringify({ name: "   " }))).toThrow(/missing a name/);
  });
});

describe("parseThemeFile — success and tolerance", () => {
  it("round-trips a full exported theme with a fresh id", () => {
    const json = serializeTheme(fullTheme());
    const { theme, hadInvalidColors } = parseThemeFile(json);
    expect(hadInvalidColors).toBe(false);
    expect(theme.name).toBe("My Custom Theme");
    expect(theme.baseTheme).toBe("dark");
    expect(theme.id).not.toBe("src-id");
    expect(theme.id).toBeTruthy();
    for (const key of COLOR_TOKEN_KEYS) {
      expect(theme.colors[key]).toBe(darkTheme.colors[key]);
    }
  });

  it("accepts a partial file with no $schema, inheriting absent colors silently", () => {
    const json = JSON.stringify({
      name: "Minimal",
      baseTheme: "light",
      colors: { bgPrimary: "#010203", accentColor: "#7aa2f7" },
    });
    const { theme, hadInvalidColors } = parseThemeFile(json);
    expect(hadInvalidColors).toBe(false); // absent keys are the intended format, not a warning
    expect(theme.colorScheme).toBe("light"); // derived from the light base
    expect(theme.colors.bgPrimary).toBe("#010203");
    expect(theme.colors.accentColor).toBe("#7aa2f7");
    // An unspecified color falls back to the (light) base default.
    expect(theme.colors.textPrimary).toBe(lightTheme.colors.textPrimary);
  });

  it("flags present-but-invalid color values and falls back to the base", () => {
    const json = JSON.stringify({
      name: "Corrupt",
      baseTheme: "dark",
      colors: { bgPrimary: 123, textPrimary: "" },
    });
    const { theme, hadInvalidColors } = parseThemeFile(json);
    expect(hadInvalidColors).toBe(true);
    expect(theme.colors.bgPrimary).toBe(darkTheme.colors.bgPrimary);
    expect(theme.colors.textPrimary).toBe(darkTheme.colors.textPrimary);
  });

  it("defaults an unknown baseTheme to dark and drops unknown color keys", () => {
    const json = JSON.stringify({
      name: "Weird",
      baseTheme: "nope",
      colors: { notAToken: "#fff", bgPrimary: "#111111" },
    });
    const { theme } = parseThemeFile(json);
    expect(theme.baseTheme).toBe("dark");
    expect(theme.colors).not.toHaveProperty("notAToken");
    expect(theme.colors.bgPrimary).toBe("#111111");
  });
});

describe("themeFileName", () => {
  it("slugs a name into a .json file name", () => {
    expect(themeFileName("My Custom Theme")).toBe("my-custom-theme.json");
    expect(themeFileName("Ocean (2)")).toBe("ocean-2.json");
  });

  it("falls back to theme.json for an unsluggable name", () => {
    expect(themeFileName("   ")).toBe("theme.json");
    expect(themeFileName("***")).toBe("theme.json");
  });
});
