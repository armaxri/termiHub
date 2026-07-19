import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { defaultHighlightingConfig } from "@/services/syntaxHighlightingConfig";
import { createCustomRule } from "@/services/customHighlightRules";
import type { HighlightRule, SyntaxHighlightingConfig } from "@/types/syntaxHighlighting";
import { CustomRuleEditor } from "./CustomRuleEditor";

let container: HTMLDivElement;
let root: Root;

function render(props: { rule?: HighlightRule; config?: SyntaxHighlightingConfig } = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  act(() => {
    root.render(
      <CustomRuleEditor
        config={props.config ?? defaultHighlightingConfig()}
        rule={props.rule}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  });
  return { onSave, onCancel };
}

function byTestId(id: string): HTMLElement {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
}

function setInput(el: HTMLElement, value: string) {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CustomRuleEditor", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders name, pattern and preview for a new rule", () => {
    render();
    expect(byTestId("custom-rule-name")).not.toBeNull();
    expect(byTestId("custom-rule-pattern")).not.toBeNull();
    expect(byTestId("custom-rule-preview")).not.toBeNull();
    // The sample preview text is present.
    expect(byTestId("custom-rule-preview").textContent).toContain("cat server.log");
  });

  it("disables Save until a name and valid pattern are entered", () => {
    render();
    const save = byTestId("custom-rule-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    setInput(byTestId("custom-rule-name"), "TODO markers");
    setInput(byTestId("custom-rule-pattern"), "TODO");
    expect((byTestId("custom-rule-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows an error and blocks Save for an invalid regex", () => {
    render();
    setInput(byTestId("custom-rule-name"), "bad");
    setInput(byTestId("custom-rule-pattern"), "(unclosed");
    expect(container.textContent).toMatch(/invalid regular expression/i);
    expect((byTestId("custom-rule-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks Save for a catastrophic-backtracking pattern", () => {
    render();
    setInput(byTestId("custom-rule-name"), "danger");
    setInput(byTestId("custom-rule-pattern"), "(a+)+$");
    expect(container.textContent).toMatch(/backtracking|redos|slow/i);
    expect((byTestId("custom-rule-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls onSave with a trimmed, normalized rule", () => {
    const { onSave } = render();
    setInput(byTestId("custom-rule-name"), "  TODO  ");
    setInput(byTestId("custom-rule-pattern"), "TODO");
    act(() => byTestId("custom-rule-save").click());

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as HighlightRule;
    expect(saved.name).toBe("TODO");
    expect(saved.pattern).toBe("TODO");
    expect(saved.builtin).toBe(false);
    expect(saved.enabled).toBe(true);
    expect(saved.style.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("calls onCancel without saving", () => {
    const { onCancel, onSave } = render();
    act(() => byTestId("custom-rule-cancel").click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("pre-fills fields when editing an existing rule", () => {
    const rule = createCustomRule({
      name: "Existing",
      pattern: "foo",
      style: { color: "#ff0000" },
    });
    render({ rule });
    expect((byTestId("custom-rule-name") as HTMLInputElement).value).toBe("Existing");
    expect((byTestId("custom-rule-pattern") as HTMLInputElement).value).toBe("foo");
  });

  it("highlights matching text in the preview", () => {
    render();
    // A pattern that matches the sample's "ERROR" keyword.
    setInput(byTestId("custom-rule-name"), "errors");
    setInput(byTestId("custom-rule-pattern"), "ERROR");
    const preview = byTestId("custom-rule-preview");
    const colored = Array.from(preview.querySelectorAll("span")).find(
      (s) => s.textContent === "ERROR" && s.style.color !== ""
    );
    expect(colored).toBeDefined();
  });
});
