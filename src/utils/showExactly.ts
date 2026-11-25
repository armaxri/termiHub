/** Characters that show nothing, break a line or change the direction text is shown in. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * `text` so that it reads as what it is (#6019): what would not show, or would make
 * the rest read differently, is written out (`\n`, `\u{202e}`). A backslash is
 * doubled only where something is written out, so a Windows path stays readable.
 */
export function showExactly(text: string): string {
  if (!new RegExp(UNSEEN.source, "u").test(text)) return text;
  return text.replace(/\\/g, "\\\\").replace(UNSEEN, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    return `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`;
  });
}
