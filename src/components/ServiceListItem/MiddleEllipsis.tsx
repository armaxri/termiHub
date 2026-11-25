interface MiddleEllipsisProps {
  text: string;
}

/** How many of the last characters of a text without spaces always stay. */
const TAIL = 8;
/** How many may stay so that a text with spaces is not cut inside a word. */
const WORDS_TAIL = 16;

/** Where the part starts that always stays. */
function tailStart(text: string): number {
  const space = text.indexOf(" ", text.length - WORDS_TAIL);
  return space > 0 && space < text.length - TAIL ? space : text.length - TAIL;
}

/**
 * One line of `text` that loses its middle when it does not fit: the end of an
 * address (its port) and of a machine's name tell more than the middle. The text
 * itself stays whole, for selecting and for a screen reader.
 */
export function MiddleEllipsis({ text }: MiddleEllipsisProps) {
  if (text.length <= WORDS_TAIL) return <span className="middle-ellipsis">{text}</span>;
  const start = tailStart(text);
  return (
    <span className="middle-ellipsis">
      <span className="middle-ellipsis__head">{text.slice(0, start)}</span>
      <span className="middle-ellipsis__tail">{text.slice(start)}</span>
    </span>
  );
}
