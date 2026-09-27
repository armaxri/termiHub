import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Zod 4 probes for eval support with `new Function("")` the first time it
 * parses an object schema. Under the shipped CSP (no `'unsafe-eval'`) that probe
 * is refused and fires a `securitypolicyviolation` event, which the CSP guard
 * (#2059) counts as a violation. `jitless` skips the probe (#3627).
 */
describe("zod runs jitless under the CSP", () => {
  it("sets zod's global jitless flag when the module is imported", async () => {
    await import("./zodJitless");
    expect(z.config().jitless).toBe(true);
  });

  it("never probes eval with new Function while parsing an object schema", async () => {
    await import("./zodJitless");
    const original = globalThis.Function;
    const probe = vi.fn();
    globalThis.Function = new Proxy(original, {
      construct(target, args) {
        probe(args);
        return Reflect.construct(target, args);
      },
    });
    try {
      const schema = z.object({ host: z.string(), port: z.number() });
      expect(schema.parse({ host: "h", port: 22 })).toEqual({ host: "h", port: 22 });
    } finally {
      globalThis.Function = original;
    }
    expect(probe).not.toHaveBeenCalled();
  });
});
