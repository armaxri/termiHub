import { describe, it, expect, vi, afterEach } from "vitest";
import { refitWhenFontsReady } from "./fontReadyRefit";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

interface MutableFonts {
  ready: Promise<void>;
  load?: (font: string) => Promise<FontFace[]>;
}

interface FakeFonts {
  ready: Promise<void>;
  loadCalls: string[];
  loadImpl: (font: string) => Promise<FontFace[]>;
}

function stubFonts(opts?: {
  readyPromise?: Promise<void>;
  loadImpl?: (font: string) => Promise<FontFace[]>;
}): {
  fonts: FakeFonts;
  restore: () => void;
} {
  const original = (document as unknown as { fonts?: MutableFonts }).fonts;
  const loadCalls: string[] = [];
  const loadImpl = opts?.loadImpl ?? (() => Promise.resolve([] as FontFace[]));
  const fonts: FakeFonts = {
    ready: opts?.readyPromise ?? Promise.resolve(),
    loadCalls,
    loadImpl,
  };
  Object.defineProperty(document, "fonts", {
    value: {
      ready: fonts.ready,
      load: (font: string) => {
        loadCalls.push(font);
        return loadImpl(font);
      },
    },
    configurable: true,
  });
  return {
    fonts,
    restore: () => {
      if (original) {
        Object.defineProperty(document, "fonts", { value: original, configurable: true });
      } else {
        delete (document as unknown as { fonts?: MutableFonts }).fonts;
      }
    },
  };
}

function makeXterm(initialFamily = "'MesloLGS Nerd Font Mono', monospace"): XTerm & {
  options: { fontFamily: string };
} {
  return { options: { fontFamily: initialFamily } } as unknown as XTerm & {
    options: { fontFamily: string };
  };
}

function makeFitAddon(): FitAddon & { fit: ReturnType<typeof vi.fn> } {
  return { fit: vi.fn() } as unknown as FitAddon & { fit: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refitWhenFontsReady", () => {
  it("explicitly requests the primary font family at the configured size", async () => {
    const { fonts, restore } = stubFonts();
    const xterm = makeXterm();
    const fit = makeFitAddon();
    try {
      await refitWhenFontsReady(
        xterm,
        fit,
        "'MesloLGS Nerd Font Mono', 'MesloLGS NF', monospace",
        14,
        () => false
      );
      expect(fonts.loadCalls).toEqual([`14px "MesloLGS Nerd Font Mono"`]);
    } finally {
      restore();
    }
  });

  it("forces xterm to re-measure by toggling fontFamily through a sentinel and back", async () => {
    const { restore } = stubFonts();
    const xterm = makeXterm("'MesloLGS Nerd Font Mono', monospace");
    const seenValues: string[] = [];
    Object.defineProperty(xterm.options, "fontFamily", {
      get() {
        return seenValues[seenValues.length - 1] ?? "'MesloLGS Nerd Font Mono', monospace";
      },
      set(v: string) {
        seenValues.push(v);
      },
      configurable: true,
    });
    const fit = makeFitAddon();
    try {
      await refitWhenFontsReady(
        xterm,
        fit,
        "'MesloLGS Nerd Font Mono', monospace",
        14,
        () => false
      );
      expect(seenValues).toEqual(["monospace", "'MesloLGS Nerd Font Mono', monospace"]);
    } finally {
      restore();
    }
  });

  it("calls fit() after the font is loaded and the re-measure is forced", async () => {
    const { restore } = stubFonts();
    const xterm = makeXterm();
    const fit = makeFitAddon();
    try {
      await refitWhenFontsReady(
        xterm,
        fit,
        "'MesloLGS Nerd Font Mono', monospace",
        14,
        () => false
      );
      expect(fit.fit).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("does not call fit() if the caller cancels mid-await", async () => {
    let resolveFonts!: () => void;
    const readyPromise = new Promise<void>((r) => {
      resolveFonts = r;
    });
    const { restore } = stubFonts({ readyPromise });
    const xterm = makeXterm();
    const fit = makeFitAddon();
    let canceled = false;
    try {
      const p = refitWhenFontsReady(
        xterm,
        fit,
        "'MesloLGS Nerd Font Mono', monospace",
        14,
        () => canceled
      );
      canceled = true;
      resolveFonts();
      await p;
      expect(fit.fit).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("returns silently when document.fonts is unavailable", async () => {
    const original = (document as unknown as { fonts?: MutableFonts }).fonts;
    delete (document as unknown as { fonts?: MutableFonts }).fonts;
    const xterm = makeXterm();
    const fit = makeFitAddon();
    try {
      await expect(
        refitWhenFontsReady(xterm, fit, "'MesloLGS Nerd Font Mono', monospace", 14, () => false)
      ).resolves.toBeUndefined();
      expect(fit.fit).not.toHaveBeenCalled();
    } finally {
      if (original) {
        Object.defineProperty(document, "fonts", { value: original, configurable: true });
      }
    }
  });

  it("still re-fits if the explicit document.fonts.load() rejects", async () => {
    const { fonts, restore } = stubFonts({
      loadImpl: () => Promise.reject(new Error("network error")),
    });
    const xterm = makeXterm();
    const fit = makeFitAddon();
    try {
      await refitWhenFontsReady(
        xterm,
        fit,
        "'MesloLGS Nerd Font Mono', monospace",
        14,
        () => false
      );
      expect(fonts.loadCalls).toEqual([`14px "MesloLGS Nerd Font Mono"`]);
      expect(fit.fit).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
