/**
 * Redact common secret shapes from free-form log text before it leaves the app
 * (OBS-008). This runs on the LogViewer copy/save paths and the "Copy debug
 * info" bundle, so a user filing a bug report cannot accidentally leak
 * passwords, tokens, keys, or credentials in plaintext.
 *
 * Design bias: this is a *safety* filter, so it errs toward **over-redaction**.
 * A false positive that masks a non-secret is acceptable; a leaked secret is
 * not. Patterns are deliberately keyword- or structure-anchored (rather than
 * generic high-entropy detection) so ordinary log text passes through
 * unchanged and whole lines are not needlessly nuked.
 */

/** Marker substituted in place of a redacted secret value. */
export const REDACTION_MARKER = "***redacted***";

/**
 * Secret-bearing key names (case-insensitive). Matched as whole words so
 * `password` matches but `keyboard` does not. Optional `-`/`_`/space separators
 * inside compound names are handled by the pattern fragments below.
 */
const SECRET_KEY_PATTERN =
  "(?:passwords?|passphrases?|passwd|pwd|secrets?|" +
  "tokens?|access[-_ ]?tokens?|auth[-_ ]?tokens?|id[-_ ]?tokens?|refresh[-_ ]?tokens?|" +
  "api[-_ ]?keys?|access[-_ ]?keys?|secret[-_ ]?keys?|private[-_ ]?keys?|" +
  "client[-_ ]?secrets?|credentials?)";

/**
 * A PEM-style private key block, from the BEGIN header through the END footer,
 * across any number of lines. The block body is the most dangerous single thing
 * that can appear in a log, so the whole block collapses to one marker line.
 */
const PEM_BLOCK =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;

/**
 * Credentials embedded in a connection string: `scheme://user:PASSWORD@host`.
 * Only the password segment is masked; the scheme, user, and host stay readable
 * so the line is still useful for debugging.
 */
const CONNECTION_STRING_CREDS = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s:/@]+)@/gi;

/**
 * An `Authorization` header value in either `key: value` or `key=value` form.
 * A recognised scheme (Bearer/Basic/...) is preserved; the credential after it
 * is masked. Quotes around the value are tolerated.
 */
const AUTHORIZATION_HEADER =
  /(\bauthorization\b["']?\s*[:=]\s*["']?)(bearer|basic|digest|negotiate|token)?\s*([^\s"',;}\])]+)/gi;

/**
 * A standalone `Bearer <token>` occurrence (e.g. inside a larger URL or note)
 * not already caught by the Authorization-header pattern.
 */
const BEARER_TOKEN = /\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi;

/** `secretKey: "value"` / `secretKey='value'` — quoted value (may contain spaces). */
const QUOTED_KEY_VALUE = new RegExp(
  `(\\b${SECRET_KEY_PATTERN}\\b["']?\\s*[:=]\\s*)(["'])(?:(?!\\2).)*\\2`,
  "gi"
);

/** `secretKey=value` / `secretKey: value` — unquoted value (stops at whitespace/delimiter). */
const UNQUOTED_KEY_VALUE = new RegExp(
  `(\\b${SECRET_KEY_PATTERN}\\b["']?\\s*[:=]\\s*)([^\\s"',;}\\])]+)`,
  "gi"
);

/**
 * Return `text` with common secret shapes replaced by {@link REDACTION_MARKER}.
 *
 * Pure and idempotent: re-running it over already-redacted text is a no-op.
 * The order of passes matters — the broad PEM/connection-string/authorization
 * structural patterns run before the keyword `key=value` passes so a secret is
 * masked once by the most specific rule that matches it.
 *
 * @param text - Arbitrary log or diagnostics text.
 * @returns The text with detected secrets masked; non-secret text is unchanged.
 */
export function redactLogText(text: string): string {
  if (!text) return text;

  let out = text;

  // 1. PEM private-key blocks — collapse the whole block to a single marker.
  out = out.replace(PEM_BLOCK, `-----BEGIN PRIVATE KEY----- ${REDACTION_MARKER}`);

  // 2. Connection-string credentials — mask only the password segment.
  out = out.replace(CONNECTION_STRING_CREDS, `$1:${REDACTION_MARKER}@`);

  // 3. Authorization headers — keep the scheme, mask the credential.
  out = out.replace(AUTHORIZATION_HEADER, (_m, prefix, scheme) => {
    const schemePart = scheme ? `${scheme} ` : "";
    return `${prefix}${schemePart}${REDACTION_MARKER}`;
  });

  // 4. Standalone Bearer tokens.
  out = out.replace(BEARER_TOKEN, `$1 ${REDACTION_MARKER}`);

  // 5. Keyword key=value secrets (quoted first so the unquoted pass can't
  //    partially mangle a quoted value).
  out = out.replace(QUOTED_KEY_VALUE, `$1$2${REDACTION_MARKER}$2`);
  out = out.replace(UNQUOTED_KEY_VALUE, `$1${REDACTION_MARKER}`);

  return out;
}
