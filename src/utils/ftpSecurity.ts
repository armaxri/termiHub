/**
 * Pure helpers for the FTP connection's security behaviors:
 *
 * - {@link shouldShowInsecureFtpWarning} decides whether the connect-time
 *   plaintext-FTP warning modal must appear before the control connection opens.
 * - {@link ftpPortForTlsMode} derives the port default when the user switches
 *   TLS Mode (990 for implicit FTPS, 21 otherwise). The settings schema's
 *   `Condition` is `equals`-only and cannot mutate a value, so this is applied
 *   as a small frontend special-case in the connection form.
 *
 * Keeping these as side-effect-free functions makes the security-sensitive
 * decisions trivially unit-testable.
 */

import type { ConnectionConfig } from "@/types/terminal";

/** The `ftp` connection type identifier. */
const FTP_TYPE = "ftp";

/** Standard FTP control ports that the auto-adjust is allowed to snap between. */
const STANDARD_FTP_PORTS: ReadonlySet<number> = new Set([21, 990]);

/**
 * Whether the insecure-connection warning modal must be shown before connecting.
 *
 * Returns `true` only for a plain-FTP connection (`type === "ftp"` and
 * `tlsMode === "none"`, the default) that has not been suppressed via the
 * per-connection `suppressSecurityWarning` flag. FTPS (explicit/implicit) and
 * every non-FTP type return `false`.
 */
export function shouldShowInsecureFtpWarning(config: ConnectionConfig): boolean {
  if (config.type !== FTP_TYPE) return false;
  const cfg = config.config;
  const tlsMode = (cfg.tlsMode as string | undefined) ?? "none";
  if (tlsMode !== "none") return false;
  return cfg.suppressSecurityWarning !== true;
}

/**
 * Derive the port the FTP form should adopt when TLS Mode changes to
 * `nextTlsMode`, or `null` when the current port should be left untouched.
 *
 * The target is 990 for implicit FTPS and 21 otherwise. To avoid clobbering a
 * deliberately customized port, the value is only changed when the current port
 * is unset or still sits on a standard FTP port (21 / 990). A custom port such
 * as 2121 is preserved.
 */
export function ftpPortForTlsMode(
  nextTlsMode: string | undefined,
  currentPort: number | undefined
): number | null {
  const target = nextTlsMode === "implicit" ? 990 : 21;
  if (currentPort === target) return null;
  if (currentPort === undefined || STANDARD_FTP_PORTS.has(currentPort)) return target;
  return null;
}
