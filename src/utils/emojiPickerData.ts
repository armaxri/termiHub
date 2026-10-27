/**
 * Offline emoji data for the frimousse emoji picker (#5008).
 *
 * frimousse fetches Emojibase data from a CDN by default. termiHub must work
 * offline, so this resolver loads the same Emojibase dataset from the bundled
 * `emojibase-data` package instead — as a lazy chunk, only when a picker opens
 * — and maps it to frimousse's `EmojiData` shape the way its default resolver
 * does.
 */
import type { EmojiData, EmojiDataResolver, SkinTone } from "frimousse";

/**
 * Newest Emoji version offered. frimousse's own resolver detects support with
 * a canvas probe; a custom resolver's data is used as-is, so cap it at a
 * version the system emoji fonts of supported macOS / Windows / Linux
 * releases render, rather than offering blank boxes.
 */
export const MAX_EMOJI_VERSION = 15;

/** Emojibase skin-tone index → frimousse skin-tone key. */
const TONES: readonly SkinTone[] = [
  "none",
  "light",
  "medium-light",
  "medium",
  "medium-dark",
  "dark",
];

interface EmojibaseSkin {
  emoji: string;
  tone?: number | number[];
}

interface EmojibaseEmoji {
  emoji: string;
  label: string;
  group?: number;
  subgroup?: number;
  version: number;
  tags?: string[];
  skins?: EmojibaseSkin[];
}

interface EmojibaseMessages {
  groups: { key: string; message: string; order: number }[];
  subgroups: { key: string; message: string; order: number }[];
  skinTones: { key: string; message: string }[];
}

type SkinMap = Record<Exclude<SkinTone, "none">, string>;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Map raw Emojibase `data.json` + `messages.json` to frimousse's `EmojiData`,
 * dropping the "component" group (bare skin-tone / hair swatches) and every
 * emoji newer than {@link MAX_EMOJI_VERSION}.
 */
export function toEmojiData(emojis: EmojibaseEmoji[], messages: EmojibaseMessages): EmojiData {
  const flagGroups = new Set(
    messages.subgroups
      .filter((s) => s.key === "country-flag" || s.key === "subdivision-flag")
      .map((s) => s.order)
  );
  const categories = messages.groups
    .filter((g) => g.key !== "component")
    .map((g) => ({ index: g.order, label: capitalize(g.message) }));
  const known = new Set(categories.map((c) => c.index));
  const skinTones = Object.fromEntries(
    messages.skinTones.map((t) => [t.key, capitalize(t.message)])
  ) as SkinMap;

  return {
    locale: "en",
    categories,
    skinTones,
    emojis: emojis
      .filter((e) => e.group !== undefined && known.has(e.group))
      .filter((e) => e.version <= MAX_EMOJI_VERSION)
      .map((e) => {
        const single = e.skins?.filter((s) => typeof s.tone === "number") ?? [];
        const skins = single.length
          ? (Object.fromEntries(single.map((s) => [TONES[s.tone as number], s.emoji])) as SkinMap)
          : undefined;
        return {
          emoji: e.emoji,
          category: e.group as number,
          label: capitalize(e.label),
          version: e.version,
          tags: e.tags ?? [],
          countryFlag: e.subgroup !== undefined && flagGroups.has(e.subgroup) ? true : undefined,
          skins,
        };
      }),
  };
}

let cached: Promise<EmojiData> | null = null;

/**
 * frimousse `resolveEmojiData` that serves the bundled English Emojibase data
 * (loaded once, lazily). Never touches the network.
 */
export const resolveBundledEmojiData: EmojiDataResolver = () => {
  cached ??= Promise.all([
    import("emojibase-data/en/data.json"),
    import("emojibase-data/en/messages.json"),
  ]).then(([data, messages]) =>
    toEmojiData(
      data.default as unknown as EmojibaseEmoji[],
      messages.default as unknown as EmojibaseMessages
    )
  );
  return cached;
};
