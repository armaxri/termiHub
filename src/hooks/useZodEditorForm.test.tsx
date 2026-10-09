import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, useState } from "react";
import { createRoot, Root } from "react-dom/client";
import { z } from "zod";
import {
  useDeepStable,
  useZodEditorForm,
  useZodValidity,
  validateWithZod,
  type ZodEditorForm,
  type ZodValidity,
} from "./useZodEditorForm";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const schema = z
  .object({
    name: z.string(),
    steps: z.array(z.object({ text: z.string() })),
  })
  .superRefine((v, ctx) => {
    if (v.name.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["name"], message: "Name is required." });
      ctx.addIssue({ code: "custom", path: ["name"], message: "A second name issue." });
    }
    v.steps.forEach((step, i) => {
      if (step.text === "") {
        ctx.addIssue({ code: "custom", path: ["steps", i, "text"], message: "Step is empty." });
      }
    });
  });

type Values = z.infer<typeof schema>;

describe("validateWithZod", () => {
  it("returns valid with no errors for a passing value", () => {
    expect(validateWithZod(schema, { name: "x", steps: [] })).toEqual({ valid: true, errors: {} });
  });

  it("keys errors by the dotted issue path and keeps the first issue per path", () => {
    const result = validateWithZod(schema, { name: " ", steps: [{ text: "ok" }, { text: "" }] });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual({
      name: "Name is required.",
      "steps.1.text": "Step is empty.",
    });
  });
});

describe("useDeepStable", () => {
  it("keeps the reference while the contents are equal, and swaps it on a change", () => {
    const seen: unknown[] = [];
    function Probe({ value }: { value: unknown }) {
      seen.push(useDeepStable(value));
      return null;
    }
    const first = { a: 1, b: { c: [1, 2] } };
    act(() => root.render(<Probe value={first} />));
    // Same contents, new object, different key order: same reference back.
    act(() => root.render(<Probe value={{ b: { c: [1, 2] }, a: 1 }} />));
    expect(seen[1]).toBe(first);
    // An `undefined` member does not count as a change.
    act(() => root.render(<Probe value={{ a: 1, b: { c: [1, 2] }, d: undefined }} />));
    expect(seen[2]).toBe(first);
    // A real change (array order counts) yields the new value.
    const changed = { a: 1, b: { c: [2, 1] } };
    act(() => root.render(<Probe value={changed} />));
    expect(seen[3]).toBe(changed);
  });
});

describe("useZodValidity", () => {
  it("re-validates when the schema changes even if the value does not", () => {
    let latest: ZodValidity | undefined;
    const lenient = z.object({ name: z.string() });
    const strict = z.object({ name: z.string().min(3, "Too short.") });
    function Probe({ s }: { s: z.ZodType }) {
      latest = useZodValidity(s, { name: "ab" });
      return null;
    }
    act(() => root.render(<Probe s={lenient} />));
    expect(latest).toEqual({ valid: true, errors: {} });
    act(() => root.render(<Probe s={strict} />));
    expect(latest).toEqual({ valid: false, errors: { name: "Too short." } });
  });
});

describe("useZodEditorForm", () => {
  let api: ZodEditorForm<Values> | undefined;
  let bump: (() => void) | undefined;

  function Editor({ defaults }: { defaults: Values }) {
    const [, setTick] = useState(0);
    bump = () => setTick((t) => t + 1);
    api = useZodEditorForm<Values>({ schema, defaultValues: defaults });
    return null;
  }

  it("validates the seeded defaults on the first render", () => {
    act(() => root.render(<Editor defaults={{ name: "", steps: [{ text: "ls" }] }} />));
    expect(api!.draft).toEqual({ name: "", steps: [{ text: "ls" }] });
    expect(api!.valid).toBe(false);
    expect(api!.canSave).toBe(false);
    expect(api!.errors).toEqual({ name: "Name is required." });
  });

  it("updates errors and canSave on the same render as a setValue", () => {
    act(() => root.render(<Editor defaults={{ name: "", steps: [{ text: "ls" }] }} />));
    act(() => api!.form.setValue("name", "Deploy"));
    expect(api!.draft.name).toBe("Deploy");
    expect(api!.errors).toEqual({});
    expect(api!.canSave).toBe(true);

    act(() => api!.form.setValue("steps.0.text", ""));
    expect(api!.errors).toEqual({ "steps.0.text": "Step is empty." });
    expect(api!.canSave).toBe(false);
  });

  it("reflects a reset in the draft and the validity", () => {
    act(() => root.render(<Editor defaults={{ name: "", steps: [] }} />));
    act(() => api!.form.reset({ name: "Loaded", steps: [{ text: "pwd" }] }));
    expect(api!.draft).toEqual({ name: "Loaded", steps: [{ text: "pwd" }] });
    expect(api!.valid).toBe(true);
  });

  it("keeps the draft and errors references across a re-render with no value change", () => {
    act(() => root.render(<Editor defaults={{ name: "", steps: [] }} />));
    const { draft, errors } = api!;
    act(() => bump!());
    expect(api!.draft).toBe(draft);
    expect(api!.errors).toBe(errors);
  });
});
