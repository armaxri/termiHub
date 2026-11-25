interface MiddleEllipsisProps {
  text: string;
  /** How many of the last characters always stay. */
  tail?: number;
}

/**
 * One line of `text` that loses its middle when it does not fit: the end of an
 * address (its port) and of a machine's name tell more than the middle. The text
 * itself stays whole, for selecting and for a screen reader.
 */
export function MiddleEllipsis({ text, tail = 8 }: MiddleEllipsisProps) {
  if (text.length <= tail * 2) return <span className="middle-ellipsis">{text}</span>;
  return (
    <span className="middle-ellipsis">
      <span className="middle-ellipsis__head">{text.slice(0, -tail)}</span>
      <span className="middle-ellipsis__tail">{text.slice(-tail)}</span>
    </span>
  );
}
