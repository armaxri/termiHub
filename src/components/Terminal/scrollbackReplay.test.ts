import { describe, it, expect } from "vitest";
import { afterReplay, NO_REPLAY } from "./scrollbackReplay";

const bytes = (text: string) => new TextEncoder().encode(text);
const at = (offset: number, epoch = 2) => ({ offset, epoch });
const end = (endOffset: number) => ({ endOffset, epoch: 2 });

describe("afterReplay", () => {
  it("passes a chunk that starts at or after the end of the replay", () => {
    const data = bytes("abc");
    expect(afterReplay(data, at(5), end(5))).toBe(data);
    expect(afterReplay(data, at(9), end(5))).toBe(data);
  });

  it("drops a chunk the replay holds", () => {
    expect(afterReplay(bytes("abc"), at(2), end(5))).toBeNull();
    expect(afterReplay(bytes("abc"), at(0), end(100))).toBeNull();
    expect(afterReplay(bytes(""), at(4), end(5))).toBeNull();
  });

  it("keeps the rest of a chunk the replay ends inside", () => {
    expect(afterReplay(bytes("abcdef"), at(2), end(5))).toEqual(bytes("def"));
  });

  it("passes a newer stream and drops an older one, whatever the offset", () => {
    const data = bytes("abc");
    expect(afterReplay(data, at(0, 3), end(5))).toBe(data);
    expect(afterReplay(data, at(99, 1), end(5))).toBeNull();
  });

  it("passes everything when nothing was replayed", () => {
    const data = bytes("abc");
    expect(afterReplay(data, at(0, 1), NO_REPLAY)).toBe(data);
  });
});
