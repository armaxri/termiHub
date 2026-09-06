import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_UI_LOCALE,
  ensureValidNavigatorLocale,
  isValidLocale,
  resolveUiLocale,
} from "./locale";

/**
 * Regression tests for #2646: on a `C`/`POSIX` locale (the GitHub ubuntu runner
 * and real minimal/headless Linux installs) `navigator.language` resolves to
 * `"C"`, which is not a valid BCP-47 tag. Feeding it to an `Intl.*` constructor
 * throws `RangeError: invalid language tag: C` and crashed the app at startup
 * (the bundled `uplot` builds `new Intl.NumberFormat(navigator.language)` at
 * module scope). These tests pin the validation + sanitisation behaviour.
 */

/** Reproduces the exact call `uplot` makes at module evaluation time. */
function uplotStartupPattern(tag: string): Intl.NumberFormat {
  return new Intl.NumberFormat(tag);
}

describe("isValidLocale", () => {
  it("accepts well-formed BCP-47 tags", () => {
    expect(isValidLocale("en-US")).toBe(true);
    expect(isValidLocale("de-DE")).toBe(true);
    expect(isValidLocale("fr")).toBe(true);
    expect(isValidLocale("zh-Hant-TW")).toBe(true);
  });

  it("rejects the POSIX locale sentinels", () => {
    expect(isValidLocale("C")).toBe(false);
    expect(isValidLocale("c")).toBe(false);
    expect(isValidLocale("POSIX")).toBe(false);
    expect(isValidLocale("posix")).toBe(false);
    expect(isValidLocale("C.UTF-8")).toBe(false);
    expect(isValidLocale("POSIX.UTF-8")).toBe(false);
  });

  it("rejects empty, whitespace, and non-string input", () => {
    expect(isValidLocale("")).toBe(false);
    expect(isValidLocale("   ")).toBe(false);
    expect(isValidLocale(undefined)).toBe(false);
    expect(isValidLocale(null)).toBe(false);
    expect(isValidLocale(42)).toBe(false);
    expect(isValidLocale({})).toBe(false);
  });

  it("rejects structurally invalid tags without throwing", () => {
    expect(isValidLocale("this is not a tag")).toBe(false);
    expect(() => isValidLocale("!!")).not.toThrow();
  });
});

describe("resolveUiLocale", () => {
  it("maps the C/POSIX sentinels to the default", () => {
    expect(resolveUiLocale(["C"])).toBe(DEFAULT_UI_LOCALE);
    expect(resolveUiLocale(["POSIX"])).toBe(DEFAULT_UI_LOCALE);
    expect(resolveUiLocale(["C.UTF-8"])).toBe(DEFAULT_UI_LOCALE);
  });

  it("maps empty / missing candidates to the default", () => {
    expect(resolveUiLocale([])).toBe(DEFAULT_UI_LOCALE);
    expect(resolveUiLocale([""])).toBe(DEFAULT_UI_LOCALE);
    expect(resolveUiLocale([undefined])).toBe(DEFAULT_UI_LOCALE);
    expect(resolveUiLocale([null, undefined, ""])).toBe(DEFAULT_UI_LOCALE);
  });

  it("returns a valid tag unchanged", () => {
    expect(resolveUiLocale(["de-DE"])).toBe("de-DE");
    expect(resolveUiLocale(["fr"])).toBe("fr");
  });

  it("returns the first valid candidate, skipping invalid ones", () => {
    expect(resolveUiLocale(["C", "de-DE"])).toBe("de-DE");
    expect(resolveUiLocale(["C", "POSIX", "fr"])).toBe("fr");
    expect(resolveUiLocale([undefined, "", "en-GB"])).toBe("en-GB");
  });

  it("never throws and always yields an Intl-usable tag", () => {
    const cases: ReadonlyArray<ReadonlyArray<string | null | undefined>> = [
      ["C"],
      ["POSIX"],
      [""],
      ["not a tag"],
      [],
    ];
    for (const candidates of cases) {
      const resolved = resolveUiLocale(candidates);
      expect(() => uplotStartupPattern(resolved)).not.toThrow();
    }
  });
});

describe("ensureValidNavigatorLocale", () => {
  afterEach(() => {
    // Drop any own property we (or the test) defined, reverting to jsdom's
    // prototype getter.
    delete (navigator as unknown as { language?: unknown }).language;
    delete (navigator as unknown as { languages?: unknown }).languages;
  });

  function stubNavigatorLanguage(language: string, languages: readonly string[]): void {
    Object.defineProperty(navigator, "language", { configurable: true, get: () => language });
    Object.defineProperty(navigator, "languages", { configurable: true, get: () => languages });
  }

  it("replaces an invalid navigator.language so the uplot pattern no longer throws", () => {
    stubNavigatorLanguage("C", ["C"]);
    // Precondition: the raw environment value reproduces the crash.
    expect(() => uplotStartupPattern(navigator.language)).toThrow();

    ensureValidNavigatorLocale();

    expect(isValidLocale(navigator.language)).toBe(true);
    expect(navigator.language).toBe(DEFAULT_UI_LOCALE);
    expect(() => uplotStartupPattern(navigator.language)).not.toThrow();
  });

  it("prefers a valid entry from navigator.languages over the default", () => {
    stubNavigatorLanguage("C", ["C", "de-DE"]);

    ensureValidNavigatorLocale();

    expect(navigator.language).toBe("de-DE");
    expect(isValidLocale(navigator.language)).toBe(true);
  });

  it("leaves a valid navigator.language untouched", () => {
    stubNavigatorLanguage("en-GB", ["en-GB"]);

    ensureValidNavigatorLocale();

    expect(navigator.language).toBe("en-GB");
  });

  it("never throws", () => {
    stubNavigatorLanguage("C", ["C"]);
    expect(() => ensureValidNavigatorLocale()).not.toThrow();
  });
});
