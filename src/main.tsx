import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
import { registerCustomMonacoLanguages } from "./utils/monacoCustomLanguages";

// Start loading TextMate grammars via Shiki in the background.
// Editors show uncoloured text briefly until the grammars are ready.
void registerCustomMonacoLanguages();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
