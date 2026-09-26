/**
 * Inline terminal images (PROD-057).
 *
 * Wraps `@xterm/addon-image`, which renders SIXEL graphics and the iTerm2
 * Inline Images Protocol (IIP, `OSC 1337 ; File=…`) directly in the terminal —
 * e.g. `img2sixel`, `chafa -f sixel`, `imgcat`, or matplotlib's sixel backend.
 *
 * Two concerns shape this module:
 *
 * 1. **Memory safety.** A remote host fully controls the byte stream it sends,
 *    so a hostile or buggy program can emit enormous images. Every size knob of
 *    the addon is therefore capped well below its (generous) upstream default —
 *    see {@link INLINE_IMAGE_LIMITS}. An image over a cap is discarded by the
 *    addon without touching the terminal buffer; the per-terminal image store
 *    is a FIFO cache that evicts the oldest images once it is full.
 *
 * 2. **Bundle size.** The addon (with its embedded WASM SIXEL decoder) is
 *    ~60 KB minified, so it is loaded lazily via a dynamic `import()` the first
 *    time a terminal with inline images enabled is created. Users who turn the
 *    setting off never download it.
 *
 * Images live only in the addon's own image store, never in the xterm text
 * buffer, so the scrollback snapshot taken on teardown (#1126 — via the
 * serialize addon) contains no image data: on a reconnect the text is replayed
 * and the images are simply dropped. That is the intended behaviour.
 */
import type { Terminal as XTerm } from "@xterm/xterm";
import type { IImageAddonOptions, ImageAddon } from "@xterm/addon-image";

/**
 * Conservative per-terminal limits for inline images. Chosen so that the worst
 * case per terminal stays bounded (tens of MB) even with many tabs open, while
 * still fitting a full-screen image on a large display.
 */
export const INLINE_IMAGE_LIMITS = {
  /**
   * Max pixels in a single image: 2048 × 2048 (upstream default 4096 × 4096).
   * Bounds decode-time memory to ~16 MB (RGBA) per image.
   */
  pixelLimit: 2048 * 2048,
  /** Per-terminal FIFO image store, in MB (upstream default 128 MB). */
  storageLimit: 32,
  /** Max raw bytes of a single SIXEL sequence (upstream default 25 MB). */
  sixelSizeLimit: 8_000_000,
  /** Max raw bytes of a single iTerm2 IIP sequence (upstream default 20 MB). */
  iipSizeLimit: 8_000_000,
  /** SIXEL palette colour limit (upstream default, restated for clarity). */
  sixelPaletteLimit: 256,
} as const;

/** Full option set handed to the `ImageAddon` constructor. */
export const INLINE_IMAGE_ADDON_OPTIONS: IImageAddonOptions = {
  ...INLINE_IMAGE_LIMITS,
  // Answer the pixel/cell-size window reports (CSI 14/16/18 t). SIXEL and IIP
  // tools use them to size images to the terminal; they disclose only window
  // geometry, which the terminal size already implies.
  enableSizeReports: true,
  // Show a placeholder where an image was evicted from the store, so a
  // scrolled-back region never looks silently blank.
  showPlaceholder: true,
  sixelSupport: true,
  sixelScrolling: true,
  iipSupport: true,
};

/** Loads the addon constructor. Injectable for tests. */
export type ImageAddonLoader = () => Promise<
  new (options?: IImageAddonOptions) => Pick<ImageAddon, "activate" | "dispose">
>;

const defaultLoader: ImageAddonLoader = async () => (await import("@xterm/addon-image")).ImageAddon;

/** Live handle controlling inline-image support for one xterm instance. */
export interface InlineImagesController {
  /** Turn inline images on or off for this terminal (idempotent). */
  setEnabled(enabled: boolean): void;
  /** Whether the addon is currently loaded into the terminal. */
  isActive(): boolean;
  /** Dispose the addon (if loaded) and ignore any in-flight lazy load. */
  dispose(): void;
}

/**
 * Create the inline-images controller for one xterm instance. The addon is
 * loaded lazily and asynchronously; a load that resolves after the setting was
 * turned off (or after {@link InlineImagesController.dispose}) is discarded, so
 * a fast toggle or a tab teardown can never leave a stray addon attached to a
 * disposed terminal.
 */
export function createInlineImagesController(
  xterm: Pick<XTerm, "loadAddon">,
  opts: {
    enabled: boolean;
    loader?: ImageAddonLoader;
    onError?: (err: unknown) => void;
  }
): InlineImagesController {
  const loader = opts.loader ?? defaultLoader;
  let addon: Pick<ImageAddon, "dispose"> | null = null;
  let wanted = false;
  let disposed = false;
  // At most one lazy load in flight; its result is re-checked against `wanted`
  // on resolve, so an off→on toggle mid-load still ends up with one addon.
  let loading = false;

  const load = () => {
    if (loading || addon) return;
    loading = true;
    loader()
      .then((Ctor) => {
        loading = false;
        if (disposed || !wanted) return;
        const instance = new Ctor(INLINE_IMAGE_ADDON_OPTIONS);
        xterm.loadAddon(instance);
        addon = instance;
      })
      .catch((err: unknown) => {
        loading = false;
        opts.onError?.(err);
      });
  };

  const controller: InlineImagesController = {
    setEnabled(enabled: boolean) {
      if (disposed) return;
      wanted = enabled;
      if (enabled) {
        load();
      } else if (addon) {
        const current = addon;
        addon = null;
        try {
          current.dispose();
        } catch (err) {
          opts.onError?.(err);
        }
      }
    },
    isActive: () => addon !== null,
    dispose() {
      if (disposed) return;
      disposed = true;
      wanted = false;
      if (addon) {
        const current = addon;
        addon = null;
        try {
          current.dispose();
        } catch (err) {
          opts.onError?.(err);
        }
      }
    },
  };

  controller.setEnabled(opts.enabled);
  return controller;
}
