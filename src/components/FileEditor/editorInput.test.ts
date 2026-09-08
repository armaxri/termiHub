import { describe, it, expect } from "vitest";
import { EDITOR_INPUT_TESTID, findMonacoInput, tagMonacoInput } from "./editorInput";

/**
 * Build a fake Monaco editor DOM node containing the given hidden-input element,
 * mirroring the two shapes Monaco produces depending on `EditContext` support.
 */
function editorDomNode(inputHtml: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "monaco-editor";
  node.innerHTML = `<div class="overflow-guard">${inputHtml}</div>`;
  return node;
}

describe("Monaco hidden-input tagging (#2689)", () => {
  it("tags the textarea input on engines without EditContext (WebKitGTK / WKWebView)", () => {
    const node = editorDomNode(`<textarea class="inputarea"></textarea>`);
    tagMonacoInput(node);
    const input = node.querySelector("textarea.inputarea")!;
    expect(input.getAttribute("data-testid")).toBe(EDITOR_INPUT_TESTID);
  });

  it("tags the native-edit-context div on EditContext engines (WebView2 / Chromium)", () => {
    // Regression for #2689: on WebView2, Monaco powers input through a
    // `<div class="native-edit-context">`, not a `textarea.inputarea`, so the
    // textarea-only selector left `editor-input` unset and the harness could
    // not find the editor input at all.
    const node = editorDomNode(`<div class="native-edit-context"></div>`);
    tagMonacoInput(node);
    const input = node.querySelector(".native-edit-context")!;
    expect(input.getAttribute("data-testid")).toBe(EDITOR_INPUT_TESTID);
  });

  it("finds whichever input element the engine created", () => {
    expect(
      findMonacoInput(editorDomNode(`<textarea class="inputarea"></textarea>`))
    ).not.toBeNull();
    expect(
      findMonacoInput(editorDomNode(`<div class="native-edit-context"></div>`))
    ).not.toBeNull();
  });

  it("does not tag the IME helper textarea of the native edit context", () => {
    // The native edit context also mounts a hidden `<textarea class="ime-text-area">`;
    // the addressable input is the div, so the textarea selector must not match it.
    const node = editorDomNode(
      `<div class="native-edit-context"></div><textarea class="ime-text-area"></textarea>`
    );
    tagMonacoInput(node);
    expect(node.querySelector("textarea.ime-text-area")!.getAttribute("data-testid")).toBeNull();
    expect(node.querySelector(".native-edit-context")!.getAttribute("data-testid")).toBe(
      EDITOR_INPUT_TESTID
    );
  });

  it("is a no-op when the node or input is absent", () => {
    expect(() => tagMonacoInput(null)).not.toThrow();
    expect(() => tagMonacoInput(undefined)).not.toThrow();
    expect(findMonacoInput(editorDomNode(`<span></span>`))).toBeNull();
  });
});
