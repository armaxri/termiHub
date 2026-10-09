import { useMemo, useRef } from "react";
import {
  useForm,
  useWatch,
  type DefaultValues,
  type FieldValues,
  type Mode,
  type UseFormReturn,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { draftKey } from "@/utils/draftKey";

/**
 * Field errors from a zod parse, keyed by the issue path joined with `.`
 * (`"name"`, `"style.color"`, `"steps.0.text"`). When several issues share a
 * path, the first one wins — the order the schema reports them in.
 */
export type ZodFieldErrors = Record<string, string>;

/** The outcome of checking a value against a zod schema. */
export interface ZodValidity {
  /** Whether the value passed the schema. */
  valid: boolean;
  /** Per-path error messages; empty when `valid`. */
  errors: ZodFieldErrors;
}

/**
 * Validate `value` against `schema` synchronously and fold the issues into a
 * {@link ZodFieldErrors} map.
 */
export function validateWithZod(schema: z.ZodType, value: unknown): ZodValidity {
  const result = schema.safeParse(value);
  const errors: ZodFieldErrors = {};
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = issue.path.map(String).join(".");
      if (!(key in errors)) errors[key] = issue.message;
    }
  }
  return { valid: result.success, errors };
}

/**
 * Returns `value`, but keeps the previous reference while its contents are
 * unchanged. Contents are compared with {@link draftKey}, so key order and
 * `undefined` members do not count as changes. This gives a value that is
 * rebuilt on every render (a form snapshot, a merged draft) a stable identity
 * that `useMemo` / `useEffect` can depend on directly.
 */
export function useDeepStable<T>(value: T): T {
  const ref = useRef<{ key: string; value: T } | null>(null);
  const key = draftKey(value);
  if (ref.current === null || ref.current.key !== key) {
    ref.current = { key, value };
  }
  return ref.current.value;
}

/**
 * Memoised synchronous zod validity for a value that is rebuilt each render.
 * The parse only runs again when the schema changes or the value's contents
 * change.
 *
 * Most editors should use {@link useZodEditorForm}. Use this hook directly only
 * when the schema cannot exist before the form does, as in ConnectionEditor,
 * whose name-uniqueness schema depends on state declared after its form.
 */
export function useZodValidity(schema: z.ZodType, value: unknown): ZodValidity {
  const stable = useDeepStable(value);
  return useMemo(() => validateWithZod(schema, stable), [schema, stable]);
}

/** Options for {@link useZodEditorForm}. */
export interface UseZodEditorFormOptions<TValues extends FieldValues> {
  /**
   * Validates the form values. It also becomes the form's resolver, so
   * react-hook-form's own `fieldState.error` agrees with `errors`.
   */
  schema: z.ZodType<TValues, TValues>;
  /** The values the form starts with (and that `reset` restores later). */
  defaultValues: DefaultValues<TValues>;
  /** react-hook-form validation mode. Defaults to `"onChange"`. */
  mode?: Mode;
}

/** What {@link useZodEditorForm} returns. */
export interface ZodEditorForm<TValues extends FieldValues> extends ZodValidity {
  /** The react-hook-form instance (control, getValues, setValue, reset, ...). */
  form: UseFormReturn<TValues>;
  /**
   * A complete snapshot of the current form values. Its reference changes only
   * when a value changes, so it can go straight into a dependency list. It is
   * shared with react-hook-form's store; read it, never mutate it.
   */
  draft: TValues;
  /**
   * The schema's verdict on `draft`. Editors with state outside the form
   * (step lists, colour grids) AND their own checks onto it.
   */
  canSave: boolean;
}

/**
 * The shared react-hook-form + zod scaffold for editor dialogs and tabs
 * (UISF2-003, #4346).
 *
 * It wraps `useForm` with a `zodResolver`, subscribes to every field, and takes
 * a complete snapshot of the values on each render. It then validates the
 * snapshot synchronously against the schema. The editor gets errors and the Save
 * gate on the same render as the edit, and tests need not await
 * react-hook-form's async error state.
 *
 * Wire `errors[path]` into the matching `<Field error>` so the reason Save is
 * disabled is always visible (the #2467 "Save silently disabled" class).
 */
export function useZodEditorForm<TValues extends FieldValues>({
  schema,
  defaultValues,
  mode = "onChange",
}: UseZodEditorFormOptions<TValues>): ZodEditorForm<TValues> {
  const form = useForm<TValues>({
    defaultValues,
    resolver: zodResolver(schema),
    mode,
  });
  // Subscribe to every field so this hook re-renders on each edit. Then read the
  // values from `getValues()`: it always returns the complete set, including
  // fields no Controller registered, and it reflects `setValue` / `reset` at
  // once. `useWatch` can trail the seeded defaults by one render.
  useWatch({ control: form.control });
  const draft = useDeepStable(form.getValues());
  const validity = useMemo(() => validateWithZod(schema, draft), [schema, draft]);
  return { form, draft, ...validity, canSave: validity.valid };
}
