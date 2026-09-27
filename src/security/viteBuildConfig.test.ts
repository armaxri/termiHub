// @vitest-environment node
import { describe, expect, it } from "vitest";
import viteConfig from "../../vite.config";

/**
 * The shipped CSP's `script-src` has no `data:`, so the production build must
 * never inline a script module as a `data:` URL (#3632). Vite's default 4 KiB
 * `assetsInlineLimit` did exactly that to the stub Monaco references through
 * `new URL('…/editorWebWorkerMain.js', import.meta.url)`.
 */
describe("vite build never inlines scripts as data: URLs (#3632)", () => {
  it("excludes script modules from assetsInlineLimit", async () => {
    const resolved = await (typeof viteConfig === "function"
      ? viteConfig({ command: "build", mode: "production" })
      : viteConfig);
    const limit = resolved.build?.assetsInlineLimit;
    expect(typeof limit).toBe("function");
    const inline = limit as (filePath: string, content: Buffer) => boolean | undefined;
    expect(inline("/m/editorWebWorkerMain.js", Buffer.alloc(544))).toBe(false);
    expect(inline("/m/worker.mjs", Buffer.alloc(10))).toBe(false);
    expect(inline("/m/entry.ts", Buffer.alloc(10))).toBe(false);
    // Non-script assets keep Vite's default inlining.
    expect(inline("/m/icon.svg", Buffer.alloc(10))).toBeUndefined();
  });
});
