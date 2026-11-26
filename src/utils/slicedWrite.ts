/**
 * Hand a large output batch to xterm in slices (#6074).
 *
 * xterm parses one `write` chunk in one go: its 12 ms budget is only checked
 * between chunks. A flood's batch (up to the flow-control high watermark) as a
 * single chunk therefore blocks the UI thread until all of it is parsed, seconds
 * on a slow machine, and neither a click nor Ctrl+C gets through meanwhile.
 * Sliced, xterm yields to input and painting between the slices.
 *
 * Each yield costs a timer turn, and webviews throttle those to about one a
 * second while the document is hidden: a flood there would hold back its program
 * (a build in a minimised window) for nobody's benefit. So a hidden document's
 * batch is one chunk, parsed in one turn. A batch already handed over when the
 * window is hidden drains at the throttled pace; the next one does not.
 */

/** The part of xterm's `Terminal` this needs. */
export interface SlicedWriteTarget {
  write(data: Uint8Array, callback?: () => void): void;
}

/** Bytes per xterm write chunk: what a slow machine parses in a fraction of a second. */
export const WRITE_SLICE_BYTES = 16 * 1024;

/**
 * Write `batch` to `target` in order, in slices of at most `sliceBytes`.
 * `onParsed` is called per slice once xterm has parsed it, with the slice's size
 * and whether it was the batch's last. While the document is hidden the batch is
 * one slice (see above).
 *
 * Returns what `target` refused (it threw) and the error, or `null` when it took
 * the whole batch. Slices taken before the refusal still report as parsed.
 */
export function writeSliced(
  target: SlicedWriteTarget,
  batch: Uint8Array,
  onParsed: (bytes: number, last: boolean) => void,
  sliceBytes: number = document.hidden ? Infinity : WRITE_SLICE_BYTES
): { refused: Uint8Array; error: unknown } | null {
  for (let at = 0; at < batch.length; at += sliceBytes) {
    const slice = batch.length <= sliceBytes ? batch : batch.subarray(at, at + sliceBytes);
    const last = at + sliceBytes >= batch.length;
    try {
      target.write(slice, () => onParsed(slice.length, last));
    } catch (error) {
      return { refused: batch.subarray(at), error };
    }
  }
  return null;
}

/** `text` in slices of at most `size` code units, never inside a surrogate pair. */
function textSlices(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const slices: string[] = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + size, text.length);
    // A high surrogate at the end belongs with the low one after it.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    slices.push(text.slice(at, end));
    at = end;
  }
  return slices;
}

/** The part of xterm's `Terminal` {@link writeAllSliced} needs: bytes or text. */
export interface SlicedTextWriteTarget {
  write(data: Uint8Array | string, callback?: () => void): void;
}

/**
 * Write a whole scrollback (a repaint, a replay, a snapshot) to `target` in slices
 * (#6087), and call `done` once xterm has parsed all of it. All slices are handed over
 * at once, so whatever is written after them still comes after them. Not sliced while
 * the document is hidden, like {@link writeSliced}. Throws what `target` refused, as
 * one large write did.
 */
export function writeAllSliced(
  target: SlicedTextWriteTarget,
  data: Uint8Array | string,
  done: () => void,
  sliceSize: number = document.hidden ? Infinity : WRITE_SLICE_BYTES
): void {
  if (typeof data !== "string") {
    if (data.length === 0) {
      target.write(data, done);
      return;
    }
    const refused = writeSliced(target, data, (_n, last) => last && done(), sliceSize);
    if (refused) throw refused.error;
    return;
  }
  const slices = textSlices(data, sliceSize);
  slices.forEach((slice, i) => target.write(slice, i === slices.length - 1 ? done : undefined));
}

/** {@link writeAllSliced} as a promise: resolves once all of it is parsed. */
export function writeAllSlicedAsync(
  target: SlicedTextWriteTarget,
  data: Uint8Array | string
): Promise<void> {
  return new Promise<void>((resolve) => writeAllSliced(target, data, resolve));
}
