/**
 * Utilities for querying the Monaco Editor language registry.
 *
 * Monaco registers all built-in languages at import time, so
 * `getAvailableLanguages()` is safe to call before any editor is mounted.
 */

import * as monaco from "monaco-editor";
import { LanguageInfo } from "@/types/terminal";

/** Cached sorted list (populated on first call). */
let cached: LanguageInfo[] | null = null;

/**
 * Invalidate the language cache so the next call to `getAvailableLanguages()`
 * re-queries Monaco. Call this after registering custom languages.
 */
export function resetLanguageCache(): void {
  cached = null;
}

/**
 * Return all language IDs registered with Monaco, sorted by display name.
 * Results are memoised — safe to call on every render.
 */
export function getAvailableLanguages(): LanguageInfo[] {
  if (!cached) {
    cached = monaco.languages
      .getLanguages()
      .map((lang) => ({ id: lang.id, name: lang.aliases?.[0] ?? lang.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return cached;
}
