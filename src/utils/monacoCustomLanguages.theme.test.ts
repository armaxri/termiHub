import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ThemeDefinition } from "@/themes";
import { lightTheme } from "@/themes/light";
import { solarizedLightTheme } from "@/themes/solarized-light";

// #4599: the Monaco editor background must resolve from the active theme's
// `--terminal-bg` token instead of the dark-plus / light-plus VS Code palette.
// This suite drives the real registration + theme engine against local stubs
// for `monaco-editor`, `shiki` and `@shikijs/monaco`; the `shikiToMonaco` stub
// defines the two Shiki themes exactly like the real one (via the passed-in
// `monaco.editor.defineTheme`), so the capture-and-patch path runs for real.

interface ThemeData {
  base: string;
  inherit: boolean;
  colors: Record<string, string>;
  rules: { token: string; foreground?: string }[];
}

const rec = vi.hoisted(() => ({
  defined: [] as { name: string; data: ThemeData }[],
  setThemeCalls: [] as string[],
}));

/** Stand-ins for what shikiToMonaco derives from the Shiki dark/light palettes. */
const SHIKI_THEMES = vi.hoisted(
  () =>
    ({
      "dark-plus": {
        base: "vs-dark",
        inherit: false,
        colors: { "editor.background": "#1e1e1e", "editor.foreground": "#d4d4d4" },
        rules: [{ token: "keyword", foreground: "569cd6" }],
      },
      "light-plus": {
        base: "vs",
        inherit: false,
        colors: { "editor.background": "#ffffff", "editor.foreground": "#000000" },
        rules: [{ token: "keyword", foreground: "0000ff" }],
      },
    }) as Record<string, ThemeData>
);

vi.mock("monaco-editor", () => ({
  editor: {
    defineTheme: vi.fn((name: string, data: ThemeData) => {
      rec.defined.push({ name, data });
    }),
    setTheme: vi.fn((name: string) => {
      rec.setThemeCalls.push(name);
    }),
  },
  languages: {
    register: vi.fn(),
    setLanguageConfiguration: vi.fn(),
    getLanguages: vi.fn(() => []),
  },
}));

vi.mock("shiki", () => ({
  createHighlighter: vi.fn(async () => ({
    loadLanguage: vi.fn(async () => {}),
    getLoadedLanguages: vi.fn(() => []),
  })),
  bundledLanguages: { zig: vi.fn() },
  bundledLanguagesInfo: [],
}));

vi.mock("@shikijs/monaco", () => ({
  shikiToMonaco: vi.fn(
    (
      _hl: unknown,
      m: {
        editor: { defineTheme: (n: string, d: ThemeData) => void; setTheme: (n: string) => void };
      }
    ) => {
      for (const [name, data] of Object.entries(SHIKI_THEMES)) {
        m.editor.defineTheme(name, structuredClone(data));
      }
      m.editor.setTheme("dark-plus");
    }
  ),
}));

const BG_KEYS = ["editor.background", "editorGutter.background", "minimap.background"];

/** Fresh module graph so the init promise, captured themes and engine reset. */
async function freshModules() {
  vi.resetModules();
  rec.defined.length = 0;
  rec.setThemeCalls.length = 0;
  document.documentElement.removeAttribute("style");
  const themes = await import("@/themes");
  const customThemes = await import("@/themes/customThemes");
  const mod = await import("./monacoCustomLanguages");
  return { themes, customThemes, mod };
}

/** The most recent definition Monaco received for `name`. */
function lastDefinition(name: string): ThemeData {
  const hits = rec.defined.filter((d) => d.name === name);
  expect(hits.length).toBeGreaterThan(0);
  return hits[hits.length - 1].data;
}

/** The live `--terminal-bg` token on the document root. */
function terminalBgToken(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--terminal-bg").trim();
}

function expectBackgrounds(data: ThemeData, expected: string) {
  for (const key of BG_KEYS) expect(data.colors[key]).toBe(expected);
}

describe("Monaco theme background from theme tokens (#4599)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("resolves from --terminal-bg, the token the sibling terminal panes paint", async () => {
    const { mod } = await freshModules();
    expect(mod.MONACO_BACKGROUND_TOKEN).toBe("--terminal-bg");
  });

  it("patches dark-plus with the dark theme's token, keeping Shiki's token rules", async () => {
    const { themes, mod } = await freshModules();
    themes.applyTheme("dark");
    await mod.registerCustomMonacoLanguages();

    const token = terminalBgToken();
    expect(token).toBe(themes.darkTheme.colors.terminalBg);
    const data = lastDefinition("dark-plus");
    expectBackgrounds(data, token);
    expect(data.rules).toEqual(SHIKI_THEMES["dark-plus"].rules);
    expect(data.colors["editor.foreground"]).toBe("#d4d4d4");
    expect(data.base).toBe("vs-dark");
    // The patched theme is the one Monaco ends up on.
    expect(rec.setThemeCalls.at(-1)).toBe("dark-plus");
  });

  it("patches light-plus with the light theme's token", async () => {
    const { themes, mod } = await freshModules();
    themes.applyTheme("light");
    await mod.registerCustomMonacoLanguages();

    const token = terminalBgToken();
    expect(token).toBe(lightTheme.colors.terminalBg);
    expectBackgrounds(lastDefinition("light-plus"), token);
    expect(rec.setThemeCalls.at(-1)).toBe("light-plus");
  });

  it("patches with a custom theme's own token", async () => {
    const { themes, customThemes, mod } = await freshModules();
    const custom: ThemeDefinition = customThemes.createCustomTheme("solarized-dark", "Mine");
    custom.colors.terminalBg = "#123456";
    themes.applyTheme(`custom:${custom.id}`, [custom]);
    await mod.registerCustomMonacoLanguages();

    expect(terminalBgToken()).toBe("#123456");
    expectBackgrounds(lastDefinition("dark-plus"), "#123456");
  });

  it("re-patches on a live theme change and custom-theme preview", async () => {
    const { themes, customThemes, mod } = await freshModules();
    themes.applyTheme("dark");
    await mod.registerCustomMonacoLanguages();
    expectBackgrounds(lastDefinition("dark-plus"), themes.darkTheme.colors.terminalBg);

    // Switch to a light theme: the light editor theme picks up its token.
    themes.applyTheme("solarized-light");
    expectBackgrounds(lastDefinition("light-plus"), terminalBgToken());
    expect(terminalBgToken()).toBe(solarizedLightTheme.colors.terminalBg);

    // Live (unsaved) custom-theme edit from the theme editor.
    const custom = customThemes.createCustomTheme("dark", "Edited");
    custom.colors.terminalBg = "#0a0b0c";
    themes.previewTheme(custom);
    expectBackgrounds(lastDefinition("dark-plus"), "#0a0b0c");
  });

  it("keeps the patch after re-wiring for an added language package", async () => {
    const { themes, mod } = await freshModules();
    themes.applyTheme("dark");
    await mod.registerAdditionalLanguagePackages(["zig"]);

    expectBackgrounds(lastDefinition("dark-plus"), themes.darkTheme.colors.terminalBg);
  });

  it("leaves Shiki's background in place when the token is not a hex colour", async () => {
    const { themes, mod } = await freshModules();
    themes.applyTheme("dark");
    await mod.registerCustomMonacoLanguages();
    const before = rec.defined.length;

    document.documentElement.style.setProperty("--terminal-bg", "rgb(1, 2, 3)");
    mod.applyMonacoThemeBackground();
    expect(rec.defined.length).toBe(before);
  });
});
