import { redactLogText } from "@/utils/redactLogText";

/**
 * Fields gathered for a "Copy debug info" bundle (OBS-008). Everything here is
 * already available to the frontend via existing APIs/hooks — no secret is
 * intentionally included, but the assembled text is still run through
 * {@link redactLogText} as defense-in-depth before it reaches the clipboard.
 */
export interface DebugInfoFields {
  /** Running app version (e.g. `0.1.0-dev`), or `null` if not yet resolved. */
  version: string | null;
  /** Short git commit hash embedded at build time. */
  gitHash: string | null;
  /** Git branch the binary was built from. */
  buildBranch: string | null;
  /** Whether this is a development (non-production) build. */
  isDev: boolean | null;
  /** Coarse platform: `windows` / `macos` / `linux`. */
  platform: string;
  /** Webview user agent (carries OS/version detail). */
  userAgent: string;
  /** Absolute path to the on-disk log file, if known. */
  logFilePath: string | null;
  /** Credential storage backend mode (e.g. `os_keychain`). */
  credentialStoreMode: string | null;
  /** Credential store runtime status (e.g. `unlocked`). */
  credentialStoreStatus: string | null;
}

/** Placeholder for a field whose value could not be resolved. */
const UNKNOWN = "unknown";

function labelValue(label: string, value: string): string {
  return `${label.padEnd(18)}${value}`;
}

/**
 * Assemble a human-readable diagnostics bundle for pasting into a bug report.
 *
 * Pure and deterministic given `fields`; the result is passed through
 * {@link redactLogText} so any secret that somehow reaches a field (e.g. a
 * credentialed log path) is masked before the text leaves the app.
 *
 * @param fields - The gathered diagnostics values.
 * @returns A multi-line, redacted diagnostics string.
 */
export function buildDebugInfo(fields: DebugInfoFields): string {
  const credential =
    fields.credentialStoreMode === null
      ? UNKNOWN
      : fields.credentialStoreStatus
        ? `${fields.credentialStoreMode} (${fields.credentialStoreStatus})`
        : fields.credentialStoreMode;

  const devBuild = fields.isDev === null ? UNKNOWN : fields.isDev ? "yes" : "no";

  const lines = [
    "termiHub debug info",
    "===================",
    labelValue("App version:", fields.version ?? UNKNOWN),
    labelValue("Build commit:", fields.gitHash ?? UNKNOWN),
    labelValue("Build branch:", fields.buildBranch ?? UNKNOWN),
    labelValue("Dev build:", devBuild),
    labelValue("Platform:", fields.platform),
    labelValue("User agent:", fields.userAgent),
    labelValue("Log file:", fields.logFilePath ?? UNKNOWN),
    labelValue("Credential store:", credential),
  ];

  return redactLogText(lines.join("\n"));
}
