import { describe, it, expect } from "vitest";
import {
  ICON_COLOR_PALETTE,
  iconColorSchema,
  iconEmojiSchema,
  iconSurfaces,
  isSingleEmoji,
  isValidIconColor,
  resolveIconColor,
} from "./connectionIconStyle";
import { contrastRatio } from "@/themes/contrast";
import { darkTheme } from "@/themes/dark";
import { lightTheme } from "@/themes/light";

const lightSurfaces = iconSurfaces(lightTheme.colors);
const darkSurfaces = iconSurfaces(darkTheme.colors);

function worstContrast(color: string, surfaces: string[]): number {
  return Math.min(...surfaces.map((s) => contrastRatio(color, s)));
}

describe("isSingleEmoji", () => {
  it.each(["🚀", "🔥", "🐧", "👍🏽", "👨‍👩‍👧", "🇩🇪", "1️⃣", "🗄️"])("accepts %s", (e) => {
    expect(isSingleEmoji(e)).toBe(true);
  });

  it.each(["", "a", "AB", "🚀🔥", " 🚀", "🚀 ", "x🚀", "1", "#"])("rejects %j", (v) => {
    expect(isSingleEmoji(v)).toBe(false);
  });
});

describe("isValidIconColor", () => {
  it("accepts palette names and #rrggbb hex", () => {
    expect(isValidIconColor("blue")).toBe(true);
    expect(isValidIconColor("#FF8800")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const v of ["", "Blue", "#fff", "rgb(0,0,0)", "red;x", "#ff880011"]) {
      expect(isValidIconColor(v)).toBe(false);
    }
  });
});

describe("resolveIconColor", () => {
  it("returns undefined for unset or unknown values", () => {
    expect(resolveIconColor(undefined, darkSurfaces)).toBeUndefined();
    expect(resolveIconColor(null, darkSurfaces)).toBeUndefined();
    expect(resolveIconColor("chartreuse", darkSurfaces)).toBeUndefined();
  });

  it("picks the light shade on light surfaces and the dark shade on dark surfaces", () => {
    const blue = ICON_COLOR_PALETTE.find((e) => e.name === "blue")!;
    expect(resolveIconColor("blue", lightSurfaces)).toBe(blue.light);
    expect(resolveIconColor("blue", darkSurfaces)).toBe(blue.dark);
  });

  it.each(ICON_COLOR_PALETTE.map((e) => e.name))(
    "palette %s reaches 3:1 on the built-in Light and Dark surfaces unadjusted",
    (name) => {
      const entry = ICON_COLOR_PALETTE.find((e) => e.name === name)!;
      expect(worstContrast(entry.light, lightSurfaces)).toBeGreaterThanOrEqual(3);
      expect(worstContrast(entry.dark, darkSurfaces)).toBeGreaterThanOrEqual(3);
    }
  );

  it("nudges a low-contrast custom hex until it is legible", () => {
    const onDark = resolveIconColor("#202020", darkSurfaces)!;
    expect(onDark).not.toBe("#202020");
    expect(worstContrast(onDark, darkSurfaces)).toBeGreaterThanOrEqual(3);

    const onLight = resolveIconColor("#fafafa", lightSurfaces)!;
    expect(worstContrast(onLight, lightSurfaces)).toBeGreaterThanOrEqual(3);
  });

  it("keeps a custom hex that already contrasts", () => {
    expect(resolveIconColor("#ff8800", darkSurfaces)).toBe("#ff8800");
  });
});

describe("zod schemas (#2467: optional fields accept null)", () => {
  it("accept null and undefined as unset", () => {
    for (const schema of [iconColorSchema, iconEmojiSchema]) {
      expect(schema.safeParse(null).success).toBe(true);
      expect(schema.safeParse(undefined).success).toBe(true);
    }
  });

  it("validate set values", () => {
    expect(iconColorSchema.safeParse("purple").success).toBe(true);
    expect(iconColorSchema.safeParse("#12abEF").success).toBe(true);
    expect(iconColorSchema.safeParse("notacolor").success).toBe(false);
    expect(iconEmojiSchema.safeParse("🐧").success).toBe(true);
    const bad = iconEmojiSchema.safeParse("hi");
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].message).toBe("Enter a single emoji.");
  });
});
