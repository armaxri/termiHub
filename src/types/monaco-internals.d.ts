/**
 * Types for the monaco-editor internals this app reaches into directly.
 *
 * `monaco-editor` ships `.d.ts` files only for its public API; its package
 * `exports` still expose every ESM module (`monaco-editor/<path>` →
 * `esm/vs/<path>.js`). Declare only what is used, and only as loosely as
 * needed — `webkitClipboardWrite.ts` checks the patched method at runtime.
 */
declare module "monaco-editor/platform/clipboard/browser/clipboardService" {
  /** Monaco's browser `IClipboardService` implementation (patched for #5383). */
  export class BrowserClipboardService {
    installWebKitWriteTextWorkaround?: unknown;
  }
}
