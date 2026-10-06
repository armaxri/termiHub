// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { UserConfig } from "vite";

type ViteConfigExport =
  | UserConfig
  | ((env: { command: string; mode: string }) => UserConfig | Promise<UserConfig>);

/**
 * The shipped CSP's `script-src` has no `data:`, so the production build must
 * never inline a script module as a `data:` URL (#3632). Vite's default 4 KiB
 * `assetsInlineLimit` did exactly that to the stub Monaco references through
 * `new URL('…/editorWebWorkerMain.js', import.meta.url)`.
 */
describe("vite build never inlines scripts as data: URLs (#3632)", () => {
  it("excludes script modules from assetsInlineLimit", async () => {
    // vite.config.ts belongs to tsconfig.node.json, not the src project, so it is
    // loaded untyped rather than through a static import.
    const configPath = "../../vite.config";
    const { default: viteConfig } = (await import(/* @vite-ignore */ configPath)) as {
      default: ViteConfigExport;
    };
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

/**
 * The CSP style-nonce bootstrap (#3115) must evaluate before the vendor chunks
 * that create `<style>` elements, so it lives in its own `csp-boot` chunk rather
 * than being inlined into the entry chunk (which runs after every vendor chunk).
 */
describe("vite build puts the CSP style-nonce bootstrap in its own chunk (#3115)", () => {
  it("routes the bootstrap modules to the csp-boot chunk", async () => {
    const configPath = "../../vite.config";
    const { default: viteConfig } = (await import(/* @vite-ignore */ configPath)) as {
      default: ViteConfigExport;
    };
    const resolved = await (typeof viteConfig === "function"
      ? viteConfig({ command: "build", mode: "production" })
      : viteConfig);
    const output = resolved.build?.rollupOptions?.output;
    const manualChunks = (Array.isArray(output) ? output[0] : output)?.manualChunks;
    expect(typeof manualChunks).toBe("function");
    const chunkOf = manualChunks as (id: string) => string | undefined;
    expect(chunkOf("/repo/src/security/styleNonce.ts")).toBe("csp-boot");
    expect(chunkOf("/repo/src/security/installStyleNonce.ts")).toBe("csp-boot");
    expect(chunkOf("/repo/src/security/styleNonce.test.ts")).toBeUndefined();
    expect(chunkOf("/repo/src/main.tsx")).toBeUndefined();
  });
});
