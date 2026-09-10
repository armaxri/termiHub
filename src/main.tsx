// MUST be first: sanitises an invalid `navigator.language` (e.g. `"C"` on a
// POSIX-locale Linux host) before any module reads it at evaluation time —
// notably `uplot`, whose module-scope `new Intl.NumberFormat(navigator.language)`
// would otherwise crash the whole bundle before React mounts (#2646).
import "./utils/ensureValidLocale";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
import { registerCustomMonacoLanguages } from "./utils/monacoCustomLanguages";
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

// Start loading TextMate grammars via Shiki in the background.
// Editors show uncoloured text briefly until the grammars are ready.
void registerCustomMonacoLanguages();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
