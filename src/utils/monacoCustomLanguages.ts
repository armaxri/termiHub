/**
 * Custom Monaco Editor language support for languages not shipped with monaco-editor.
 *
 * TextMate grammars are sourced from shiki's bundled `tm-grammars` package, which
 * re-distributes the same grammars VS Code uses. The grammars are wired into Monaco
 * via `@shikijs/monaco`, which implements Monaco's `ITokensProvider` interface on
 * top of the vscode-textmate engine.
 *
 * Built-in languages (always loaded):
 *  - cmake  (.cmake, CMakeLists.txt)
 *  - toml   (.toml)
 *  - nginx  (nginx.conf)
 *  - nix    (.nix)
 *
 * Additional language packages can be installed by the user via Settings → Editor →
 * Language Packages. Call `registerAdditionalLanguagePackages(ids)` after settings load.
 *
 * Custom TextMate grammars (user's own `.tmLanguage.json` files) can be registered via
 * `registerCustomGrammars(grammars)`.
 *
 * Call `registerCustomMonacoLanguages()` once at application startup. It returns a
 * Promise that resolves once Shiki has loaded all grammars and registered the token
 * providers with Monaco. Editors created before the Promise resolves will briefly
 * show uncoloured text and switch to highlighted once it completes.
 */

import * as monaco from "monaco-editor";
import { createHighlighter, bundledLanguages, bundledLanguagesInfo } from "shiki";
import type {
  HighlighterGeneric,
  BundledLanguage,
  BundledTheme,
  LanguageRegistration,
} from "shiki";
import { shikiToMonaco } from "@shikijs/monaco";
import type { CustomLanguageGrammar } from "@/types/connection";
import { getCurrentTheme } from "@/themes";
import { resetLanguageCache } from "./monacoLanguages";
import { BUILTIN_PACKAGE_IDS } from "./monacoLanguagePackages";
import { frontendLog } from "./frontendLog";

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
let shikiHighlighter: HighlighterGeneric<BundledLanguage, BundledTheme> | null = null;
/** IDs that have been registered with the Shiki highlighter. */
const loadedLanguageIds = new Set<string>();

/** Register custom Monaco languages backed by TextMate grammars via Shiki. Idempotent. */
export function registerCustomMonacoLanguages(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = doRegister();
  return initPromise;
}

async function doRegister(): Promise<void> {
  // Register language IDs and editor configurations synchronously so Monaco
  // knows about bracket matching, comment toggling, etc. before the tokeniser loads.
  registerBuiltinLanguageDefinitions();

  // Load TextMate grammars via Shiki.
  // Both dark-plus and light-plus are loaded so the editor can switch themes.
  // nginx depends on lua for embedded Lua blocks (ngx_lua) — include it explicitly.
  const langs: BundledLanguage[] = ["cmake", "toml", "nginx", "nix", "lua"];
  shikiHighlighter = await createHighlighter({
    themes: [MONACO_DARK_THEME, MONACO_LIGHT_THEME],
    langs,
  });

  for (const id of langs) loadedLanguageIds.add(id);

  // Wire Shiki's TextMate tokenisers into Monaco.
  shikiToMonaco(shikiHighlighter, monaco);

  // Set the initial Monaco theme to match the current app theme so Shiki's
  // colour map is initialised correctly before any editor is created.
  monaco.editor.setTheme(getMonacoTheme(getCurrentTheme().id));

  // Invalidate the language list cache so the new IDs appear in the picker.
  resetLanguageCache();
}

/**
 * Load additional language packages (user-installed) into the Shiki highlighter
 * and register their token providers with Monaco.
 *
 * Safe to call multiple times — only loads IDs not already present.
 * Waits for the initial `registerCustomMonacoLanguages()` call to complete first.
 */
