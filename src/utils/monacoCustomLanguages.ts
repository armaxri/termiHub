/**
 * Custom Monaco Editor language definitions for languages not shipped with monaco-editor.
 *
 * Each language is registered with:
 *  - `monaco.languages.register()` — declares the language ID, aliases, and file associations
 *  - `monaco.languages.setMonarchTokensProvider()` — Monarch tokenizer for syntax highlighting
 *  - `monaco.languages.setLanguageConfiguration()` — bracket matching, comment toggling, etc.
 *
 * Call `registerCustomMonacoLanguages()` once at application startup (before any editor mounts).
 * The function is idempotent — safe to call multiple times.
 */

import * as monaco from "monaco-editor";

let registered = false;

/** Register all custom languages with Monaco. Idempotent. */
export function registerCustomMonacoLanguages(): void {
  if (registered) return;
  registered = true;

  registerCmake();
  registerToml();
  registerNginx();
  registerNix();
  registerProperties();
}

// ---------------------------------------------------------------------------
// CMake
// ---------------------------------------------------------------------------

function registerCmake(): void {
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

  monaco.languages.setMonarchTokensProvider("cmake", {
    // CMake keywords are case-insensitive in spec; lowercase is convention.
    keywords: [
      "if",
      "else",
      "elseif",
      "endif",
      "while",
      "endwhile",
      "foreach",
      "endforeach",
      "function",
      "endfunction",
      "macro",
      "endmacro",
      "return",
      "break",
      "continue",
      "and",
      "or",
      "not",
      "in",
      "matches",
    ],
    booleans: ["true", "false", "on", "off", "yes", "no"],
    ignoreCase: true,

    tokenizer: {
      root: [
        // Line comment
        [/#.*$/, "comment"],
        // Variable references: ${VAR}, $ENV{VAR}, $CACHE{VAR}
        [/\$(?:ENV|CACHE)?\{/, { token: "variable", next: "@variable" }],
        // Generator expressions: $<...>
        [/\$</, { token: "variable", next: "@genexpr" }],
        // Quoted string
        [/"/, { token: "string.quote", next: "@string" }],
        // Numbers
        [/\b\d+(?:\.\d+)?\b/, "number"],
        // Identifiers — keywords and command names
        [
          /[A-Za-z_][A-Za-z0-9_]*/,
          {
            cases: {
              "@keywords": "keyword",
              "@booleans": "constant.language",
              "@default": "identifier",
            },
          },
        ],
        // Brackets
        [/[()]/, "@brackets"],
        // Whitespace
        [/\s+/, "white"],
      ],

      variable: [
        [/[^}]+/, "variable.name"],
        [/\}/, { token: "variable", next: "@pop" }],
      ],

      genexpr: [
        [/[^>]+/, "variable.name"],
        [/>/, { token: "variable", next: "@pop" }],
      ],

      string: [
        [/[^"\\$]+/, "string"],
        [/\\./, "string.escape.invalid"],
        [/\$(?:ENV|CACHE)?\{/, { token: "variable", next: "@variable" }],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------

function registerToml(): void {
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

  monaco.languages.setMonarchTokensProvider("toml", {
    tokenizer: {
      root: [
        // Line comment
        [/#.*$/, "comment"],
        // Array of tables: [[header]]
        [/^\s*\[\[/, { token: "type.identifier", next: "@arrayHeader" }],
        // Table header: [header]
        [/^\s*\[/, { token: "type.identifier", next: "@tableHeader" }],
        // Key = value  (key part)
        [/^(\s*)([A-Za-z0-9_\-."]+)(\s*)(=)/, ["white", "variable.name", "white", "operator"]],
        // Boolean
        [/\b(?:true|false)\b/, "constant.language"],
        // Dates (ISO 8601 subset)
        [
          /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/,
          "number.date",
        ],
        // Numbers: hex/octal/binary
        [/0x[0-9a-fA-F_]+/, "number.hex"],
        [/0o[0-7_]+/, "number"],
        [/0b[01_]+/, "number"],
        // Numbers: float/int with underscores
        [/[+-]?(?:\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?|(?:inf|nan))/, "number"],
        // Multiline literal string '''
        [/'''/, { token: "string.quote", next: "@mlLiteralString" }],
        // Multiline basic string """
        [/"""/, { token: "string.quote", next: "@mlBasicString" }],
        // Literal string '...'
        [/'[^']*'/, "string"],
        // Basic string "..."
        [/"/, { token: "string.quote", next: "@basicString" }],
        // Inline table / array brackets
        [/[{}\[\],]/, "delimiter"],
        // Whitespace
        [/\s+/, "white"],
      ],

      tableHeader: [
        [/[^\]]+/, "type.identifier"],
        [/\]/, { token: "type.identifier", next: "@pop" }],
      ],

      arrayHeader: [
        [/[^\]]+/, "type.identifier"],
        [/\]\]/, { token: "type.identifier", next: "@pop" }],
      ],

      basicString: [
        [/[^"\\]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],

      mlBasicString: [
        [/[^"\\]+/, "string"],
        [/\\./, "string.escape"],
        [/"""/, { token: "string.quote", next: "@pop" }],
        [/"/, "string"],
      ],

      mlLiteralString: [
        [/[^']+/, "string"],
        [/'''/, { token: "string.quote", next: "@pop" }],
        [/'/, "string"],
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Nginx
// ---------------------------------------------------------------------------

function registerNginx(): void {
  monaco.languages.register({
    id: "nginx",
    aliases: ["Nginx", "nginx"],
    extensions: [],
    filenames: ["nginx.conf"],
  });

  monaco.languages.setLanguageConfiguration("nginx", {
    comments: { lineComment: "#" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
  });

  monaco.languages.setMonarchTokensProvider("nginx", {
    // Top-level block context keywords
    blocks: [
      "http",
      "server",
      "location",
      "upstream",
      "events",
      "stream",
      "geo",
      "map",
      "types",
      "split_clients",
      "if",
      "limit_except",
    ],

    tokenizer: {
      root: [
        // Line comment
        [/#.*$/, "comment"],
        // Variables: $var or ${var}
        [/\$\{[^}]*\}/, "variable"],
        [/\$[A-Za-z_][A-Za-z0-9_]*/, "variable"],
        // Strings
        [/"/, { token: "string.quote", next: "@doubleString" }],
        [/'/, { token: "string.quote", next: "@singleString" }],
        // Regex modifiers for location
        [/(?:~\*?|=|~|\^~)(?=\s)/, "keyword.operator"],
        // Numbers (with optional units: k, m, g, s, ms, d, w, M, y)
        [/\b\d+(?:[kmgKMG]|ms?|[sdwMy])?\b/, "number"],
        // Block and directive keywords
        [
          /[A-Za-z_][A-Za-z0-9_]*/,
          {
            cases: {
              "@blocks": "keyword",
              "@default": "identifier",
            },
          },
        ],
        // Punctuation
        [/[{};]/, "delimiter"],
        // Whitespace
        [/\s+/, "white"],
      ],

      doubleString: [
        [/[^"\\$]+/, "string"],
        [/\\./, "string.escape"],
        [/\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/, "variable"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],

      singleString: [
        [/[^'\\]+/, "string"],
        [/\\./, "string.escape"],
        [/'/, { token: "string.quote", next: "@pop" }],
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Nix
// ---------------------------------------------------------------------------

function registerNix(): void {
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

  monaco.languages.setMonarchTokensProvider("nix", {
    keywords: ["let", "in", "with", "rec", "inherit", "assert", "import", "if", "then", "else"],
    literals: ["true", "false", "null"],

    tokenizer: {
      root: [
        // Block comment
        [/\/\*/, { token: "comment", next: "@blockComment" }],
        // Line comment
        [/#.*$/, "comment"],
        // Multiline string ''...''
        [/''/, { token: "string.quote", next: "@indentString" }],
        // Regular string
        [/"/, { token: "string.quote", next: "@string" }],
        // Paths: ./foo, ../foo, /absolute
        [/(?:\.{1,2}\/|\/)[A-Za-z0-9_./-]*/, "string.path"],
        // Angle bracket paths: <nixpkgs>
        [/<[A-Za-z0-9_./+-]+>/, "string.path"],
        // URIs
        [/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"]+/, "string.link"],
        // Numbers
        [/\b\d+(?:\.\d+)?\b/, "number"],
        // Keywords and identifiers
        [
          /[A-Za-z_][A-Za-z0-9_'-]*/,
          {
            cases: {
              "@keywords": "keyword",
              "@literals": "constant.language",
              "@default": "identifier",
            },
          },
        ],
        // Operators
        [/(?:->|\/\/|==|!=|<=|>=|&&|\|\||!)/, "keyword.operator"],
        [/[+\-*/<>?@]/, "operator"],
        // Brackets
        [/[{}\[\]()]/, "@brackets"],
        // Attribute access and list separator
        [/[.;,:]/, "delimiter"],
        // Whitespace
        [/\s+/, "white"],
      ],

      blockComment: [
        [/[^/*]+/, "comment"],
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[/*]/, "comment"],
      ],

      string: [
        [/[^"\\$]+/, "string"],
        [/\\./, "string.escape"],
        [/\$\{/, { token: "variable", next: "@interpolation" }],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],

      indentString: [
        [/[^'$]+/, "string"],
        [/''(?:[\\$'])/, "string.escape"],
        [/\$\{/, { token: "variable", next: "@interpolation" }],
        [/''/, { token: "string.quote", next: "@pop" }],
        [/'/, "string"],
      ],

      interpolation: [
        // Nested interpolation needs full root rules — delegate via include
        { include: "@root" },
        [/\}/, { token: "variable", next: "@pop" }],
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Java .properties
// ---------------------------------------------------------------------------

function registerProperties(): void {
  monaco.languages.register({
    id: "properties",
    aliases: ["Properties", "properties"],
    extensions: [".properties"],
  });

  monaco.languages.setLanguageConfiguration("properties", {
    comments: { lineComment: "#" },
  });

  monaco.languages.setMonarchTokensProvider("properties", {
    tokenizer: {
      root: [
        // Comment lines starting with # or !
        [/^\s*[#!].*$/, "comment"],
        // Key: everything up to the separator (=, :, or whitespace)
        [/^([^=:\s\\]+)([ \t]*[=:][ \t]*)/, ["variable.name", "operator"]],
        // Key with whitespace separator (no = or :)
        [/^([^=:\s\\]+)([ \t]+)(?=[^\s])/, ["variable.name", "white"]],
        // Value: rest of the line (handles line continuation \)
        [/[^\\\n]+/, "string"],
        [/\\$/, "string.escape"],
        [/\\./, "string.escape"],
        // Whitespace
        [/\s+/, "white"],
      ],
    },
  });
}
