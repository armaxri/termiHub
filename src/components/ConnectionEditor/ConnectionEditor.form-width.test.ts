import { describe, it, expect } from "vitest";
import editorCss from "./ConnectionEditor.css?raw";
import variablesCss from "@/styles/variables.css?raw";

/** CSS-level guard for the editor's width cap (#5641); the live grade measures it. */
describe("ConnectionEditor form width cap (#5641)", () => {
  it("defines the form width cap and narrow input width as tokens", () => {
    expect(variablesCss).toMatch(/--form-max-width:\s*560px/);
    expect(variablesCss).toMatch(/--form-input-narrow-width:/);
  });

  it("caps the editor content with the token, not a magic number", () => {
    const rule = /\.connection-editor__content\s*\{([^}]*)\}/.exec(editorCss)?.[1] ?? "";
    expect(rule).toContain("var(--form-max-width)");
    expect(rule).not.toMatch(/max-width:\s*\d+px/);
  });
});
