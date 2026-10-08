import { describe, it, expect, vi } from "vitest";
import {
  createInlineImagesController,
  getInlineImagesController,
  registerInlineImagesController,
  INLINE_IMAGE_ADDON_OPTIONS,
  INLINE_IMAGE_LIMITS,
  INLINE_IMAGE_LOAD_HOLD_MS,
  shouldHoldOutputForInlineImages,
  sixelDecoderPending,
  type ImageAddonLoader,
} from "./inlineImages";

// PROD-057: the inline-images controller lazily loads @xterm/addon-image with
// conservative memory caps and must never leave a stray addon attached after a
// fast toggle or a teardown that races the lazy import.

interface FakeAddon {
  options: unknown;
  activate: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  storageUsage: number;
}

function setup(opts: { enabled: boolean; deferred?: boolean; fail?: boolean }) {
  const instances: FakeAddon[] = [];
  class FakeImageAddon implements FakeAddon {
    options: unknown;
    activate = vi.fn();
    dispose = vi.fn();
    storageUsage = 0;
    constructor(options?: unknown) {
      this.options = options;
      instances.push(this);
    }
  }
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loader = vi.fn(async () => {
    if (opts.deferred) await gate;
    if (opts.fail) throw new Error("chunk load failed");
    return FakeImageAddon;
  }) as unknown as ImageAddonLoader & ReturnType<typeof vi.fn>;
  const xterm = { loadAddon: vi.fn() };
  const onError = vi.fn();
  const controller = createInlineImagesController(xterm as never, {
    enabled: opts.enabled,
    loader,
    onError,
  });
  return { controller, instances, loader, xterm, onError, release };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("INLINE_IMAGE_LIMITS", () => {
  it("caps every size knob below the addon's upstream defaults", () => {
    // Upstream defaults: pixelLimit 4096², storageLimit 128 MB, sixel 25 MB, IIP 20 MB.
    expect(INLINE_IMAGE_LIMITS.pixelLimit).toBeLessThan(4096 * 4096);
    expect(INLINE_IMAGE_LIMITS.storageLimit).toBeLessThan(128);
    expect(INLINE_IMAGE_LIMITS.sixelSizeLimit).toBeLessThan(25_000_000);
    expect(INLINE_IMAGE_LIMITS.iipSizeLimit).toBeLessThan(20_000_000);
    expect(INLINE_IMAGE_ADDON_OPTIONS).toMatchObject(INLINE_IMAGE_LIMITS);
  });
});

describe("createInlineImagesController", () => {
  it("lazily loads the addon with the limited options when enabled", async () => {
    const { controller, instances, xterm } = setup({ enabled: true });
    expect(controller.isActive()).toBe(false);
    await flush();
    expect(instances).toHaveLength(1);
    expect(instances[0].options).toEqual(INLINE_IMAGE_ADDON_OPTIONS);
    expect(xterm.loadAddon).toHaveBeenCalledWith(instances[0]);
    expect(controller.isActive()).toBe(true);
  });

  it("never imports the addon when disabled", async () => {
    const { controller, loader, xterm } = setup({ enabled: false });
    await flush();
    expect(loader).not.toHaveBeenCalled();
    expect(xterm.loadAddon).not.toHaveBeenCalled();
    expect(controller.isActive()).toBe(false);
  });

  it("disposes the addon when disabled live and reloads when re-enabled", async () => {
    const { controller, instances } = setup({ enabled: true });
    await flush();
    controller.setEnabled(false);
    expect(instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(controller.isActive()).toBe(false);

    controller.setEnabled(true);
    await flush();
    expect(instances).toHaveLength(2);
    expect(controller.isActive()).toBe(true);
  });

  it("is idempotent for repeated enables", async () => {
    const { controller, instances } = setup({ enabled: true });
    controller.setEnabled(true);
    await flush();
    controller.setEnabled(true);
    await flush();
    expect(instances).toHaveLength(1);
  });

  it("discards a lazy load that resolves after dispose", async () => {
    const { controller, instances, xterm, release } = setup({ enabled: true, deferred: true });
    controller.dispose();
    release();
    await flush();
    expect(instances).toHaveLength(0);
    expect(xterm.loadAddon).not.toHaveBeenCalled();
  });

  it("discards a lazy load that resolves after the setting was turned off", async () => {
    const { controller, instances, release } = setup({ enabled: true, deferred: true });
    controller.setEnabled(false);
    release();
    await flush();
    expect(instances).toHaveLength(0);
    expect(controller.isActive()).toBe(false);
  });

  it("loads exactly once on an off→on toggle during an in-flight load", async () => {
    const { controller, instances, loader, release } = setup({ enabled: true, deferred: true });
    controller.setEnabled(false);
    controller.setEnabled(true);
    release();
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);
    expect(controller.isActive()).toBe(true);
  });

  it("disposes the loaded addon on dispose and ignores later toggles", async () => {
    const { controller, instances, loader } = setup({ enabled: true });
    await flush();
    controller.dispose();
    expect(instances[0].dispose).toHaveBeenCalledTimes(1);
    controller.setEnabled(true);
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(controller.isActive()).toBe(false);
  });

  it("reports a failed lazy load without throwing (terminal keeps working)", async () => {
    const { controller, onError } = setup({ enabled: true, fail: true });
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(controller.isActive()).toBe(false);
  });

  it("reports the loaded addon's image storage, and 0 when not loaded (#4013)", async () => {
    const { controller, instances } = setup({ enabled: true });
    expect(controller.storageUsage()).toBe(0);
    await flush();
    instances[0].storageUsage = 0.25;
    expect(controller.storageUsage()).toBe(0.25);
    // The addon reports -1 when it has no store; that reads as "nothing stored".
    instances[0].storageUsage = -1;
    expect(controller.storageUsage()).toBe(0);
    controller.setEnabled(false);
    expect(controller.storageUsage()).toBe(0);
  });
});

describe("holding output for the lazy image addon (#4017)", () => {
  it("reports loading only while a wanted load is in flight", async () => {
    const { controller, release } = setup({ enabled: true, deferred: true });
    expect(controller.isLoading()).toBe(true);
    release();
    await flush();
    expect(controller.isLoading()).toBe(false);
    expect(controller.isActive()).toBe(true);
  });

  it("is not loading when disabled, turned off mid-load, disposed or failed", async () => {
    expect(setup({ enabled: false }).controller.isLoading()).toBe(false);

    const off = setup({ enabled: true, deferred: true });
    off.controller.setEnabled(false);
    expect(off.controller.isLoading()).toBe(false);

    const gone = setup({ enabled: true, deferred: true });
    gone.controller.dispose();
    expect(gone.controller.isLoading()).toBe(false);

    const failed = setup({ enabled: true, fail: true });
    await flush();
    expect(failed.controller.isLoading()).toBe(false);
  });

  it("holds output while the addon loads, bounded by the hold window", async () => {
    const { controller, release } = setup({ enabled: true, deferred: true });
    // Regression: output arriving before the addon attached (an image a host
    // sends right after connecting) was written at once and lost its image.
    expect(shouldHoldOutputForInlineImages(controller, null, 1000)).toBe(true);
    expect(shouldHoldOutputForInlineImages(controller, 1000, 1000 + 50)).toBe(true);
    // A stalled import never blocks output past the window.
    expect(
      shouldHoldOutputForInlineImages(controller, 1000, 1000 + INLINE_IMAGE_LOAD_HOLD_MS)
    ).toBe(false);
    release();
    await flush();
    expect(shouldHoldOutputForInlineImages(controller, null, 5000)).toBe(false);
  });

  it("never holds without a controller", () => {
    expect(shouldHoldOutputForInlineImages(null, null, 0)).toBe(false);
    expect(shouldHoldOutputForInlineImages(undefined, null, 0)).toBe(false);
  });
});

describe("inline-images controller registry (#4013)", () => {
  it("registers, resolves and unregisters per tab", () => {
    const { controller } = setup({ enabled: false });
    const unregister = registerInlineImagesController("tab-img", controller);
    expect(getInlineImagesController("tab-img")).toBe(controller);
    unregister();
    expect(getInlineImagesController("tab-img")).toBeUndefined();
  });

  it("a stale unregister does not remove a newer controller for the same tab", () => {
    const first = setup({ enabled: false }).controller;
    const second = setup({ enabled: false }).controller;
    const unregisterFirst = registerInlineImagesController("tab-img", first);
    const unregisterSecond = registerInlineImagesController("tab-img", second);
    unregisterFirst();
    expect(getInlineImagesController("tab-img")).toBe(second);
    unregisterSecond();
  });
});

describe("waiting for the addon's async SIXEL decoder (#4017)", () => {
  // The real addon creates its SIXEL decoder asynchronously on activate; until
  // it resolves, the handler drops every SIXEL sequence while the surrounding
  // text still prints (nightly 2026-10-07: sixel over telnet, no image stored).
  function decoderSetup() {
    const sixel: { _dec?: unknown } = {};
    class AddonWithPendingDecoder {
      _handlers = new Map<string, unknown>([["sixel", sixel]]);
      activate = vi.fn();
      dispose = vi.fn();
      storageUsage = 0;
    }
    const onReady = vi.fn();
    const controller = createInlineImagesController({ loadAddon: vi.fn() } as never, {
      enabled: true,
      loader: (async () => AddonWithPendingDecoder) as unknown as ImageAddonLoader,
      onReady,
    });
    return { controller, sixel, onReady };
  }

  it("keeps loading until the decoder exists, then reports ready", async () => {
    vi.useFakeTimers();
    try {
      const { controller, sixel, onReady } = decoderSetup();
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.isActive()).toBe(true);
      // Attached, but output must still be held: the decoder is not there yet.
      expect(controller.isLoading()).toBe(true);
      await vi.advanceTimersByTimeAsync(50);
      expect(controller.isLoading()).toBe(true);
      sixel._dec = {};
      await vi.advanceTimersByTimeAsync(20);
      expect(controller.isLoading()).toBe(false);
      expect(onReady).toHaveBeenCalledWith(expect.any(Number), true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a decoder that never arrives within the hold window", async () => {
    vi.useFakeTimers();
    try {
      const { controller, onReady } = decoderSetup();
      await vi.advanceTimersByTimeAsync(INLINE_IMAGE_LOAD_HOLD_MS + 50);
      expect(controller.isLoading()).toBe(false);
      expect(onReady).toHaveBeenCalledWith(expect.any(Number), false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the decoder state off the addon's sixel handler", () => {
    expect(sixelDecoderPending({ _handlers: new Map([["sixel", {}]]) })).toBe(true);
    expect(sixelDecoderPending({ _handlers: new Map([["sixel", { _dec: {} }]]) })).toBe(false);
    // An unknown addon shape is never held.
    expect(sixelDecoderPending({})).toBe(false);
    expect(sixelDecoderPending({ _handlers: new Map() })).toBe(false);
    expect(sixelDecoderPending(null)).toBe(false);
  });

  it("matches the installed addon's private shape", async () => {
    // Pins the private fields the check reads: the handler map exists on a
    // fresh addon, and the bundle still assigns the decoder asynchronously.
    const { ImageAddon } = await import("@xterm/addon-image");
    expect((new ImageAddon() as unknown as { _handlers: unknown })._handlers).toBeInstanceOf(Map);
    const { readFileSync } = await import("node:fs");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const bundle = readFileSync(require.resolve("@xterm/addon-image"), "utf8");
    expect(bundle).toMatch(/\.then\(\(?\w+\)?=>this\._dec=\w+\)/);
  });
});
