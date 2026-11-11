/**
 * Make Monaco's WebKit clipboard pre-arm rejection-safe (#5383).
 *
 * Imported for its side effect by `monacoEnvironment`, which every module that
 * pulls in `monaco-editor` imports first, so the patch is in place before
 * Monaco instantiates `BrowserClipboardService`. See `webkitClipboardWrite.ts`
 * for why the stock workaround leaks a `NotAllowedError` and an unhandled
 * `Canceled` rejection on every click.
 */

import { BrowserClipboardService } from "monaco-editor/platform/clipboard/browser/clipboardService";
import { patchWebKitClipboardWorkaround } from "./webkitClipboardWrite";

patchWebKitClipboardWorkaround(BrowserClipboardService);
