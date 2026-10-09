/**
 * Machine-local trust for `run-script` workflow steps that load their body from
 * a local file (`sourcePath`) — #4310, FEC2-001.
 *
 * A step's `sourcePath` makes the runner read that file and type it into the
 * target session. An imported workflow must never choose that file, so the
 * runner reads a path only when the user picked it through the file dialog or
 * explicitly confirmed it in the step editor **on this machine**. That
 * "user-chosen" marker is the `AppSettings.workflowScriptSourceAllowlist`: it is
 * stored in the local settings, never in workflow data, so no workflow file can
 * forge it.
 */

/**
 * Whether `path` was picked or confirmed by the user on this machine. Exact
 * string match only — no normalisation, so a lookalike path is never trusted.
 */
export function isScriptSourceConfirmed(
  allowlist: readonly string[] | undefined,
  path: string
): boolean {
  return path !== "" && (allowlist ?? []).includes(path);
}

/**
 * Return a copy of `allowlist` with `path` added once. Pure: never mutates the
 * input; an empty path or one already present leaves the contents unchanged.
 */
export function withConfirmedScriptSource(
  allowlist: readonly string[] | undefined,
  path: string
): string[] {
  const current = [...(allowlist ?? [])];
  if (path === "" || current.includes(path)) return current;
  return [...current, path];
}
