/**
 * Same-host check for a graphical session's file side channel (#4198).
 *
 * TypeScript twin of `is_loopback_host` / `is_same_host` in
 * `core/src/connection/graphical_files.rs`. The connection editor uses it to
 * evaluate the schema's two-field host comparison (`Condition.sameHostAs`)
 * without a backend round-trip; the live per-session verdict still comes from
 * the backend (`RemoteDesktopFileChannel.sameHost`). Both sides replay the
 * golden vectors in `core/tests/fixtures/golden/schema_defaults/is_same_host.json`,
 * so the two implementations cannot drift.
 */

/** ASCII-only lowercase, matching Rust's `eq_ignore_ascii_case`. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Strip IPv6 brackets and surrounding whitespace from a host string. */
function bareHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Strip trailing dots (a fully-qualified `name.`). */
function withoutTrailingDots(host: string): string {
  return host.replace(/\.+$/, "");
}

/**
 * Parse a strict dotted-quad IPv4 address (as Rust's `Ipv4Addr` parser does:
 * four decimal octets, each 0–255, no leading zeros). Returns `null` if invalid.
 */
function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Parse an IPv6 address into its eight 16-bit groups (supports `::` and an
 * embedded IPv4 tail). Returns `null` if invalid.
 */
function parseIpv6(text: string): number[] | null {
  if (!text.includes(":")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side: string, allowIpv4Tail: boolean): number[] | null => {
    if (side === "") return [];
    const pieces = side.split(":");
    const groups: number[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (allowIpv4Tail && i === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  if (halves.length === 1) {
    const groups = parseSide(halves[0], true);
    return groups && groups.length === 8 ? groups : null;
  }
  const head = parseSide(halves[0], false);
  const tail = parseSide(halves[1], true);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** Whether `text` is a loopback IP address (`127.0.0.0/8` or `::1`). */
function isLoopbackIp(text: string): boolean {
  const v4 = parseIpv4(text);
  if (v4) return v4[0] === 127;
  const v6 = parseIpv6(text);
  if (v6) return v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1;
  return false;
}

/**
 * Whether `host` names the loopback interface: `localhost` (any case, also the
 * `*.localhost` names RFC 6761 reserves for loopback), `127.0.0.0/8`, or `::1`
 * (bracketed or not).
 */
export function isLoopbackHost(host: string): boolean {
  const bare = withoutTrailingDots(bareHost(host));
  const lower = asciiLower(bare);
  if (lower === "localhost") return true;
  if (lower.length > ".localhost".length && lower.endsWith(".localhost")) return true;
  return isLoopbackIp(bare);
}

/**
 * Whether `fileHost` counts as the desktop host for a VNC target named
 * `target` **as seen from `fileHost`**: the target is loopback there, or has
 * the same name as `fileHost` (case-insensitive).
 */
export function isSameHost(target: string, fileHost: string): boolean {
  if (isLoopbackHost(target)) return true;
  const t = withoutTrailingDots(bareHost(target));
  const f = withoutTrailingDots(bareHost(fileHost));
  return t !== "" && asciiLower(t) === asciiLower(f);
}
