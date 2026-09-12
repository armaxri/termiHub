// MUST be first: sanitises an invalid `navigator.language` (e.g. `"C"` on a
// POSIX-locale Linux host) before any module reads it at evaluation time —
// notably `uplot`, whose module-scope `new Intl.NumberFormat(navigator.language)`
// would otherwise crash the whole bundle before React mounts (#2646).
import "./utils/ensureValidLocale";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
import { installCspViolationReporter } from "./security/cspViolationReporter";
import { installGlobalErrorHandlers } from "./utils/globalErrorHandlers";

// Surface any Content-Security-Policy violation (LogViewer + a bridge-readable
// DOM sink) so a real-build boot/render check can assert the shipped CSP does
// not block anything the app needs (#2059). Inert unless the browser blocks a
// resource; installed before React mounts so early violations are captured.
installCspViolationReporter();

// Route unhandled promise rejections and uncaught errors into the frontend
// ERROR channel (the user-openable LogViewer) so the whole fire-and-forget
// failure class stops vanishing into the unreachable DevTools console. Wired
// before React mounts so early failures are captured (ERR-002).
installGlobalErrorHandlers();

// Preload the editor's TextMate grammars (Shiki) in the background — but via a
// deferred dynamic import, and only once the app is idle (PERF-001). This keeps
// monaco-editor + Shiki out of the eager entry chunk (they are fetched as a
// separate chunk), so cold start / time-to-interactive no longer pays the
// editor's download+parse+eval cost up front on the common terminal-only path.
// Editors show uncoloured text briefly until the grammars are ready — the same
// behaviour as before, just started after first paint instead of at module eval.
const preloadEditorGrammars = (): void => {
  void import("./utils/monacoCustomLanguages").then((m) => m.registerCustomMonacoLanguages());
};
if (typeof requestIdleCallback === "function") {
  requestIdleCallback(preloadEditorGrammars);
} else {
  // WKWebView on older macOS lacks requestIdleCallback; defer past first paint.
  setTimeout(preloadEditorGrammars, 0);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
