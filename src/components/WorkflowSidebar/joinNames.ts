/** `“A”`, `“A” and “B”`, `“A”, “B” and “C”`. */
export function joinNames(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  if (quoted.length < 2) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}
