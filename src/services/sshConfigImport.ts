/**
 * Helpers for the bulk `~/.ssh/config` import flow (#1731).
 *
 * The backend command `import_ssh_config_connections` (#1722) returns every
 * concrete `Host` alias as a resolved {@link SshConfigImportConnection}. These
 * pure helpers turn a user-selected subset of those into saved SSH
 * {@link SavedConnection}s dropped into a chosen folder, giving each a name that
 * is unique within that folder. Kept side-effect free so the mapping and
 * collision handling are unit-testable independently of the dialog and store.
 */

import type {
  ConnectionFolder,
  SavedConnection,
  SshConfigImportConnection,
} from "@/types/connection";

/**
 * Build the SSH settings record for a {@link SavedConnection} from an imported
 * host, mirroring the single-host editor mapping (#1722): `IdentityFile` →
 * `keyPath` (key auth only), and a non-empty resolved jump-host chain becomes
 * `proxyJump`. Direct hosts omit both keys, matching a hand-authored connection.
 */
function buildSshSettings(conn: SshConfigImportConnection): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    host: conn.host,
    port: conn.port,
    username: conn.username,
    authMethod: conn.authMethod,
  };
  if (conn.authMethod === "key" && conn.keyPath) settings.keyPath = conn.keyPath;
  if (conn.proxyJump.length > 0) settings.proxyJump = conn.proxyJump;
  return settings;
}

/**
 * Make `base` unique among the already-`taken` names by appending ` (2)`,
 * ` (3)`, … — the same disambiguation the editor's duplicate action uses. When
 * `base` is free it is returned unchanged.
 */
export function uniqueConnectionName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  let candidate = `${base} (${n})`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base} (${n})`;
  }
  return candidate;
}

/**
 * Build one SSH {@link SavedConnection} per selected imported host, placed in
 * `folderId` (`null` = root). Each connection's name starts from its `Host`
 * alias and is made unique within the target folder — collisions resolve against
 * both the connections already in that folder and the names assigned earlier in
 * this same batch, so importing two aliases that would clash never produces
 * duplicates.
 */
export function buildBulkSshConnections(
  imported: SshConfigImportConnection[],
  folderId: string | null,
  existingConnections: SavedConnection[]
): SavedConnection[] {
  const target = folderId ?? null;
  const taken = new Set(
    existingConnections.filter((c) => (c.folderId ?? null) === target).map((c) => c.name)
  );
  const now = Date.now();
  return imported.map((conn, i) => {
    const name = uniqueConnectionName(conn.name, taken);
    taken.add(name);
    return {
      id: `conn-${now}-${i}`,
      name,
      config: { type: "ssh", config: buildSshSettings(conn) },
      folderId: target,
    };
  });
}

/**
 * Sentinel `value` for the connections-root option. A Radix Select item may not
 * use an empty string (that clears the selection), so root needs an explicit,
 * non-empty token that {@link resolveImportFolderId} maps back to `null`.
 */
export const ROOT_FOLDER_VALUE = "__root__";

/** A target-folder choice for the bulk-import folder selector. */
export interface ImportFolderOption {
  /** The folder id, or {@link ROOT_FOLDER_VALUE} for the connections root. */
  value: string;
  /** `Parent / Child` path label, disambiguating equally-named folders. */
  label: string;
}

/** Map a folder-selector value to a `folderId` (`null` for the root sentinel). */
export function resolveImportFolderId(value: string): string | null {
  return value === ROOT_FOLDER_VALUE || value === "" ? null : value;
}

/** Build the `Parent / Child` path label for a folder. */
function folderPathLabel(folder: ConnectionFolder, byId: Map<string, ConnectionFolder>): string {
  const parts: string[] = [folder.name];
  let parentId = folder.parentId;
  const seen = new Set<string>([folder.id]);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts.join(" / ");
}

/**
 * Folder options for the bulk-import target selector: the connections root
 * first, then every folder by its full path, sorted alphabetically so the list
 * is stable and equally-named folders in different parents stay distinguishable.
 */
export function importFolderOptions(folders: ConnectionFolder[]): ImportFolderOption[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const folderOpts = folders
    .map((f) => ({ value: f.id, label: folderPathLabel(f, byId) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [{ value: ROOT_FOLDER_VALUE, label: "Connections (root)" }, ...folderOpts];
}
