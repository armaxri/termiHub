import { describe, it, expect, vi } from "vitest";
import {
  createInlineImagesController,
  INLINE_IMAGE_ADDON_OPTIONS,
  INLINE_IMAGE_LIMITS,
  type ImageAddonLoader,
} from "./inlineImages";

// PROD-057: the inline-images controller lazily loads @xterm/addon-image with
// conservative memory caps and must never leave a stray addon attached after a
// fast toggle or a teardown that races the lazy import.

interface FakeAddon {
  options: unknown;
  activate: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

function setup(opts: { enabled: boolean; deferred?: boolean; fail?: boolean }) {
  const instances: FakeAddon[] = [];
  class FakeImageAddon implements FakeAddon {
    options: unknown;
    activate = vi.fn();
    dispose = vi.fn();
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
});
