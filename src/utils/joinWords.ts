/** `A`, `A and B`, `A, B and C`: a list of words for prose. */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
