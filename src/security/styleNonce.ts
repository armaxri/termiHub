/**
 * Nonce runtime `<style>` elements so the shipped CSP needs no
 * `style-src 'unsafe-inline'` (SEC-013 follow-up, #3115).
 *
 * The production CSP lets `<style>` elements apply only when they come from the
 * app's own bundle (`'self'`) or carry the per-load nonce Tauri mints. Tauri's
 * build step stamps every `<style>` in `index.html` with a placeholder nonce;
 * for each page load, its asset protocol swaps the placeholder for a fresh
 * random value and appends `'nonce-<value>'` to `style-src` in the response's
 * CSP header (`tauri::manager::set_csp`).
 *
 * xterm.js, Monaco, sonner, `react-remove-scroll` and `react-colorful` create
 * their stylesheets at runtime with `document.createElement("style")`. Their
 * contents are dynamic, so no build-time hash can cover them, and most offer no
 * nonce option. This module reads the nonce off `index.html`'s boot `<style>`
 * (the `nonce` content attribute is hidden from the DOM once the element is
 * parsed, but the `nonce` IDL property still returns it) and patches
 * `Document.prototype.createElement` / `createElementNS` so every `<style>`
 * element created by script carries it. Markup injected through `innerHTML` or
 * the HTML parser gets no nonce, so an HTML-injection `<style>` stays blocked.
 *
 * Inline style **attributes** (`style="…"` in Monaco's and xterm's generated
 * markup, `setAttribute("style", …)`) are governed by `style-src-attr`, which
 * keeps `'unsafe-inline'`: nonces do not apply to attributes. Scripted CSSOM
 * writes (`el.style.x = …`, `setProperty`, `insertRule`, constructable
 * stylesheets) are exempt from CSP and need nothing.
 *
 * Without a nonce (Vite dev, where the webview runs no CSP, and vitest) this is
 * a no-op. It must run before any module that creates a `<style>` while it is
 * evaluated (sonner does), so `main.tsx` imports it ahead of the app.
 */

/** `id` of the inline `<style>` in `index.html` whose nonce is read. */
export const BOOT_STYLE_ID = "termihub-boot-style";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

/** The nonce applied by {@link installStyleNonce}, or `null` when not installed. */
let installedNonce: string | null = null;

/** Puts the original `Document.prototype` methods back (tests only). */
let restore: (() => void) | null = null;

/**
 * The CSP style nonce Tauri stamped onto `index.html`'s boot `<style>`, or
 * `null` when the page carries none (dev server, tests, missing element).
 */
export function readStyleNonce(doc: Document = document): string | null {
  const boot = doc.getElementById(BOOT_STYLE_ID);
  if (!boot) return null;
  // The IDL property survives nonce hiding; the attribute is the fallback for an
  // engine without the property.
  const nonce = (boot as HTMLElement).nonce || boot.getAttribute("nonce") || "";
  // An unreplaced build-time placeholder is not a nonce the CSP allows.
  if (nonce === "" || nonce.startsWith("__")) return null;
  return nonce;
}

function isStyleElement(el: Element): boolean {
  return el.localName === "style" && (el.namespaceURI === HTML_NS || el.namespaceURI === SVG_NS);
}

function stamp(el: Element, nonce: string): void {
  // The content attribute sets the element's cryptographic nonce in every
  // engine; on insertion into a CSP-protected document the browser hides it.
  if (isStyleElement(el)) el.setAttribute("nonce", nonce);
}

/**
 * Patch the realm's `Document.prototype` so script-created `<style>` elements
 * carry the page's CSP nonce. Idempotent. Returns the nonce applied, or `null`
 * when the page has none (nothing is patched then).
 */
export function installStyleNonce(doc: Document = document): string | null {
  if (installedNonce !== null) return installedNonce;
  const nonce = readStyleNonce(doc);
  if (nonce === null) return null;
  installedNonce = nonce;

  const proto = Document.prototype;
  const createElement = proto.createElement;
  const createElementNS = proto.createElementNS;

  proto.createElement = function (
    this: Document,
    tagName: string,
    options?: ElementCreationOptions
  ): HTMLElement {
    const el = createElement.call(this, tagName, options);
    stamp(el, nonce);
    return el;
  } as typeof proto.createElement;

  proto.createElementNS = function (
    this: Document,
    namespaceURI: string | null,
    qualifiedName: string,
    options?: string | ElementCreationOptions
  ): Element {
    const el = createElementNS.call(this, namespaceURI, qualifiedName, options as never);
    stamp(el, nonce);
    return el;
  } as typeof proto.createElementNS;

  restore = () => {
    proto.createElement = createElement;
    proto.createElementNS = createElementNS;
  };
  return nonce;
}

/** Undo {@link installStyleNonce} (tests only). */
export function resetStyleNonceForTests(): void {
  restore?.();
  restore = null;
  installedNonce = null;
}
