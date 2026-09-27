/**
 * Monaco web-worker wiring (#3632).
 *
 * monaco-editor 0.57 locates its editor worker (`editorWorkerService`) through
 * `new URL('…/editorWebWorkerMain.js', import.meta.url)`. Vite does not bundle
 * that reference: the 544-byte stub falls under `assetsInlineLimit` and is
 * inlined as a `data:text/javascript` URL. Loading it inside the worker violates
 * the shipped `script-src` (no `data:`), so the editor ran without its
 * background worker (diff computation, links, word-based suggestions) — and the
 * violation fires in the worker's global scope, where the document-level CSP
 * reporter never sees it.
 *
 * Setting `self.MonacoEnvironment.getWorker` makes Monaco construct every worker
 * from these Vite `?worker` imports instead. Each one is a real bundled file
 * served from `'self'`, so no `data:` URL and no CSP relaxation is needed.
 *
 * `getWorker` replaces Monaco's own per-language `createWorker` for **every**
 * label, so the language workers (css/html/json/ts) must be mapped here too.
 * Unknown labels fall back to the generic editor worker, as Monaco's own
 * bundler docs do.
 */

import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

type WorkerConstructor = new (options?: { name?: string }) => Worker;

/** Worker labels Monaco asks for, grouped by the bundled worker that serves them. */
const WORKERS_BY_LABEL: Record<string, WorkerConstructor> = {
  json: JsonWorker,
  css: CssWorker,
  scss: CssWorker,
  less: CssWorker,
  html: HtmlWorker,
  handlebars: HtmlWorker,
  razor: HtmlWorker,
  typescript: TsWorker,
  javascript: TsWorker,
};

/** The bundled worker constructor Monaco should use for `label`. */
export function monacoWorkerFor(label: string): WorkerConstructor {
  return WORKERS_BY_LABEL[label] ?? EditorWorker;
}

/** The `MonacoEnvironment` this app installs on the global scope. */
export const monacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    const WorkerCtor = monacoWorkerFor(label);
    return new WorkerCtor({ name: label });
  },
};

/**
 * Install {@link monacoEnvironment} on `self`. Idempotent; must run before the
 * first editor is created (it is imported for its side effect by every module
 * that pulls in `monaco-editor`).
 */
export function installMonacoEnvironment(): void {
  (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = monacoEnvironment;
}

installMonacoEnvironment();
