import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
import { registerCustomMonacoLanguages } from "./utils/monacoCustomLanguages";
import { installCspViolationReporter } from "./security/cspViolationReporter";

// Surface any Content-Security-Policy violation (LogViewer + a bridge-readable
// DOM sink) so a real-build boot/render check can assert the shipped CSP does
// not block anything the app needs (#2059). Inert unless the browser blocks a
// resource; installed before React mounts so early violations are captured.
installCspViolationReporter();

// Start loading TextMate grammars via Shiki in the background.
// Editors show uncoloured text briefly until the grammars are ready.
void registerCustomMonacoLanguages();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
