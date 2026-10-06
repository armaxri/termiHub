import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { CSP_PLATFORMS, effectiveCsp, effectiveSecurity } from "@/test/tauriCsp";
import { BOOT_STYLE_ID } from "@/security/styleNonce";

/**
 * CSP style guard (#2083/#2084/#2085, tightened in #3115).
 *
 * xterm.js, Monaco, sonner, `react-remove-scroll` and `react-colorful` inject
 * their stylesheets as runtime `<style>` elements. Until #3115 the policy kept
 * `style-src 'unsafe-inline'` for them and told Tauri not to touch `style-src`
 * (`dangerousDisableAssetCspModification`), because the nonce Tauri appends for
 * `index.html`'s inline `<style>` cancels `'unsafe-inline'` under CSP Level 3
 * and silently blocked every runtime stylesheet.
 *
 * Now the nonce is the mechanism: Tauri stamps the boot `<style>` with a
 * per-load nonce and appends it to `style-src`; `src/security/styleNonce.ts`
 * reads it and stamps every script-created `<style>` with it. Elements get no
 * `'unsafe-inline'`. Inline style **attributes** (Monaco's and xterm's generated
 * markup) cannot be nonced, so `style-src-attr` alone keeps `'unsafe-inline'`.
 *
 * Every invariant below is load-bearing — a regression silently unstyles the
 * terminal, editor or toasts, which only the nightly `test_csp.py` would see.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX_HTML = readFileSync(join(REPO_ROOT, "index.html"), "utf8");
const MAIN_TSX = readFileSync(join(REPO_ROOT, "src", "main.tsx"), "utf8");

describe.each(CSP_PLATFORMS)("production CSP style directives on %s", (platform) => {
  const security = effectiveSecurity(platform);
  const csp = effectiveCsp(platform);

  it("still ships a restrictive CSP (not null) — #2048 hardening intact", () => {
    expect(security.csp).toBeTruthy();
    expect(Object.keys(csp)).toContain("default-src");
  });

  it("allows <style> elements only from 'self' (plus Tauri's runtime nonce)", () => {
    expect(csp["style-src"]).toEqual(["'self'"]);
  });

  it("keeps 'unsafe-inline' only for style attributes", () => {
    expect(csp["style-src-attr"]).toEqual(["'unsafe-inline'"]);
  });

  it("declares no style-src-elem — Tauri appends its nonce to style-src only", () => {
    // A style-src-elem directive would take precedence over style-src for
    // <style> elements without the nonce Tauri adds, blocking every stylesheet.
    expect(csp["style-src-elem"]).toBeUndefined();
  });

  it("lets Tauri add its style nonce (no style-src opt-out)", () => {
    const disabled = security.dangerousDisableAssetCspModification;
    if (disabled === undefined || disabled === false) return;
    expect(disabled, "Tauri must keep appending the style nonce").not.toBe(true);
    expect(disabled as string[]).not.toContain("style-src");
    expect(disabled as string[]).not.toContain("script-src");
  });

  it("keeps script-src hardened — no 'unsafe-inline' (the #2048 XSS surface)", () => {
    expect(csp["script-src"]).toBeDefined();
    expect(csp["script-src"]).not.toContain("'unsafe-inline'");
  });
});

describe("the style nonce reaches the runtime stylesheets", () => {
  it("index.html carries the boot <style> the nonce is read from", () => {
    // Tauri stamps every <style> in index.html with a nonce; this one is the
    // element styleNonce.ts reads it from.
    expect(INDEX_HTML).toMatch(new RegExp(`<style id="${BOOT_STYLE_ID}">`));
  });

  it("main.tsx installs the nonce before React, the app and any library", () => {
    const imports = [...MAIN_TSX.matchAll(/^import\s+(?:[^"']+from\s+)?["']([^"']+)["'];/gm)].map(
      (m) => m[1]
    );
    const at = imports.indexOf("./security/installStyleNonce");
    expect(at, "main.tsx must import ./security/installStyleNonce").toBeGreaterThanOrEqual(0);
    // Only side-effect bootstrap modules (locale sanitiser) may precede it.
    expect(imports.slice(0, at)).toEqual(["./utils/ensureValidLocale"]);
  });
});
