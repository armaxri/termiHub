/**
 * The test environment gives the real `@xterm/addon-unicode-graphemes` its real
 * width table (see `bufferPool.ts`).
 */
import { afterEach, expect, it, vi } from "vitest";
import type { IUnicodeVersionProvider, Terminal } from "@xterm/xterm";

/** Characters and their width in Unicode 15, spread over the whole code space. */
const WIDTHS: Record<string, number> = {
  a: 1,
  é: 1,
  字: 2,
  가: 2,
  "́": 0, // combining acute accent
  "😀": 2,
  "\u{20000}": 2, // CJK extension B
  "\u{E0100}": 0, // variation selector
  "\u{10FFFD}": 1, // private use
};

afterEach(() => vi.restoreAllMocks());

it("decodes base64 into memory of its own", () => {
  const bytes = Buffer.from("aGVsbG8=", "base64");
  expect([bytes.byteOffset, bytes.buffer.byteLength]).toEqual([0, 5]);
});

it("gives the grapheme addon its real width table", async () => {
  // Right before the addon decodes its table, begin a new pool, if there is one,
  // with zeros, which are no table header: where the table lands is then no luck.
  const from = Buffer.from.bind(Buffer) as (data: string, encoding: BufferEncoding) => Buffer;
  const decode = vi.spyOn(Buffer, "from").mockImplementation(((
    data: string,
    encoding: "base64"
  ) => {
    for (let i = 0; i < 32 && from("A".repeat(1000), "base64").byteOffset !== 0; i += 1);
    return from(data, encoding);
  }) as unknown as typeof Buffer.from);
  const { UnicodeGraphemesAddon } = await import("@xterm/addon-unicode-graphemes");
  expect(decode).toHaveBeenCalledTimes(1);
  decode.mockRestore();
  const providers: IUnicodeVersionProvider[] = [];
  const unicode = {
    activeVersion: "6",
    register: (provider: IUnicodeVersionProvider) => providers.push(provider),
  };
  new UnicodeGraphemesAddon().activate({ unicode } as unknown as Terminal);
  expect(providers.map((p) => p.version)).toEqual(["15", "15-graphemes"]);
  for (const provider of providers) {
    const widths = Object.keys(WIDTHS).map((char) => provider.wcwidth(char.codePointAt(0) ?? 0));
    expect(widths).toEqual(Object.values(WIDTHS));
  }
});
