/**
 * Pure helper for the VNC connection editor's live display↔port interplay.
 *
 * VNC servers listen on `5900 + display`, so the connection editor keeps the
 * two fields in sync: entering a display number auto-fills the port, and
 * editing the port clears the display (see {@link vncPortForDisplay} and the
 * connection form's `syncDisplayPort` handler). The connect-side resolution is
 * done in the Rust core (`VncConfig::effective_port`); this mirrors only the
 * *editor* convenience so the user does not have to compute the port by hand.
 *
 * Keeping the derivation as a side-effect-free function makes it trivially
 * unit-testable and matches the FTP `ftpPortForTlsMode` special-case pattern.
 */

/** RFB display 0 → TCP port 5900. Mirrors `VNC_BASE_PORT` in the Rust core. */
export const VNC_BASE_PORT = 5900;

/** Highest TCP port the auto-filled value is allowed to reach. */
const MAX_TCP_PORT = 65535;

/**
 * Derive the VNC TCP port for a display number, or `null` when the display is
 * empty/invalid and the port should be left untouched.
 *
 * The display may arrive as a number (from the numeric widget) or a string,
 * so it is accepted as `unknown` and coerced. Only a non-negative integer whose
 * derived port (`5900 + display`) stays within the valid TCP range yields a
 * port; anything else — a cleared field, non-numeric text, a negative, a
 * fractional, or an out-of-range value — returns `null` so the auto-fill
 * assists without ever fighting the user.
 */
export function vncPortForDisplay(display: unknown): number | null {
  if (display === null || display === undefined || display === "") return null;
  const n = typeof display === "number" ? display : Number(display);
  if (!Number.isInteger(n) || n < 0) return null;
  const port = VNC_BASE_PORT + n;
  if (port > MAX_TCP_PORT) return null;
  return port;
}
