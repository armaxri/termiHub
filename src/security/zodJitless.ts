/**
 * Run zod without its JIT (#3627).
 *
 * Zod 4 checks whether it may compile parsers with `new Function` by trying
 * `new Function("")` the first time it parses an object schema. The shipped CSP
 * has no `'unsafe-eval'`, so the webview refuses the probe and fires a
 * `securitypolicyviolation` event that the CSP violation reporter (#2059)
 * surfaces. The probe's fallback is the same interpreted parser `jitless`
 * selects, so turning the JIT off changes no behaviour — it only stops the
 * refused eval attempt. Imported first thing in `main.tsx`, before any schema
 * is parsed.
 */
import { z } from "zod";

z.config({ jitless: true });
