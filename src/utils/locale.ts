/**
 * Locale validation and sanitisation.
 *
 * WebKitGTK (Linux) derives `navigator.language` from the process locale. On a
 * `C`/`POSIX` locale — the default on minimal/headless installs, many containers,
 * some SSH sessions, and the GitHub ubuntu CI runner — that value is `"C"`, which
 * is not a valid BCP-47 language tag. Passing it to an `Intl.*` constructor throws
 * `RangeError: invalid language tag: C`.
 *
 * The bundled `uplot` charting dependency builds
 * `new Intl.NumberFormat(navigator.language)` at *module-evaluation* time, so on a
 * `C` locale the whole JS bundle aborts during load — before React mounts — and
 * the app shows a blank window (#2646). macOS/Windows default to a valid tag
 * (`en-US`), which is why the crash only surfaced on Linux.
 *
 * Two complementary guards live here:
 *
 * - {@link ensureValidNavigatorLocale} rewrites `navigator.language` /
 *   `navigator.languages` to a valid tag before any consumer (notably `uplot`)
 *   reads them at import time. It must run first — see `src/main.tsx`.
 * - {@link resolveUiLocale} returns a guaranteed-valid tag for our own
 *   locale-sensitive formatting call sites, so none of them rely on the JS
 *   engine's (possibly `C`) default locale.
 *
 * Nothing here ever throws.
 */

/** Fallback locale used when no valid candidate is available. */
export const DEFAULT_UI_LOCALE = "en-US";

/**
 * POSIX locale sentinels (`C`, `POSIX`, optionally with a `.charset`/`@modifier`
 * suffix). `C` is caught by `Intl.getCanonicalLocales` because a 1-char primary
 * subtag is structurally invalid, but `POSIX` is *grammatically* a valid 5-char
 * language subtag (`getCanonicalLocales("POSIX") === ["posix"]`), so it must be
 * rejected explicitly — it is not a real language.
 */
const POSIX_SENTINEL = /^(c|posix)([.@]|$)/i;

/** Whether `tag` is a non-empty string usable by `Intl` as a BCP-47 tag. */
export function isValidLocale(tag: unknown): tag is string {
  if (typeof tag !== "string") return false;
  const trimmed = tag.trim();
  if (trimmed.length === 0) return false;
  if (POSIX_SENTINEL.test(trimmed)) return false;
  try {
    return Intl.getCanonicalLocales(trimmed).length > 0;
  } catch {
    return false;
  }
}

/**
 * Return the first valid BCP-47 tag among `candidates`, falling back to
 * {@link DEFAULT_UI_LOCALE} when none is usable. Candidates default to the
 * browser's preferred languages. Never throws.
 */
export function resolveUiLocale(
  candidates: ReadonlyArray<string | null | undefined> = browserLocaleCandidates()
): string {
  for (const candidate of candidates) {
    if (isValidLocale(candidate)) return candidate;
  }
  return DEFAULT_UI_LOCALE;
}

function browserLocaleCandidates(): ReadonlyArray<string | null | undefined> {
  if (typeof navigator === "undefined") return [];
  const languages = Array.isArray(navigator.languages) ? navigator.languages : [];
  return [...languages, navigator.language];
}

/**
 * Rewrite `navigator.language` / `navigator.languages` to a valid tag when the
 * environment reports an invalid one (e.g. `"C"`). Idempotent and defensive: a
 * value that is already valid is left untouched, and a non-configurable property
 * is left as-is (best effort).
 *
 * MUST run before any module that reads `navigator.language` at import time —
 * notably `uplot` (#2646). Imported for its side effect from `src/main.tsx`
 * ahead of the application module graph.
 */
export function ensureValidNavigatorLocale(): void {
  if (typeof navigator === "undefined") return;

  if (!isValidLocale(navigator.language)) {
    defineNavigatorGetter("language", resolveUiLocale());
  }

  const languages = Array.isArray(navigator.languages) ? navigator.languages : [];
  if (languages.length === 0 || !languages.every(isValidLocale)) {
    const valid = languages.filter(isValidLocale);
    const sanitised = valid.length > 0 ? valid : [resolveUiLocale()];
    defineNavigatorGetter("languages", Object.freeze([...sanitised]));
  }
}

function defineNavigatorGetter(prop: "language" | "languages", value: unknown): void {
  try {
    Object.defineProperty(navigator, prop, { configurable: true, get: () => value });
  } catch {
    // Some engines expose these as non-configurable; nothing more we can do.
  }
}
