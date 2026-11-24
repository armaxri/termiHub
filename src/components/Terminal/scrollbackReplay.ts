import type { OutputPosition } from "@/services/events";

/** Where a scrollback replay ends: the position after its last byte. */
export interface ReplayEnd {
  /** The output stream it was taken from. */
  epoch: number;
  endOffset: number;
}

/** No replay was shown: all live output is new. */
export const NO_REPLAY: ReplayEnd = { epoch: 0, endOffset: 0 };

/**
 * The part of a live output chunk that a scrollback replay does not hold yet
 * (#5990), or `null` when it holds all of it.
 *
 * Positions decide, never the text: output that repeats the end of the replay
 * is still new output. A session created again under the same id starts a new
 * stream (a larger epoch) that the replay holds nothing of; output of an older
 * stream came before it.
 */
export function afterReplay(
  data: Uint8Array,
  position: OutputPosition,
  replay: ReplayEnd
): Uint8Array | null {
  if (replay === NO_REPLAY) return data;
  const { epoch, offset } = position;
  if (epoch > replay.epoch) return data;
  if (epoch < replay.epoch) return null;
  if (offset >= replay.endOffset) return data;
  const known = replay.endOffset - offset;
  return known < data.length ? data.subarray(known) : null;
}
