/**
 * The side of the {@link FingerprintGlyph} grid, in cells. The left
 * {@link GLYPH_HALF} columns come from the fingerprint and are mirrored to the
 * right, so the glyph reads as one shape rather than noise.
 */
export const GLYPH_SIZE = 7;
const GLYPH_HALF = Math.ceil(GLYPH_SIZE / 2);
/** The number of fingerprint bits that set the glyph's cells. */
const GLYPH_BITS = GLYPH_SIZE * GLYPH_HALF;

/**
 * The bytes a fingerprint stands for: the digest of an OpenSSH
 * `SHA256:<base64>` fingerprint, the bytes of a colon-separated hex digest,
 * or (anything else) the UTF-16 code units of the string.
 */
export function fingerprintBytes(value: string): number[] {
  const trimmed = value.trim();
  const b64 = /^SHA256:([A-Za-z0-9+/]+)=*$/.exec(trimmed);
  if (b64) {
    const body = b64[1];
    try {
      const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
      return Array.from(atob(padded), (c) => c.charCodeAt(0));
    } catch {
      // Not valid base64 after all: fall through to the plain string.
    }
  }
  const hex = trimmed.replace(/^(?![0-9a-fA-F]{2}:)[A-Za-z0-9-]+:(?=[0-9a-fA-F]{2}:)/, "");
  if (/^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2})+$/.test(hex)) {
    return hex.split(":").map((h) => parseInt(h, 16));
  }
  return Array.from(trimmed, (c) => c.charCodeAt(0) & 0xff);
}

/**
 * The glyph's filled cells for `value`, row by row ({@link GLYPH_SIZE}²
 * booleans). Every byte of the digest folds into the bits (XOR), so two keys
 * that differ anywhere get different glyphs with near certainty
 * (1 in 2^{@link GLYPH_BITS} collide). A visual aid for telling two
 * fingerprints apart at a glance (#5862, R-109), not a substitute for
 * checking the fingerprint itself.
 */
export function fingerprintGlyphCells(value: string): boolean[] {
  const bytes = fingerprintBytes(value);
  const bitBytes = Math.ceil(GLYPH_BITS / 8);
  const folded = new Array<number>(bitBytes).fill(0);
  bytes.forEach((b, i) => {
    folded[i % bitBytes] ^= b;
  });
  const bit = (n: number) => ((folded[n >> 3] >> (n & 7)) & 1) === 1;
  const cells: boolean[] = [];
  for (let row = 0; row < GLYPH_SIZE; row++) {
    for (let col = 0; col < GLYPH_SIZE; col++) {
      const source = col < GLYPH_HALF ? col : GLYPH_SIZE - 1 - col;
      cells.push(bit(row * GLYPH_HALF + source));
    }
  }
  return cells;
}

/**
 * A compact signature of the glyph's pattern (one hex digit per four cells of
 * the left half), exposed as `data-glyph` so the product-run grade can tell
 * whether two glyphs differ without reading pixels.
 */
export function fingerprintGlyphSignature(value: string): string {
  const cells = fingerprintGlyphCells(value);
  const bits: number[] = [];
  for (let row = 0; row < GLYPH_SIZE; row++) {
    for (let col = 0; col < GLYPH_HALF; col++) bits.push(cells[row * GLYPH_SIZE + col] ? 1 : 0);
  }
  let out = "";
  for (let i = 0; i < bits.length; i += 4) {
    out += bits
      .slice(i, i + 4)
      .reduce((acc, b, j) => acc | (b << j), 0)
      .toString(16);
  }
  return out;
}

/** Props for {@link FingerprintGlyph}. */
export interface FingerprintGlyphProps {
  /** The fingerprint the glyph is drawn from. */
  value: string;
  /** `data-testid` for the `<svg>`. */
  testId?: string;
}

/**
 * A small mirrored block pattern drawn from a fingerprint (#5862, R-109),
 * shown beside the old and the new fingerprint on a changed host key. Two
 * SHA-256 hashes differ in almost every character, so a character diff does
 * not help; two different shapes are obvious at a glance. Decorative
 * (`aria-hidden`): the dialog says in words that the fingerprint changed.
 */
export function FingerprintGlyph({ value, testId }: FingerprintGlyphProps) {
  const cells = fingerprintGlyphCells(value);
  return (
    <svg
      className="ui-trust-prompt__glyph"
      viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      data-testid={testId}
      data-glyph={fingerprintGlyphSignature(value)}
    >
      {cells.map((on, i) =>
        on ? (
          <rect
            key={i}
            x={i % GLYPH_SIZE}
            y={Math.floor(i / GLYPH_SIZE)}
            width={1}
            height={1}
            fill="currentColor"
          />
        ) : null
      )}
    </svg>
  );
}
