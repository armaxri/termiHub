/**
 * Built-in and user-configurable filename-to-language mappings for the file editor.
 *
 * Monaco Editor auto-detects language from file extensions via the `path` prop, but
 * does not handle special filenames (e.g. Jenkinsfile, Dockerfile) or dotfiles
 * (e.g. .gitignore). These mappings cover the most common cases.
 *
 * User-defined overrides in AppSettings.fileLanguageMappings take precedence over
 * the built-in defaults.
 */

/** Exact filename → Monaco language ID (no extension, or a specific full name). */
export const BUILT_IN_FILENAME_MAPPINGS: Record<string, string> = {
  // Container / build
  Dockerfile: "dockerfile",
  Containerfile: "dockerfile",
  Makefile: "makefile",
  GNUmakefile: "makefile",
  Kbuild: "makefile",
  "CMakeLists.txt": "cmake",

  // Web server config
  "nginx.conf": "nginx",

  // CI / deployment
  Jenkinsfile: "java", // Groovy DSL — Groovy not available in Monaco; java is closest
  Vagrantfile: "ruby",
  Procfile: "yaml",

  // Ruby ecosystem
  Gemfile: "ruby",
  "Gemfile.lock": "ruby",
  Rakefile: "ruby",
  Podfile: "ruby",
  Fastfile: "ruby",
  Brewfile: "ruby",
  Guardfile: "ruby",
  Capfile: "ruby",

  // Dotfiles — git
  ".gitignore": "plaintext",
  ".gitattributes": "ini",
  ".gitmodules": "ini",

  // Dotfiles — editor / project
  ".editorconfig": "ini",
  ".vimrc": "plaintext",
  ".clang-format": "yaml",
  ".clang-tidy": "yaml",

  // Dotfiles — env / secrets
  ".env": "shell",
  ".env.local": "shell",
  ".env.development": "shell",
  ".env.production": "shell",
  ".env.test": "shell",
  ".env.example": "shell",

  // Dotfiles — JS/TS tooling
  ".eslintrc": "json",
  ".prettierrc": "json",
  ".babelrc": "json",
  ".npmrc": "ini",
  ".yarnrc": "yaml",
  ".nvmrc": "plaintext",
  ".node-version": "plaintext",

  // Dotfiles — Python tooling
  ".python-version": "plaintext",
  ".flake8": "ini",
  ".pylintrc": "ini",
  ".coveragerc": "ini",
  ".mypy.ini": "ini",
  ".sqlfluff": "ini",

  // Dotfiles — shell
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".zshrc": "shell",
  ".profile": "shell",

  // Dotfiles — misc
  ".ruby-version": "plaintext",
  ".tool-versions": "plaintext",
  ".dockerignore": "plaintext",
  ".htaccess": "ini",
};

/** File extension → Monaco language ID (supplements Monaco's built-in detection). */
export const BUILT_IN_EXTENSION_MAPPINGS: Record<string, string> = {
  // Config / ini-like
  ".conf": "ini",
  ".cfg": "ini",
  ".strings": "ini",
  ".xcconfig": "ini",

  // Shell variants
  ".fish": "shell",
  ".zsh": "shell",
  ".bash": "shell",
  ".ksh": "shell",

  // XML-based
  ".plist": "xml",

  // Ruby
  ".podspec": "ruby",
  ".gemspec": "ruby",

  // Build systems
  ".mk": "makefile",
  ".cmake": "cmake",

  // HashiCorp
  ".tfvars": "hcl",
  ".nomad": "hcl",

  // Shader languages (no dedicated Monaco language; cpp is closest)
  ".glsl": "cpp",
  ".hlsl": "cpp",
  ".vert": "cpp",
  ".frag": "cpp",

  // Data / config
  ".toml": "toml",
  ".properties": "ini",

  // Data / misc
  ".lock": "yaml",
  ".ipynb": "json",
  ".nix": "nix",
  ".http": "plaintext",
  ".rest": "plaintext",
};

/**
 * Case-insensitive lookup map derived from BUILT_IN_FILENAME_MAPPINGS.
 * Allows matching e.g. "cmakelists.txt" → "cmake" regardless of case.
 */
const BUILT_IN_FILENAME_MAPPINGS_LOWER: Record<string, string> = Object.fromEntries(
  Object.entries(BUILT_IN_FILENAME_MAPPINGS).map(([k, v]) => [k.toLowerCase(), v])
);

/**
 * Extract the file extension from a filename (including the leading dot).
 * Returns `undefined` for files with no extension or dotfiles with no further extension.
 *
 * @example
 * fileExtension("foo.ts")     // ".ts"
 * fileExtension(".gitignore") // undefined
 * fileExtension("Makefile")   // undefined
 */
export function fileExtension(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf(".");
  // dot === 0 means a plain dotfile like ".gitignore" — no extension
  if (dot <= 0) return undefined;
  return fileName.slice(dot);
}

/**
 * Resolve the Monaco language ID for a given filename.
 *
 * Resolution order:
 * 1. User overrides — exact filename match
 * 2. User overrides — extension match (e.g. `".conf"`)
 * 3. Built-in filename mappings
 * 4. Built-in extension mappings
 * 5. `undefined` — Monaco's own path-based detection handles it
 *
 * @param fileName - The bare filename (not a full path).
 * @param userOverrides - Per-user mapping from AppSettings.fileLanguageMappings.
 * @returns A Monaco language ID, or `undefined` if Monaco should detect it automatically.
 */
export function resolveLanguage(
  fileName: string,
  userOverrides: Record<string, string> = {}
): string | undefined {
  // 1. User override — exact filename
  if (userOverrides[fileName]) return userOverrides[fileName];

  // 2. User override — extension
  const ext = fileExtension(fileName);
  if (ext && userOverrides[ext]) return userOverrides[ext];

  // 3. Built-in filename match (case-insensitive)
  const fileNameLower = fileName.toLowerCase();
  if (BUILT_IN_FILENAME_MAPPINGS_LOWER[fileNameLower])
    return BUILT_IN_FILENAME_MAPPINGS_LOWER[fileNameLower];

  // 4. Built-in extension match
  if (ext && BUILT_IN_EXTENSION_MAPPINGS[ext]) return BUILT_IN_EXTENSION_MAPPINGS[ext];

  return undefined;
}
