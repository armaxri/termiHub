import { openUrl } from "@tauri-apps/plugin-opener";

import { frontendLog } from "@/utils/frontendLog";

/**
 * Schemes we are willing to hand to the OS opener. Everything else — `file:`,
 * `javascript:`, custom protocol-handler schemes, and malformed input — is
 * refused before it reaches the OS handler (SEC-012).
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Whether `url` parses to an absolute URL with an allowed scheme.
 *
 * Uses the WHATWG `URL` parser so a bare/relative/garbage string, or any scheme
 * outside {@link ALLOWED_PROTOCOLS}, is rejected. This is the single gate every
 * external-open path (update release links, Monaco file-content links) runs
 * through so semi-remote-influenced input can never open an arbitrary scheme.
 */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Validate a URL against the scheme allowlist, then open it via the Tauri
 * opener. Returns `true` when the link was handed to the opener, `false` when
 * the scheme was rejected (the OS opener is never called in that case).
 *
 * A rejected scheme is logged and swallowed — it never throws. An opener
 * failure for an allowed scheme still rejects, so callers that want to surface
 * that (e.g. a toast) keep their `try/catch`.
 */
export async function safeOpenExternal(url: string): Promise<boolean> {
  if (!isAllowedExternalUrl(url)) {
    frontendLog("open_external", `refused to open URL with disallowed scheme: ${url}`);
    return false;
  }
  await openUrl(url);
  return true;
}

/** Minimal structural view of a Monaco `Uri` — only stringification is needed. */
interface UriLike {
  toString(skipEncoding?: boolean): string;
}

/**
 * Monaco `ILinkOpener.open` callback. Links embedded in edited file content are
 * attacker-influenceable when the file is remote/SFTP, so route every clicked
 * link through {@link safeOpenExternal} and always report the link as handled
 * (`true`) so Monaco never falls back to its default opener for a rejected
 * scheme (SEC-012).
 */
export function openMonacoLink(resource: UriLike): true {
  void safeOpenExternal(resource.toString(true));
  return true;
}
