import type { SshHostKeyPromptPayload } from "@/types/sshHostKey";

/**
 * What changed about a server's host key, in plain sentences for the
 * changed-key dialog (#5862, R-109): the fingerprint always (that is why the
 * dialog is up), and the key type when the previously trusted key's type is
 * known. Empty for first contact.
 *
 * termiHub's trust store keeps fingerprints only, and `known_hosts` keeps no
 * dates, so there is no "first trusted on" to report.
 */
export function hostKeyChanges(
  prompt: Pick<SshHostKeyPromptPayload, "changed" | "key_type" | "previous_keys">
): string[] {
  if (!prompt.changed) return [];
  const previous = prompt.previous_keys ?? [];
  const lines = [
    previous.length > 1
      ? "The fingerprint matches none of the keys trusted before."
      : "The fingerprint is different from the key trusted before.",
  ];
  const types = [
    ...new Set(previous.map((k) => k.key_type).filter((t): t is string => Boolean(t))),
  ];
  if (types.length === 0) return lines;
  if (types.length === 1 && types[0] === prompt.key_type) {
    lines.push(`The key type is the same (${prompt.key_type}).`);
  } else {
    lines.push(`The key type changed from ${types.join(", ")} to ${prompt.key_type}.`);
  }
  return lines;
}
