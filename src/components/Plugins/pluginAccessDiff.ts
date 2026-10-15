import type {
  ConnectionPolicyManifest,
  PluginAccessDiff,
  PluginAccessDiffPath,
} from "@/types/plugin";

/**
 * Whether an update changes nothing in the access the installed copy requests
 * (#4418). Mirrors `PluginAccessDiff::is_empty` in core.
 */
export function accessDiffIsEmpty(diff: PluginAccessDiff): boolean {
  return (
    diff.added.permissions.length === 0 &&
    diff.added.filesystemPaths.length === 0 &&
    diff.removed.permissions.length === 0 &&
    diff.removed.filesystemPaths.length === 0 &&
    diff.connectionPolicy === null
  );
}

/**
 * Whether an update requests anything the installed copy did not — the case the
 * install dialog flags as "asks for more access". A changed connection policy
 * that the incoming version still declares counts, as it does for the native
 * trust row. Mirrors `PluginAccessDiff::adds_access` in core.
 */
export function accessDiffAddsAccess(diff: PluginAccessDiff): boolean {
  return (
    diff.added.permissions.length > 0 ||
    diff.added.filesystemPaths.length > 0 ||
    (diff.connectionPolicy !== null && diff.connectionPolicy.after !== null)
  );
}

/**
 * A folder in the diff as the dialog shows it: the declared `${home}`/`${config}`
 * form next to the folder it resolves to on this computer, or just the folder.
 */
export function describeDiffPath(path: PluginAccessDiffPath): string {
  return path.declared.includes("${") ? `${path.declared} → ${path.folder}` : path.folder;
}

/**
 * A connection policy in a few words (`max 8 connections, local network
 * allowed`), or `host defaults` when none (or an empty one) is declared.
 */
export function describeConnectionPolicy(policy: ConnectionPolicyManifest | null): string {
  const parts: string[] = [];
  if (policy?.maxConnections !== undefined) {
    parts.push(`max ${policy.maxConnections} connections`);
  }
  if (policy?.connectTimeoutMs !== undefined) {
    parts.push(`${policy.connectTimeoutMs} ms connect timeout`);
  }
  if (policy?.allowLocalNetwork) parts.push("local network allowed");
  return parts.length === 0 ? "host defaults" : parts.join(", ");
}
