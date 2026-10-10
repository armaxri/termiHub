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

import secretKeyWords from "@/data/secret-key-words.json";

/** Marker substituted in place of a redacted secret value. */
export const REDACTION_MARKER = "***redacted***";

/**
 * The shared secret key-name list (#4430). The Rust diagnostics redactor
 * (`core/src/diagnostics/redact.rs`) builds its pattern from the same file with
 * the same algorithm, and both are pinned by the shared vectors in
 * `src/test/fixtures/redaction/secret-text-vectors.json`, so they cannot drift.
 */
interface SecretKeyWords {
  words: string[];
  compoundWords: string[][];
  gluedPrefixes: string[];
}

/** Longest identifier prefix scanned before a secret word (bounds backtracking). */
const MAX_KEY_PREFIX = 64;

/** `abc` → `[aA][bB][cC]`: case-insensitive without the regex `i` flag. */
function anyCase(text: string): string {
  return text.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

/**
 * Build the secret key-name pattern from {@link SecretKeyWords}. It contains no
 * capture groups and is **case-sensitive by construction**, so it must be used
 * without the `i` flag: the camelCase alternative relies on the case of the
 * first letter (`sshPassword` matches, `spinner` / `SPIN` do not).
 *
 * A key matches when a secret term is its whole name or its last component:
 * - after a `_` / `-` separator, in any case (`ssh_password`, `MY_API_KEY`);
 * - at a camelCase boundary (`sshPassword`, `keyPassphrase`, `clientSecret`);
 * - glued to one of `gluedPrefixes`, in any case (`sshpassword`, `accesstoken`).
 *
 * Compound terms (`api key`) allow an optional `-`/`_`/space between parts, and
 * a trailing plural `s` is always allowed.
 */
function secretKeyPattern(spec: SecretKeyWords): string {
  const terms = [...spec.words.map((w) => [w]), ...spec.compoundWords];
  const sep = "[-_ ]?";
  const termAnyCase = terms.map((parts) => parts.map(anyCase).join(sep)).join("|");
  const termCamel = terms
    .map(([first, ...rest]) =>
      [first.charAt(0).toUpperCase() + first.slice(1), ...rest.map(anyCase)].join(sep)
    )
    .join("|");
  const glued = spec.gluedPrefixes.map(anyCase).join("|");
  const ident = `[A-Za-z0-9_-]{0,${MAX_KEY_PREFIX}}`;
  return (
    `\\b(?:` +
    `(?:${ident}[_-])?(?:${termAnyCase})` +
    `|${ident}[A-Za-z0-9](?:${termCamel})` +
    `|(?:${glued})(?:${termAnyCase})` +
    `)[sS]?\\b`
  );
}

/** Secret-bearing key names, built from the shared list. */
const SECRET_KEY_PATTERN = secretKeyPattern(secretKeyWords as SecretKeyWords);

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
  `(${SECRET_KEY_PATTERN}["']?\\s*[:=]\\s*)(["'])(?:(?!\\2).)*\\2`,
  "g"
);

/** `secretKey=value` / `secretKey: value` — unquoted value (stops at whitespace/delimiter). */
const UNQUOTED_KEY_VALUE = new RegExp(
  `(${SECRET_KEY_PATTERN}["']?\\s*[:=]\\s*)([^\\s"',;}\\])]+)`,
  "g"
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
