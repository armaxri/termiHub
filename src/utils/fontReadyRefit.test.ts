import { describe, it, expect, vi, afterEach } from "vitest";
import { refitWhenFontsReady } from "./fontReadyRefit";
import type { FitAddon } from "@xterm/addon-fit";

interface MutableFonts {
  ready: Promise<void>;
}

function stubFontsReady(promise: Promise<void>): () => void {
  const original = (document as unknown as { fonts?: MutableFonts }).fonts;
  Object.defineProperty(document, "fonts", {
    value: { ready: promise },
    configurable: true,
  });
  return () => {
    if (original) {
      Object.defineProperty(document, "fonts", { value: original, configurable: true });
    } else {
      delete (document as unknown as { fonts?: MutableFonts }).fonts;
    }
  };
}

function makeFitAddon(): FitAddon & { fit: ReturnType<typeof vi.fn> } {
  return { fit: vi.fn() } as unknown as FitAddon & { fit: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refitWhenFontsReady", () => {
  it("calls FitAddon.fit() after document.fonts.ready resolves", async () => {
    const restore = stubFontsReady(Promise.resolve());
    const fit = makeFitAddon();
    try {
      await refitWhenFontsReady(fit, () => false);
      expect(fit.fit).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("does not call fit() if the caller was canceled while waiting", async () => {
    let resolveFonts!: () => void;
    const fontsReady = new Promise<void>((r) => {
      resolveFonts = r;
    });
    const restore = stubFontsReady(fontsReady);
    const fit = makeFitAddon();
    let canceled = false;
    try {
      const promise = refitWhenFontsReady(fit, () => canceled);
      canceled = true;
      resolveFonts();
      await promise;
      expect(fit.fit).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("returns silently when document.fonts is unavailable", async () => {
    const original = (document as unknown as { fonts?: MutableFonts }).fonts;
    delete (document as unknown as { fonts?: MutableFonts }).fonts;
    const fit = makeFitAddon();
    try {
      await expect(refitWhenFontsReady(fit, () => false)).resolves.toBeUndefined();
      expect(fit.fit).not.toHaveBeenCalled();
    } finally {
      if (original) {
        Object.defineProperty(document, "fonts", { value: original, configurable: true });
      }
    }
  });

  it("swallows fit() errors so a still-parking terminal does not throw", async () => {
    const restore = stubFontsReady(Promise.resolve());
    const fit = {
      fit: vi.fn(() => {
        throw new Error("not yet sized");
      }),
    } as unknown as FitAddon;
    try {
      await expect(refitWhenFontsReady(fit, () => false)).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });
});
