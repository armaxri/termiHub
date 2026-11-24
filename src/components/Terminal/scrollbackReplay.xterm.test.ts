/**
 * A replay and the live output after it join byte for byte in the real
 * terminal, also where the replay ends inside a character or an escape
 * sequence (#5990).
 */
import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/xterm";
import { afterReplay } from "./scrollbackReplay";

async function screen(replay: Uint8Array, live: Uint8Array): Promise<string> {
  const xterm = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  const write = (data: Uint8Array) => new Promise<void>((resolve) => xterm.write(data, resolve));
  await write(replay);
  // The agent sends the whole buffer again, and then goes on.
  const fresh = afterReplay(live, { offset: 0, epoch: 1 }, { endOffset: replay.length, epoch: 1 });
  if (fresh) await write(fresh);
  const line = xterm.buffer.active.getLine(0);
  const text = line?.translateToString(true) ?? "";
  const colours = Array.from({ length: text.length }, (_, i) => line?.getCell(i)?.getFgColor());
  xterm.dispose();
  return `${text}|${colours.join(",")}`;
}

describe("a replay that ends in the middle of", () => {
  for (const [name, text] of [
    ["a two-byte character", "café ok"],
    ["an emoji", "a\u{1f680}b"],
    ["a colour sequence", "\x1b[38;5;196mred\x1b[0m plain"],
    ["a title sequence", "\x1b]0;title\x07after"],
  ]) {
    it(`${name} shows the same as one write, wherever it ends`, async () => {
      const all = new TextEncoder().encode(text);
      const whole = await screen(all, all);
      for (let end = 0; end <= all.length; end += 1) {
        expect(await screen(all.subarray(0, end), all), `split at ${end}`).toBe(whole);
      }
    });
  }
});
