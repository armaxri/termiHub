/**
 * Custom Monaco Editor language support for languages not shipped with monaco-editor.
 *
 * TextMate grammars are sourced from shiki's bundled `tm-grammars` package, which
 * re-distributes the same grammars VS Code uses. The grammars are wired into Monaco
 * via `@shikijs/monaco`, which implements Monaco's `ITokensProvider` interface on
 * top of the vscode-textmate engine.
 *
 * Languages added here:
 *  - cmake  (.cmake, CMakeLists.txt)
 *  - toml   (.toml)
 *  - nginx  (nginx.conf)
 *  - nix    (.nix)
 *
 * Call `registerCustomMonacoLanguages()` once at application startup. It returns a
 * Promise that resolves once Shiki has loaded all grammars and registered the token
 * providers with Monaco. Editors created before the Promise resolves will briefly
 * show uncoloured text and switch to highlighted once it completes.
 */

import * as monaco from "monaco-editor";
import { createHighlighter } from "shiki";
import { shikiToMonaco } from "@shikijs/monaco";
import { getCurrentTheme } from "@/themes";
import { resetLanguageCache } from "./monacoLanguages";

/** Shiki theme used for Monaco's dark mode (matches Monaco's built-in vs-dark palette). */
export const MONACO_DARK_THEME = "dark-plus";
/** Shiki theme used for Monaco's light mode (matches Monaco's built-in vs palette). */
export const MONACO_LIGHT_THEME = "light-plus";

/**
 * Return the Monaco/Shiki theme name that corresponds to the given termiHub
 * theme ID (`"dark"` or `"light"`). Falls back to the dark theme for any
 * unknown value.
 */
export function getMonacoTheme(appThemeId: string): string {
  return appThemeId === "light" ? MONACO_LIGHT_THEME : MONACO_DARK_THEME;
}

let initPromise: Promise<void> | null = null;

/** Register custom Monaco languages backed by TextMate grammars via Shiki. Idempotent. */
export function registerCustomMonacoLanguages(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = doRegister();
  return initPromise;
}

async function doRegister(): Promise<void> {
  // Register language IDs and editor configurations synchronously so Monaco
  // knows about bracket matching, comment toggling, etc. before the tokeniser loads.
  registerLanguageDefinitions();

  // Load TextMate grammars via Shiki.
  // Both dark-plus and light-plus are loaded so the editor can switch themes.
  // nginx depends on lua for embedded Lua blocks (ngx_lua) — include it explicitly.
  const highlighter = await createHighlighter({
    themes: [MONACO_DARK_THEME, MONACO_LIGHT_THEME],
    langs: ["cmake", "toml", "nginx", "nix", "lua"],
  });

  // Wire Shiki's TextMate tokenisers into Monaco.
  shikiToMonaco(highlighter, monaco);

  // Set the initial Monaco theme to match the current app theme so Shiki's
  // colour map is initialised correctly before any editor is created.
  monaco.editor.setTheme(getMonacoTheme(getCurrentTheme().id));

  // Invalidate the language list cache so the new IDs appear in the picker.
  resetLanguageCache();
}

function registerLanguageDefinitions(): void {
  monaco.languages.register({
    id: "cmake",
    aliases: ["CMake", "cmake"],
    extensions: [".cmake"],
    filenames: ["CMakeLists.txt"],
  });
  monaco.languages.setLanguageConfiguration("cmake", {
    comments: { lineComment: "#" },
    brackets: [
      ["(", ")"],
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
  });

  monaco.languages.register({
    id: "toml",
    aliases: ["TOML", "toml"],
    extensions: [".toml"],
  });
  monaco.languages.setLanguageConfiguration("toml", {
    comments: { lineComment: "#" },
    brackets: [
      ["[", "]"],
      ["{", "}"],
    ],
    autoClosingPairs: [
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
  });

  monaco.languages.register({
    id: "nginx",
    aliases: ["Nginx", "nginx"],
    extensions: [],
    filenames: ["nginx.conf"],
  });
  monaco.languages.setLanguageConfiguration("nginx", {
    comments: { lineComment: "#" },
    brackets: [["{", "}"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
  });

  monaco.languages.register({
    id: "nix",
    aliases: ["Nix", "nix"],
    extensions: [".nix"],
  });
  monaco.languages.setLanguageConfiguration("nix", {
    comments: {
      lineComment: "#",
      blockComment: ["/*", "*/"],
    },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
  });
}
