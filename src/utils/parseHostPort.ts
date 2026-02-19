interface ParsedHostPort {
  host: string;
  port: number | null;
}

/**
 * Parse a host string that may contain an embedded port number.
 *
 * Supported formats:
 * - `[::1]:2222`        → host `::1`,  port `2222`  (IPv6 bracket notation)
 * - `192.168.0.2:2222`  → host `192.168.0.2`, port `2222`
 * - `myhost.com:8080`   → host `myhost.com`, port `8080`
 * - `192.168.0.2`       → host `192.168.0.2`, port `null`
 * - `::1`               → host `::1`, port `null`   (bare IPv6, no split)
 *
 * Returns `{ host, port }` where `port` is `null` when no valid port was
 * extracted. Ports outside 1–65535 are rejected (returns the original value
 * unchanged with `port: null`).
 */
export function parseHostPort(value: string): ParsedHostPort {
  const trimmed = value.trim();

  // IPv6 bracket notation: [host]:port
  const bracketMatch = trimmed.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketMatch) {
    const port = parseInt(bracketMatch[2], 10);
    if (port >= 1 && port <= 65535) {
      return { host: bracketMatch[1], port };
    }
    return { host: trimmed, port: null };
  }

  // Only split on colon if the host part contains no colons (avoids bare IPv6)
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0) {
    const hostPart = trimmed.substring(0, lastColon);
    const portPart = trimmed.substring(lastColon + 1);

    // If the host part itself contains a colon, this is likely a bare IPv6
    // address — don't split.
    if (!hostPart.includes(":") && /^\d+$/.test(portPart)) {
      const port = parseInt(portPart, 10);
      if (port >= 1 && port <= 65535) {
        return { host: hostPart, port };
      }
    }
  }

  return { host: trimmed, port: null };
}