export async function registerAdditionalLanguagePackages(langIds: string[]): Promise<void> {
  // Wait for the initial registration to finish.
  await registerCustomMonacoLanguages();

  if (!shikiHighlighter) return;

  const toLoad = langIds.filter((id) => !loadedLanguageIds.has(id) && id in bundledLanguages);
  if (toLoad.length === 0) return;

  // Ensure each language is registered with Monaco before loading its grammar.
  const infoByid = new Map(bundledLanguagesInfo.map((l) => [l.id, l]));
  for (const id of toLoad) {
    if (!monaco.languages.getLanguages().some((l) => l.id === id)) {
      const info = infoByid.get(id);
      monaco.languages.register({
        id,
        aliases: info ? [info.name, ...(info.aliases ?? [])] : [id],
      });
    }
  }

  // Load grammars into the existing highlighter.
  await shikiHighlighter.loadLanguage(
    ...toLoad.map((id) => bundledLanguages[id as BundledLanguage])
  );

  for (const id of toLoad) loadedLanguageIds.add(id);

  // Re-wire all token providers (including newly added languages).
  shikiToMonaco(shikiHighlighter, monaco);

  resetLanguageCache();
}

/** IDs of all language packages currently loaded (built-ins + user-installed). */
export function getLoadedLanguagePackageIds(): ReadonlySet<string> {
  return loadedLanguageIds;
}

/**
 * Register user-imported custom TextMate grammar definitions with Monaco and Shiki.
 *
 * Each `CustomLanguageGrammar` stores the full `.tmLanguage.json` content so no
 * file path is needed at runtime. Safe to call multiple times — only grammars whose
 * `id` is not already loaded will be processed.
 *
 * Waits for the initial `registerCustomMonacoLanguages()` call to complete first.
 */
export async function registerCustomGrammars(grammars: CustomLanguageGrammar[]): Promise<void> {
  await registerCustomMonacoLanguages();

  if (!shikiHighlighter) return;

  const toLoad = grammars.filter((g) => !loadedLanguageIds.has(g.id));
  if (toLoad.length === 0) return;

  for (const { id, name, grammar } of toLoad) {
    if (!monaco.languages.getLanguages().some((l) => l.id === id)) {
      // Extract file extensions from the TextMate grammar's `fileTypes` field so
      // Monaco can auto-detect the language from file names on open.
      const rawFileTypes = Array.isArray(grammar.fileTypes) ? (grammar.fileTypes as string[]) : [];
      const extensions = rawFileTypes.map((t) => (t.startsWith(".") ? t : `.${t}`));
      monaco.languages.register({
        id,
        aliases: [name, id],
        extensions: extensions.length > 0 ? extensions : undefined,
      });
      if (extensions.length > 0) {
        frontendLog(
          "custom_grammars",
          `Registered Monaco language "${id}" with extensions: ${extensions.join(", ")}`
        );
      }
    }

    // Build a LanguageRegistration from the stored grammar JSON.
    // The grammar must have at least a `scopeName` field to be valid.
    // Ensure `id` is included in `aliases` so that shikiToMonaco's
    // getLoadedLanguages() returns the Monaco language ID (Shiki stores
    // grammars by `name`, not `id`, so without this alias the token provider
    // would never be wired).
    const grammarAliases = Array.isArray(grammar.aliases) ? (grammar.aliases as string[]) : [];
    const registration: LanguageRegistration = {
      ...(grammar as Omit<LanguageRegistration, "id" | "name">),
      id,
      name,
      aliases: [...new Set([id, ...grammarAliases])],
    };
    try {
      frontendLog("custom_grammars", `Loading grammar for language "${id}" (${name})`);
      await shikiHighlighter.loadLanguage(registration);
      loadedLanguageIds.add(id);
      frontendLog("custom_grammars", `Grammar loaded successfully for "${id}"`);
    } catch (err) {
      frontendLog(
        "custom_grammars",
        `Failed to load grammar for "${id}": ${err instanceof Error ? err.message : String(err)}`
      );
      throw new Error(
        `Failed to load grammar for "${name}" (${id}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  shikiToMonaco(shikiHighlighter, monaco);
  frontendLog("custom_grammars", `Token providers registered for ${toLoad.length} grammar(s)`);
  resetLanguageCache();
}

function registerBuiltinLanguageDefinitions(): void {
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

  // Exclude built-ins from the BUILTIN_PACKAGE_IDS check used elsewhere.
  for (const id of BUILTIN_PACKAGE_IDS) {
    loadedLanguageIds.add(id);
  }
}
