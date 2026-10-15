import React, { useCallback, useRef, useState } from "react";
import { Tooltip } from "./Tooltip";
import "./ui.css";

/** Props for {@link TruncatedText}. */
export interface TruncatedTextProps {
  /** The text (single line). */
  children: React.ReactNode;
  /** Tooltip content; defaults to `children`. */
  tooltip?: React.ReactNode;
  /** Preferred tooltip side. Defaults to `"top"`. */
  side?: "top" | "bottom" | "left" | "right";
  /** Extra class(es) appended to `ui-truncate`. */
  className?: string;
  /** Test hook for the text element. */
  "data-testid"?: string;
}

/**
 * A single-line label that ellipsizes when it does not fit and then — only
 * then — reveals the full text in the shared {@link Tooltip} on hover (#4709).
 * An untruncated label shows no tooltip, so short names stay quiet. The full
 * text is always in the DOM, so screen readers never hear the ellipsis.
 *
 * The tooltip is only mounted once a hover has found the text clipped, so a
 * plain label costs no Radix tooltip root (and needs no provider) until then.
 */
export function TruncatedText({
  children,
  tooltip,
  side = "top",
  className,
  "data-testid": testId,
}: TruncatedTextProps): React.ReactElement {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);

  const isClipped = useCallback(() => {
    const el = ref.current;
    return !!el && el.scrollWidth > el.clientWidth;
  }, []);

  const handlePointerEnter = useCallback(() => {
    if (!armed && isClipped()) setArmed(true);
  }, [armed, isClipped]);

  const handleOpenChange = useCallback(
    (next: boolean) => setOpen(next && isClipped()),
    [isClipped]
  );

  const text = (
    <span
      ref={ref}
      className={["ui-truncate", className ?? ""].filter(Boolean).join(" ")}
      data-testid={testId}
      onPointerEnter={handlePointerEnter}
    >
      {children}
    </span>
  );

  if (!armed) return text;
  return (
    <Tooltip content={tooltip ?? children} side={side} open={open} onOpenChange={handleOpenChange}>
      {text}
    </Tooltip>
  );
}
