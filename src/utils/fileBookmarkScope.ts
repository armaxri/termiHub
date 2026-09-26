/**
 * Which connection a file-browser bookmark belongs to (PROD-007, #3558).
 *
 * Bookmarks are persisted per connection under an opaque scope key. The key
 * must stay stable across reconnects and app restarts, so it is derived from
 * the connection's identity — never from a session id:
 *
 * - every local browser (local shells, WSL — whose paths are UNC paths that
 *   already name the distro) shares the `local` scope;
 * - a remote tab opened from a saved connection uses `connection:<id>`;
 * - an agent session without a saved connection uses `agent:<agent>:<type>`;
 * - any other remote tab falls back to `host:<type>:<user>@<host>:<port>`.
 *
 * When nothing identifies the remote end, there is no scope and bookmarks are
 * unavailable for that browser.
 */

import type { FileBrowserMode } from "@/store/fileBrowsersBridge";
import type { TerminalTab } from "@/types/terminal";
import {
  readConfigNumber,
  readConfigString,
  connectionConfigFields,
} from "@/utils/connectionConfigFields";

/** The scope shared by every local file browser. */
export const LOCAL_BOOKMARK_SCOPE = "local";

/**
 * Derive the bookmark scope for the file browser in `mode`, whose remote side
 * (in session mode) is owned by `tab`. Returns `null` when bookmarks cannot be
 * scoped (browser idle, or an unidentifiable remote end).
 */
export function fileBookmarkScope(
  mode: FileBrowserMode,
  tab: TerminalTab | null | undefined
): string | null {
  if (mode === "local") return LOCAL_BOOKMARK_SCOPE;
  if (mode !== "session" || !tab) return null;
  if (tab.connectionId) return `connection:${tab.connectionId}`;

  const config = tab.config;
  const agentId = readConfigString(config, "agentId");
  if (agentId) {
    return `agent:${agentId}:${readConfigString(config, "sessionType") ?? "local"}`;
  }

  const host = readConfigString(config, "host")?.trim().toLowerCase();
  if (!host) return null;
  const user = readConfigString(config, "username") ?? "";
  const rawPort = connectionConfigFields(config)["port"];
  const port = readConfigNumber(config, "port") ?? (typeof rawPort === "string" ? rawPort : "");
  return `host:${tab.connectionType}:${user}@${host}:${port}`;
}
