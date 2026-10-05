import { afterEach, describe, expect, it } from "vitest";
import {
  BOOT_STYLE_ID,
  installStyleNonce,
  readStyleNonce,
  resetStyleNonceForTests,
} from "./styleNonce";

/**
 * The CSP style-nonce bootstrap (#3115): `<style>` elements created by script
 * must carry the per-load nonce Tauri stamps onto `index.html`'s boot `<style>`,
 * because the shipped `style-src` no longer has `'unsafe-inline'`.
 */

const NONCE = "12345678901234567890";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Put a boot `<style>` into `doc.head`, as Tauri serves `index.html`. */
function addBootStyle(doc: Document, nonce: string | null): HTMLStyleElement {
  const style = doc.createElement("style");
  style.id = BOOT_STYLE_ID;
  if (nonce !== null) style.setAttribute("nonce", nonce);
  doc.head.appendChild(style);
  return style;
}

afterEach(() => {
  resetStyleNonceForTests();
  document.getElementById(BOOT_STYLE_ID)?.remove();
});

describe("readStyleNonce", () => {
  it("returns null without a boot <style> (the Vite dev server)", () => {
    expect(readStyleNonce()).toBeNull();
  });

  it("returns null when the boot <style> carries no nonce", () => {
    addBootStyle(document, null);
    expect(readStyleNonce()).toBeNull();
  });

  it("returns null for an unreplaced build-time placeholder", () => {
    addBootStyle(document, "__TAURI_STYLE_NONCE__");
    expect(readStyleNonce()).toBeNull();
  });

  it("reads the nonce attribute", () => {
    addBootStyle(document, NONCE);
    expect(readStyleNonce()).toBe(NONCE);
  });

  it("reads the nonce IDL property once the browser has hidden the attribute", () => {
    // A CSP-protected document blanks the `nonce` content attribute on insertion;
    // only the IDL property still returns the value.
    const style = addBootStyle(document, "");
    Object.defineProperty(style, "nonce", { value: NONCE, configurable: true });
    expect(readStyleNonce()).toBe(NONCE);
  });
});

describe("installStyleNonce", () => {
  it("is a no-op without a nonce and leaves createElement unpatched", () => {
    const original = Document.prototype.createElement;
    expect(installStyleNonce()).toBeNull();
    expect(Document.prototype.createElement).toBe(original);
    expect(document.createElement("style").hasAttribute("nonce")).toBe(false);
  });

  it("stamps the nonce on script-created <style> elements", () => {
    addBootStyle(document, NONCE);
    expect(installStyleNonce()).toBe(NONCE);
    expect(document.createElement("style").getAttribute("nonce")).toBe(NONCE);
    expect(document.createElement("STYLE").getAttribute("nonce")).toBe(NONCE);
  });

  it("stamps HTML and SVG <style> elements made with createElementNS", () => {
    addBootStyle(document, NONCE);
    installStyleNonce();
    const html = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
    const svg = document.createElementNS(SVG_NS, "style");
    expect(html.getAttribute("nonce")).toBe(NONCE);
    expect(svg.getAttribute("nonce")).toBe(NONCE);
  });

  it("leaves every other element alone", () => {
    addBootStyle(document, NONCE);
    installStyleNonce();
    expect(document.createElement("div").hasAttribute("nonce")).toBe(false);
    expect(document.createElement("script").hasAttribute("nonce")).toBe(false);
    expect(document.createElement("link").hasAttribute("nonce")).toBe(false);
    expect(document.createElementNS(SVG_NS, "rect").hasAttribute("nonce")).toBe(false);
  });

  it("covers other documents of the realm (xterm/Monaco use ownerDocument)", () => {
    addBootStyle(document, NONCE);
    installStyleNonce();
    const other = document.implementation.createHTMLDocument("other");
    expect(other.createElement("style").getAttribute("nonce")).toBe(NONCE);
  });

  it("does not stamp <style> markup parsed from HTML (an injection stays blocked)", () => {
    addBootStyle(document, NONCE);
    installStyleNonce();
    const host = document.createElement("div");
    host.innerHTML = "<style>body{}</style>";
    expect(host.querySelector("style")?.hasAttribute("nonce")).toBe(false);
  });

  it("is idempotent — a second install does not wrap createElement twice", () => {
    addBootStyle(document, NONCE);
    installStyleNonce();
    const patched = Document.prototype.createElement;
    expect(installStyleNonce()).toBe(NONCE);
    expect(Document.prototype.createElement).toBe(patched);
  });

  it("keeps createElement's behaviour for options and the element type", () => {
    addBootStyle(document, NONCE);
    installStyleNonce();
    const style = document.createElement("style");
    expect(style).toBeInstanceOf(HTMLStyleElement);
    style.textContent = ".x{}";
    document.head.appendChild(style);
    expect(document.head.lastElementChild).toBe(style);
    style.remove();
  });

  it("restores the original methods on reset", () => {
    const original = Document.prototype.createElement;
    const originalNS = Document.prototype.createElementNS;
    addBootStyle(document, NONCE);
    installStyleNonce();
    resetStyleNonceForTests();
    expect(Document.prototype.createElement).toBe(original);
    expect(Document.prototype.createElementNS).toBe(originalNS);
  });
});
