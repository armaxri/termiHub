/**
 * Hand a large output batch to xterm in slices (#6074).
 *
 * xterm parses one `write` chunk in one go: its 12 ms budget is only checked
 * between chunks. A flood's batch (up to the flow-control high watermark) as a
 * single chunk therefore blocks the UI thread until all of it is parsed, seconds
 * on a slow machine, and neither a click nor Ctrl+C gets through meanwhile.
 * Sliced, xterm yields to input and painting between the slices.
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
 * and whether it was the batch's last.
 *
 * Returns what `target` refused (it threw) and the error, or `null` when it took
 * the whole batch. Slices taken before the refusal still report as parsed.
 */
export function writeSliced(
  target: SlicedWriteTarget,
  batch: Uint8Array,
  onParsed: (bytes: number, last: boolean) => void,
  sliceBytes: number = WRITE_SLICE_BYTES
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
