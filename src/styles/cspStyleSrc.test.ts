import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * CSP style-src regression guard (#2083/#2084/#2085).
 *
 * The app ships a restrictive production CSP (#2048/PR #2058). The terminal
 * (xterm's DOM renderer), the toast hub (sonner) and other libraries inject
 * their stylesheets into the document as runtime `<style>` elements, so the
 * policy MUST keep `style-src 'unsafe-inline'` effective for them.
 *
 * The trap this guards against: `index.html` contains an inline `<style>`, so at
 * build time Tauri hashes it and appends that hash to `style-src`. Per CSP Level
 * 3, once a hash (or nonce) source is present the browser **ignores**
 * `'unsafe-inline'` — which silently blocks every runtime-injected stylesheet,
 * leaving the terminal monochrome/blank, the toasts flowing inline instead of as
 * a corner overlay, and the cursor invisible. `dangerousDisableAssetCspModification`
 * listing `"style-src"` tells Tauri NOT to touch that directive, so
 * `'unsafe-inline'` stays effective. `script-src` is deliberately NOT listed, so
 * it stays hardened (no `'unsafe-inline'`) — the actual XSS surface #2048 closed.
 *
 * This test fails if any of those invariants regress.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TAURI_CONF = join(REPO_ROOT, "src-tauri", "tauri.conf.json");
const INDEX_HTML = join(REPO_ROOT, "index.html");

interface TauriSecurity {
  csp?: string | null;
  dangerousDisableAssetCspModification?: boolean | string[];
}

function readSecurity(): TauriSecurity {
  const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
  return conf.app?.security ?? {};
}

/** Parse a CSP string into `{ directive: sources[] }`. */
function parseCsp(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...sources] = tokens;
    out[name] = sources;
  }
  return out;
}

describe("production CSP keeps runtime-injected styles working", () => {
  const security = readSecurity();

  it("still ships a restrictive CSP (not null) — #2048 hardening intact", () => {
    expect(typeof security.csp).toBe("string");
    expect(security.csp).toBeTruthy();
  });

  it("keeps style-src 'unsafe-inline' for xterm/sonner runtime stylesheets", () => {
    const directives = parseCsp(security.csp as string);
    expect(directives["style-src"]).toContain("'unsafe-inline'");
  });

  it("keeps script-src hardened — no 'unsafe-inline' (the #2048 XSS surface)", () => {
    const directives = parseCsp(security.csp as string);
    expect(directives["script-src"]).toBeDefined();
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("disables Tauri's style-src modification so 'unsafe-inline' is not nullified", () => {
    // Without this, Tauri appends index.html's inline-<style> hash to style-src,
    // and CSP3 then makes the browser ignore 'unsafe-inline' — the #2083/#2084/#2085
    // regression. script-src must NOT be disabled (it must stay Tauri-hardened).
    const disabled = security.dangerousDisableAssetCspModification;
    expect(Array.isArray(disabled)).toBe(true);
    expect(disabled as string[]).toContain("style-src");
    expect(disabled as string[]).not.toContain("script-src");
  });

  it("documents the trigger: index.html carries an inline <style>", () => {
    // If this ever stops being true the guard above is still safe to keep, but the
    // reason it exists changes — hence this canary rather than a silent assumption.
    const html = readFileSync(INDEX_HTML, "utf8");
    expect(html).toMatch(/<style[\s>]/i);
  });
});
