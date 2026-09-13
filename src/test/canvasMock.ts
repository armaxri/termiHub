import { vi, type Mock } from "vitest";

/**
 * A minimal, inspectable stand-in for `CanvasRenderingContext2D`.
 *
 * jsdom does not implement `HTMLCanvasElement.getContext` (it returns `null`), so
 * any component that paints to a `<canvas>` bails out — or throws — the moment it
 * mounts under the repo's `createRoot` + `act` harness. This stub exposes only the
 * drawing surface the app's canvas components actually touch, with each method a
 * `vi.fn()` so tests can assert the exact draw calls a frame or prop update
 * produces (rather than settling for a smoke-only mount).
 */
export interface Canvas2DContextStub {
  /** The canvas element this context is bound to (mirrors the real API). */
  readonly canvas: HTMLCanvasElement;
  clearRect: Mock;
  fillRect: Mock;
  drawImage: Mock;
  putImageData: Mock;
  beginPath: Mock;
  arc: Mock;
  stroke: Mock;
  moveTo: Mock;
  lineTo: Mock;
  imageSmoothingEnabled: boolean;
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
}

function createStub(canvas: HTMLCanvasElement): Canvas2DContextStub {
  return {
    canvas,
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    putImageData: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    imageSmoothingEnabled: true,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
  };
}

/** Handle returned by {@link installCanvas2DStub} for inspection and teardown. */
export interface CanvasStubHandle {
  /**
   * The (stable) stub 2D context bound to `canvas`, created on first request.
   * Repeated calls for the same element return the same object, matching how the
   * real `getContext("2d")` hands back one persistent context per canvas — so a
   * test can grab the context the component drew into and assert its calls.
   */
  contextFor(canvas: HTMLCanvasElement): Canvas2DContextStub;
  /** Restore the original `HTMLCanvasElement.prototype.getContext`. */
  restore(): void;
}

/**
 * Patch `HTMLCanvasElement.prototype.getContext` so `getContext("2d")` returns an
 * inspectable {@link Canvas2DContextStub} (one per canvas element). Any other
 * context id returns `null`, as jsdom already does.
 *
 * Call in `beforeEach` and `restore()` in `afterEach` so the patch never leaks
 * across test files.
 */
/**
 * Minimal `ImageData` stand-in. jsdom does not implement the `ImageData`
 * constructor, which canvas painters use to wrap raw RGBA bytes before a
 * `putImageData` blit. Only the shape the app touches (the `data`/`width`/
 * `height` fields) is modelled.
 */
class ImageDataStub {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(data: Uint8ClampedArray, width: number, height?: number) {
    this.data = data;
    this.width = width;
    this.height = height ?? data.length / 4 / width;
  }
}

export function installCanvas2DStub(): CanvasStubHandle {
  const contexts = new WeakMap<HTMLCanvasElement, Canvas2DContextStub>();
  const original = HTMLCanvasElement.prototype.getContext;

  // jsdom omits `ImageData`; install the shim only when it is genuinely missing
  // so a real implementation is never clobbered.
  const installedImageData = !("ImageData" in globalThis);
  if (installedImageData) {
    (globalThis as unknown as { ImageData: typeof ImageDataStub }).ImageData = ImageDataStub;
  }

  const contextFor = (canvas: HTMLCanvasElement): Canvas2DContextStub => {
    let ctx = contexts.get(canvas);
    if (!ctx) {
      ctx = createStub(canvas);
      contexts.set(canvas, ctx);
    }
    return ctx;
  };

  HTMLCanvasElement.prototype.getContext = function getContext(
    this: HTMLCanvasElement,
    contextId: string
  ): RenderingContext | null {
    if (contextId === "2d") {
      return contextFor(this) as unknown as CanvasRenderingContext2D;
    }
    return null;
  } as HTMLCanvasElement["getContext"];

  return {
    contextFor,
    restore() {
      HTMLCanvasElement.prototype.getContext = original;
      if (installedImageData) {
        delete (globalThis as unknown as { ImageData?: typeof ImageDataStub }).ImageData;
      }
    },
  };
}
