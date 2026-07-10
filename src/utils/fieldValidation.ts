/**
 * Shared inline field-validation helpers.
 *
 * These pure functions back the client-side validation used by the network
 * tools and the tunnel editor so that invalid input (blank hosts, out-of-range
 * ports, non-integer counts) is flagged inline and blocks the action rather
 * than being silently coerced (e.g. `parseInt(...) || 0`) and failing later at
 * connect/run time.
 */

export interface IntRangeOptions {
  /** Inclusive lower bound. */
  min: number;
  /** Inclusive upper bound. */
  max: number;
  /** Human-readable field name used in the returned message. */
  label?: string;
  /** When true, an empty value (`""`/`null`/`undefined`) is considered valid. */
  allowEmpty?: boolean;
}

/**
 * Validate that a value is an integer within `[min, max]`.
 *
 * @returns an error message when invalid, or `null` when the value is acceptable.
 */
export function validateIntRange(
  value: number | "" | null | undefined,
  { min, max, label = "Value", allowEmpty = false }: IntRangeOptions
): string | null {
  if (value === "" || value === null || value === undefined || Number.isNaN(value)) {
    return allowEmpty ? null : `${label} is required`;
  }
  if (!Number.isInteger(value)) {
    return `${label} must be a whole number`;
  }
  if (value < min || value > max) {
    return `${label} must be between ${min} and ${max}`;
  }
  return null;
}

/**
 * Validate a TCP/UDP port number (1–65535).
 *
 * @returns an error message when invalid, or `null` when acceptable.
 */
export function validatePort(
  value: number | "" | null | undefined,
  opts: { label?: string; allowEmpty?: boolean } = {}
): string | null {
  return validateIntRange(value, {
    min: 1,
    max: 65535,
    label: opts.label ?? "Port",
    allowEmpty: opts.allowEmpty,
  });
}

/**
 * Validate that a host/address string is non-empty (after trimming).
 *
 * @returns an error message when empty, or `null` when acceptable.
 */
export function validateHost(value: string | null | undefined, label = "Host"): string | null {
  return value && value.trim() !== "" ? null : `${label} is required`;
}

/** Matches a MAC address as six hex pairs separated uniformly by `:` or `-`. */
const MAC_RE = /^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$|^(?:[0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2}$/;

/**
 * Validate a 48-bit MAC address in the colon- or hyphen-separated form
 * (`AA:BB:CC:DD:EE:FF` or `AA-BB-CC-DD-EE-FF`), case-insensitive.
 *
 * @returns an error message when invalid, or `null` when acceptable.
 */
export function validateMac(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return "MAC address is required";
  return MAC_RE.test(trimmed) ? null : "Enter a valid MAC address (e.g. AA:BB:CC:DD:EE:FF)";
}

/**
 * Check whether a string is a usable HTTP(S) URL — a real scheme + host check,
 * replacing the brittle `url === "https://"` sentinel comparison.
 *
 * An empty string, a bare scheme (`https://`), or a non-http scheme all return
 * `false`.
 */
export function isValidHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}
