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
import { resetLanguageCache } from "./monacoLanguages";

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
  // nginx depends on lua for embedded Lua blocks (ngx_lua) — include it explicitly.
  const highlighter = await createHighlighter({
    themes: ["vs-dark"],
    langs: ["cmake", "toml", "nginx", "nix", "lua"],
  });

  // Wire Shiki's TextMate tokenisers into Monaco.
  shikiToMonaco(highlighter, monaco);

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
