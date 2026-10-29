/**
 * Numeric ordering for host addresses shown in Network Tools result lists
 * (#5067). IP parsing is delegated to `ipaddr.js`; this module only defines
 * the order: IPv4 (by value) < IPv6 (by value) < hostnames (natural,
 * case-insensitive), with the original string as the final tie-breaker.
 */
import ipaddr from "ipaddr.js";

/** Family rank: lower sorts first. */
const IPV4 = 0;
const IPV6 = 1;
const NAME = 2;

interface HostKey {
  rank: number;
  /** Address bytes for IPs (4 or 16 entries); empty for hostnames. */
  bytes: number[];
  /** IPv6 zone id (`%en0`), compared after the address value. */
  zone: string;
  text: string;
}

const nameCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Parse a host string into a comparable key. */
function hostKey(host: string): HostKey {
  const text = host.trim();
  if (ipaddr.IPv4.isValidFourPartDecimal(text)) {
    return { rank: IPV4, bytes: ipaddr.IPv4.parse(text).toByteArray(), zone: "", text };
  }
  const unbracketed = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  if (ipaddr.IPv6.isValid(unbracketed)) {
    const v6 = ipaddr.IPv6.parse(unbracketed);
    return { rank: IPV6, bytes: v6.toByteArray(), zone: v6.zoneId ?? "", text };
  }
  return { rank: NAME, bytes: [], zone: "", text };
}

function compareKeys(a: HostKey, b: HostKey): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.rank === NAME) return nameCollator.compare(a.text, b.text);
  for (let i = 0; i < a.bytes.length; i++) {
    const diff = a.bytes[i] - b.bytes[i];
    if (diff !== 0) return diff;
  }
  return nameCollator.compare(a.zone, b.zone);
}

/**
 * Compare two host strings in address order: IPv4 numerically octet by octet
 * (`192.168.0.9` < `192.168.0.10` < `192.168.0.100`), then IPv6 by value
 * (independent of `::` compression), then hostnames naturally. Returns 0 for
 * the same address written differently (e.g. `2001:db8::1` vs `2001:DB8:0::1`).
 */
export function compareHosts(a: string, b: string): number {
  return compareKeys(hostKey(a), hostKey(b));
}

/**
 * Return a copy of `items` in address order of `getHost`. Equal hosts are
 * ordered by `tieBreak` when given, otherwise they keep their input order.
 */
export function sortByHost<T>(
  items: readonly T[],
  getHost: (item: T) => string,
  tieBreak?: (a: T, b: T) => number
): T[] {
  // Parse each host once rather than on every comparison.
  const keyed = items.map((item, index) => ({ item, index, key: hostKey(getHost(item)) }));
  keyed.sort(
    (x, y) =>
      compareKeys(x.key, y.key) || (tieBreak ? tieBreak(x.item, y.item) : 0) || x.index - y.index
  );
  return keyed.map((k) => k.item);
}

/**
 * Insert `item` into an already address-sorted list, returning a new list.
 * Used while results stream in so each event costs one binary search plus a
 * copy instead of a full re-sort. The item goes after any existing entries it
 * compares equal to, so equal hosts keep their arrival order — matching
 * {@link sortByHost} with the same `tieBreak`.
 */
export function insertSortedByHost<T>(
  sorted: readonly T[],
  item: T,
  getHost: (item: T) => string,
  tieBreak?: (a: T, b: T) => number
): T[] {
  const key = hostKey(getHost(item));
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const other = sorted[mid];
    const cmp = compareKeys(hostKey(getHost(other)), key) || (tieBreak ? tieBreak(other, item) : 0);
    if (cmp <= 0) lo = mid + 1;
    else hi = mid;
  }
  return [...sorted.slice(0, lo), item, ...sorted.slice(lo)];
}
