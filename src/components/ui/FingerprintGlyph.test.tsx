/**
 * Tests for {@link FingerprintGlyph} (#5862, R-109): the block glyph drawn
 * from a fingerprint so an old and a new host key look different at a glance.
 */
import { describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  FingerprintGlyph,
  GLYPH_SIZE,
  fingerprintBytes,
  fingerprintGlyphCells,
  fingerprintGlyphSignature,
} from "./FingerprintGlyph";

// Two real-shaped OpenSSH SHA-256 fingerprints (43 base64 characters each).
const OLD = "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s";
const NEW = "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU";

describe("fingerprintBytes", () => {
  it("decodes the 32-byte digest of an OpenSSH SHA256 fingerprint", () => {
    expect(fingerprintBytes(OLD)).toHaveLength(32);
    expect(fingerprintBytes(NEW).slice(0, 2)).toEqual([0xe3, 0xb0]);
  });

  it("parses a colon-separated hex digest, with or without a prefix", () => {
    expect(fingerprintBytes("AB:CD:EF")).toEqual([0xab, 0xcd, 0xef]);
    expect(fingerprintBytes("sha256:AB:CD:EF")).toEqual([0xab, 0xcd, 0xef]);
  });

  it("falls back to the characters of anything else", () => {
    expect(fingerprintBytes("xyz")).toEqual([0x78, 0x79, 0x7a]);
  });
});

describe("fingerprintGlyphCells", () => {
  it("is a mirrored square grid", () => {
    const cells = fingerprintGlyphCells(OLD);
    expect(cells).toHaveLength(GLYPH_SIZE * GLYPH_SIZE);
    for (let row = 0; row < GLYPH_SIZE; row++) {
      for (let col = 0; col < GLYPH_SIZE; col++) {
        expect(cells[row * GLYPH_SIZE + col]).toBe(cells[row * GLYPH_SIZE + GLYPH_SIZE - 1 - col]);
      }
    }
  });

  it("is the same for the same fingerprint and differs for another", () => {
    expect(fingerprintGlyphSignature(OLD)).toBe(fingerprintGlyphSignature(OLD));
    expect(fingerprintGlyphSignature(OLD)).not.toBe(fingerprintGlyphSignature(NEW));
  });

  it("depends on every byte, not only the first ones", () => {
    const a = "AA:" + "00:".repeat(30) + "01";
    const b = "AA:" + "00:".repeat(30) + "02";
    expect(fingerprintGlyphSignature(a)).not.toBe(fingerprintGlyphSignature(b));
  });
});

describe("FingerprintGlyph", () => {
  it("renders a decorative svg carrying its signature", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<FingerprintGlyph value={OLD} testId="glyph" />));
    const svg = host.querySelector('[data-testid="glyph"]');
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("data-glyph")).toBe(fingerprintGlyphSignature(OLD));
    const filled = fingerprintGlyphCells(OLD).filter(Boolean).length;
    expect(svg?.querySelectorAll("rect")).toHaveLength(filled);
    act(() => root.unmount());
  });
});
