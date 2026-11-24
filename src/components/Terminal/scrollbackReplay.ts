/**
 * The part of a live output chunk that a scrollback replay does not hold yet
 * (#5990), or `null` when it holds all of it.
 *
 * `offset` is where the chunk starts in the session's output stream and
 * `replayEnd` where the replay ends. Positions decide, never the text: output
 * that repeats the end of the replay is still new output.
 */
export function afterReplay(
  data: Uint8Array,
  offset: number,
  replayEnd: number
): Uint8Array | null {
  if (!(offset < replayEnd)) return data;
  const known = replayEnd - offset;
  return known < data.length ? data.subarray(known) : null;
}
