import { describe, it, expect } from "vitest";
import { afterReplay } from "./scrollbackReplay";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("afterReplay", () => {
  it("passes a chunk that starts at or after the end of the replay", () => {
    const data = bytes("abc");
    expect(afterReplay(data, 5, 5)).toBe(data);
    expect(afterReplay(data, 9, 5)).toBe(data);
    expect(afterReplay(data, 0, 0)).toBe(data);
  });

  it("drops a chunk the replay holds", () => {
    expect(afterReplay(bytes("abc"), 2, 5)).toBeNull();
    expect(afterReplay(bytes("abc"), 0, 100)).toBeNull();
    expect(afterReplay(bytes(""), 4, 5)).toBeNull();
  });

  it("keeps the rest of a chunk the replay ends inside", () => {
    expect(afterReplay(bytes("abcdef"), 2, 5)).toEqual(bytes("def"));
  });
});
