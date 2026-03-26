import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
import { registerCustomMonacoLanguages } from "./utils/monacoCustomLanguages";
import { resetLanguageCache } from "./utils/monacoLanguages";

// Register custom Monaco languages (CMake, TOML, Nginx, Nix, Properties)
// before any editor mounts so language IDs resolve correctly.
registerCustomMonacoLanguages();
resetLanguageCache();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
