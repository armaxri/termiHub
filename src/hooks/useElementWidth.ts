import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Track the content-box width of an element with a `ResizeObserver` (#4709).
 *
 * Returns a callback ref to attach to the element and its last observed width
 * in CSS pixels. The width is `null` until the first observation arrives — and
 * stays `null` where no real layout exists (the jsdom test stub never fires) —
 * so callers should treat `null` as "unconstrained" and render their widest
 * layout. That keeps every existing test, which mounts without a layout engine,
 * on the same DOM it had before width-responsive rendering existed.
 *
 * @returns `[ref, width]` — attach `ref` to the measured element.
 */
export function useElementWidth<T extends HTMLElement = HTMLElement>(): [
  (node: T | null) => void,
  number | null,
] {
  const [width, setWidth] = useState<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const next = entry.contentRect.width;
      setWidth((prev) => (prev === next ? prev : next));
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    },
    []
  );

  return [ref, width];
}
