/**
 * Pure helpers for **fleet onboarding** (#1961): stamp many saved connections
 * from one existing connection used as a **template**, sourcing hosts from a CSV
 * / simple inventory file.
 *
 * A "template" here is just an existing {@link SavedConnection}: its
 * `config.type` and `config.config` (shared creds / auth / jump-host chain) are
 * reused for every host, with only the host (and optional per-row port/username)
 * and the name overridden. No new persistence concept is introduced — the built
 * connections go through the same `bulkAddConnections` path as the SSH-config
 * bulk import, which strips inline secrets before saving.
 *
 * Kept side-effect free so the mapping, dedupe, and template eligibility are
 * unit-testable independently of the dialog and store.
 */

import type { ConnectionTypeInfo, InventoryHost, SavedConnection } from "@/types/connection";
import { uniqueConnectionName } from "@/services/sshConfigImport";

/** The result of building templated connections from inventory rows. */
export interface FleetBuildResult {
  /** The connections to persist (one per non-deduped, valid row). */
  connections: SavedConnection[];
  /**
   * Rows skipped as duplicates of an existing connection in the target folder
   * (only when dedupe is enabled). Reported so the UI can tell the user.
   */
  skipped: InventoryHost[];
}

/** Options controlling how a fleet is built. */
export interface FleetBuildOptions {
  /**
   * When `true` (the default), a row whose host already has a connection of the
   * template's type in the target folder is skipped rather than duplicated.
   */
  dedupe?: boolean;
}

/**
 * Deep-clone the template's type-specific settings so each built connection owns
 * an independent copy (mutating one host's port must not touch the others').
 */
function cloneSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(settings);
}

/**
 * The dedupe key for a connection under a template: its `host` setting, lowercased.
 * Connections created from a template all share the template's type, so the host
 * alone distinguishes them within a folder.
 */
function hostKey(settings: Record<string, unknown>): string | null {
  const host = settings.host;
  return typeof host === "string" && host.trim() !== "" ? host.trim().toLowerCase() : null;
}

/**
 * Build one {@link SavedConnection} per inventory row from `template`, placed in
 * `folderId` (`null` = root).
 *
 * Each connection reuses the template's type and settings, overriding `host`
 * (and, when the row provides them, `port`/`username`). Names start from the
 * row's `label` and are made unique within the target folder — collisions
 * resolve against both the connections already there and the names assigned
 * earlier in this same batch. With `dedupe` on (default), a row whose host is
 * already present in the folder is skipped instead of duplicated.
 */
export function buildTemplatedConnections(
  rows: InventoryHost[],
  template: SavedConnection,
  folderId: string | null,
  existingConnections: SavedConnection[],
  options: FleetBuildOptions = {}
): FleetBuildResult {
  const dedupe = options.dedupe ?? true;
  const target = folderId ?? null;
  const inFolder = existingConnections.filter((c) => (c.folderId ?? null) === target);

  const takenNames = new Set(inFolder.map((c) => c.name));
  const existingHosts = new Set(
    inFolder
      .filter((c) => c.config.type === template.config.type)
      .map((c) => hostKey(c.config.config))
      .filter((k): k is string => k !== null)
  );

  const connections: SavedConnection[] = [];
  const skipped: InventoryHost[] = [];
  const now = Date.now();
  let created = 0;

  rows.forEach((row) => {
    const host = row.host.trim();
    if (host === "") return;

    const key = host.toLowerCase();
    if (dedupe && existingHosts.has(key)) {
      skipped.push(row);
      return;
    }
    // Guard against duplicate hosts *within* the same batch too.
    existingHosts.add(key);

    const settings = cloneSettings(template.config.config);
    settings.host = host;
    if (row.port !== undefined) settings.port = row.port;
    if (row.username !== undefined && row.username !== "") settings.username = row.username;

    const baseName = row.label.trim() !== "" ? row.label.trim() : host;
    const name = uniqueConnectionName(baseName, takenNames);
    takenNames.add(name);

    connections.push({
      id: `conn-${now}-${created}`,
      name,
      config: { type: template.config.type, config: settings },
      folderId: target,
      ...(template.icon ? { icon: template.icon } : {}),
      ...(template.terminalOptions ? { terminalOptions: template.terminalOptions } : {}),
    });
    created += 1;
  });

  return { connections, skipped };
}

/**
 * Whether `conn` can serve as a fleet template: its connection type must have a
 * `host` setting, since onboarding stamps each row's host into it. Derived from
 * the connection-type registry's schema; when the registry does not (yet) know
 * the type, fall back to whether the saved settings carry a `host` key.
 */
export function isHostTemplate(conn: SavedConnection, types: ConnectionTypeInfo[]): boolean {
  const info = types.find((t) => t.typeId === conn.config.type);
  if (info) {
    return info.schema.groups.some((g) => g.fields.some((f) => f.key === "host"));
  }
  return Object.prototype.hasOwnProperty.call(conn.config.config ?? {}, "host");
}
