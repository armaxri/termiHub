import { useEffect, useRef } from "react";

/**
 * Autofocus a form/tool's primary input on mount and, when it carries a
 * prefilled value, text-select that value so the user's first keystroke
 * replaces it.
 *
 * Attach the returned ref to the primary `<input>` (or `<textarea>`). Focus and
 * selection run once on mount — panels that mount only when their tab becomes
 * visible (the Network Tools panels) therefore focus exactly when opened.
 *
 * @returns a ref to place on the primary input element.
 */
export function useAutofocusSelect<
  T extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement,
>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select any prefilled text so typing overwrites it rather than appending.
    if (el.value) el.select();
  }, []);

  return ref;
}
