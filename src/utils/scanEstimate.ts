/**
 * Pure helpers for estimating the size of a port scan.
 *
 * The Port Scanner warns before a very large scan. The estimate must factor in
 * both the number of target ports *and* the number of target hosts — a small
 * port list across a wide CIDR block (e.g. a `/16`) is still an enormous scan.
 */

/**
 * Count the ports described by a comma-separated list of singles and inclusive
 * ranges (e.g. `"22,80,443,8080-8090"`). Blank segments are ignored.
 */
export function countPorts(ports: string): number {
  return ports.split(",").reduce((acc, part) => {
    const trimmed = part.trim();
    if (trimmed === "") return acc;
    if (trimmed.includes("-")) {
      const [a, b] = trimmed.split("-").map(Number);
      return acc + Math.max(0, (b ?? 0) - (a ?? 0) + 1);
    }
    return acc + 1;
  }, 0);
}

/** Number of addresses in an IPv4 CIDR block, or `null` if not a valid CIDR. */
function cidrHostCount(token: string): number | null {
  const match = token.match(/^\d{1,3}(?:\.\d{1,3}){3}\/(\d{1,2})$/);
  if (!match) return null;
  const prefix = Number(match[1]);
  if (prefix < 0 || prefix > 32) return null;
  return 2 ** (32 - prefix);
}

/**
 * Count the hosts described by a comma-separated target list. Each entry is a
 * plain host/hostname (counts as 1) or an IPv4 CIDR block (counts as its
 * address count). A malformed or out-of-range CIDR prefix falls back to 1 so
 * the estimate never under-counts a real target. Blank segments are ignored.
 */
export function countHosts(hosts: string): number {
  return hosts.split(",").reduce((acc, part) => {
    const trimmed = part.trim();
    if (trimmed === "") return acc;
    return acc + (cidrHostCount(trimmed) ?? 1);
  }, 0);
}

/**
 * Estimate the total number of probes a scan will issue: hosts × ports.
 */
export function estimateScanProbes(hosts: string, ports: string): number {
  return countHosts(hosts) * countPorts(ports);
}
