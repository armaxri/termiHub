import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRevealedErrors, type RevealedErrors } from "./useRevealedErrors";
import type { ZodFieldErrors } from "./useZodEditorForm";

interface Values {
  name: string;
  steps: { text: string }[];
}

/** Errors a schema would report for `values`. */
function errorsOf(values: Values): ZodFieldErrors {
  const errors: ZodFieldErrors = {};
  if (!(values.name ?? "").trim()) errors["name"] = "Name is required.";
  values.steps.forEach((s, i) => {
    if (!s.text) errors[`steps.${i}.text`] = "Text is required.";
  });
  return errors;
}

let container: HTMLDivElement;
let root: Root;
let api: RevealedErrors;
let setValues: (v: Values) => void;

function Harness({ initial, showAll }: { initial: Values; showAll?: boolean }) {
  const [values, set] = useState(initial);
  setValues = set;
  api = useRevealedErrors(errorsOf(values), values, showAll);
  return <div data-testid="root" {...api.revealProps} />;
}

function render(initial: Values, showAll = false): void {
  act(() => root.render(<Harness initial={initial} showAll={showAll} />));
}

function blur(): void {
  act(() => {
    container
      .querySelector('[data-testid="root"]')!
      .dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

const EMPTY: Values = { name: "", steps: [{ text: "" }, { text: "" }] };

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useRevealedErrors (#5909)", () => {
  it("shows nothing for a pristine form, even after a blur", () => {
    render(EMPTY);
    expect(api.shown).toEqual({});
    blur();
    expect(api.shown).toEqual({});
  });

  it("shows an edited field's error only after it is left", () => {
    render(EMPTY);
    act(() => setValues({ ...EMPTY, name: "x" }));
    act(() => setValues({ ...EMPTY, name: "" }));
    expect(api.shown).toEqual({});
    blur();
    expect(api.shown).toEqual({ name: "Name is required." });
  });

  it("reveals nested paths per leaf, not the whole list", () => {
    render({ name: "ok", steps: [{ text: "" }, { text: "" }] });
    act(() => setValues({ name: "ok", steps: [{ text: "" }, { text: "a" }] }));
    act(() => setValues({ name: "ok", steps: [{ text: "" }, { text: "" }] }));
    blur();
    expect(api.shown).toEqual({ "steps.1.text": "Text is required." });
  });

  it("reveals everything on revealAll, and with showAll", () => {
    render(EMPTY);
    act(() => api.revealAll());
    expect(Object.keys(api.shown)).toEqual(["name", "steps.0.text", "steps.1.text"]);

    act(() => root.unmount());
    root = createRoot(container);
    render(EMPTY, true);
    expect(Object.keys(api.shown)).toHaveLength(3);
  });

  it("does not count a blank value turning into another blank as an edit", () => {
    render(EMPTY);
    act(() => setValues({ ...EMPTY, name: null as unknown as string }));
    blur();
    expect(api.shown).toEqual({});
  });

  it("forgets edits and reveals on rebaseline", () => {
    render(EMPTY);
    act(() => setValues({ ...EMPTY, name: "x" }));
    act(() => setValues({ ...EMPTY, name: "" }));
    act(() => api.revealAll());
    blur();
    expect(api.shown).not.toEqual({});
    act(() => api.rebaseline());
    act(() => setValues({ name: "", steps: [] }));
    blur();
    expect(api.shown).toEqual({});
  });
});
