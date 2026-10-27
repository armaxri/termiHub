import { describe, it, expect, vi } from "vitest";
import { MAX_EMOJI_VERSION, resolveBundledEmojiData, toEmojiData } from "./emojiPickerData";

describe("resolveBundledEmojiData (#5008)", () => {
  it("serves the bundled Emojibase data without any network fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = await resolveBundledEmojiData("en", {});
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    expect(data.locale).toBe("en");
    expect(data.emojis.length).toBeGreaterThan(1500);
    const labels = data.categories.map((c) => c.label);
    expect(labels).toContain("Smileys & emotion");
    expect(labels).not.toContain("Components");
  });

  it("maps skin tones, flags and caps the emoji version", async () => {
    const data = await resolveBundledEmojiData("en", {});
    const wave = data.emojis.find((e) => e.emoji === "👋")!;
    expect(wave.skins?.light).toBe("👋🏻");
    expect(wave.skins?.dark).toBe("👋🏿");
    expect(data.emojis.find((e) => e.emoji === "🇩🇪")?.countryFlag).toBe(true);
    expect(data.emojis.every((e) => e.version <= MAX_EMOJI_VERSION)).toBe(true);
    expect(Object.keys(data.skinTones).sort()).toEqual(
      ["dark", "light", "medium", "medium-dark", "medium-light"].sort()
    );
  });

  it("drops emoji outside known categories", () => {
    const data = toEmojiData(
      [
        { emoji: "a", label: "kept", group: 0, version: 1 },
        { emoji: "b", label: "component", group: 2, version: 1 },
        { emoji: "c", label: "no group", version: 1 },
        { emoji: "d", label: "too new", group: 0, version: MAX_EMOJI_VERSION + 1 },
      ],
      {
        groups: [
          { key: "smileys-emotion", message: "smileys & emotion", order: 0 },
          { key: "component", message: "components", order: 2 },
        ],
        subgroups: [],
        skinTones: [],
      }
    );
    expect(data.emojis.map((e) => e.label)).toEqual(["Kept"]);
  });
});
