/**
 * Metadata about Shiki bundled language packages available for installation.
 *
 * Shiki ships ~235 TextMate grammars (the same set used by VS Code). This
 * module exposes that list so users can install additional syntax-highlighting
 * support beyond the four languages that termiHub loads by default.
 */

import { bundledLanguagesInfo } from "shiki";

export interface LanguagePackageInfo {
  id: string;
  name: string;
}

/**
 * Language IDs that termiHub always loads regardless of user settings.
 * These are shown as "Built-in" and cannot be uninstalled.
 */
export const BUILTIN_PACKAGE_IDS: ReadonlySet<string> = new Set([
  "cmake",
  "toml",
  "nginx",
  "nix",
  "lua",
]);

/**
 * All language packages available for installation, sorted by display name.
 * Built-in packages are included (they display as always-active).
 */
export const ALL_LANGUAGE_PACKAGES: LanguagePackageInfo[] = bundledLanguagesInfo
  .map(({ id, name }) => ({ id, name }))
  .sort((a, b) => a.name.localeCompare(b.name));
