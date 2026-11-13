/**
 * Whose filesystem the file browser shows (#5623).
 *
 * The local and the remote listings share one header, breadcrumb and styling,
 * and rename / delete act on whichever machine is browsed — so the browser
 * names it: "This computer" for the local filesystem (the app's term for the
 * desktop, see `runLocation.ts`), `user@host (SFTP)` for an SSH-backed
 * session, `<tab> (agent)` for an agent session, and the tab title otherwise.
 */

import type { FileBrowserMode } from "@/store/fileBrowsersBridge";
import type { TerminalTab } from "@/types/terminal";
import { readConfigString } from "@/utils/connectionConfigFields";

/** The name shown for the machine termiHub runs on. */
export const THIS_COMPUTER_LABEL = "This computer";

/** The parts of the owning tab the host label is derived from. */
export type FileBrowserHostTab = Pick<TerminalTab, "connectionType" | "config" | "title">;

/** The browsed filesystem's owner: which side it is on, and its label. */
export interface FileBrowserHost {
  kind: "local" | "remote";
  label: string;
}

/** The file-transfer protocol a connection type browses through, when it differs. */
const PROTOCOL_LABELS: Record<string, string> = { ssh: "SFTP" };

/**
 * The host label of the file browser in `mode`, whose remote side (in session
 * mode) is owned by `tab`. `null` when the browser is idle or the owner unknown.
 */
export function fileBrowserHost(
  mode: FileBrowserMode,
  tab: FileBrowserHostTab | null | undefined
): FileBrowserHost | null {
  if (mode === "local") return { kind: "local", label: THIS_COMPUTER_LABEL };
  if (mode !== "session" || !tab) return null;
  if (readConfigString(tab.config, "agentId")) {
    return { kind: "remote", label: `${tab.title} (agent)` };
  }
  const host = readConfigString(tab.config, "host")?.trim();
  if (!host) return { kind: "remote", label: tab.title };
  const user = readConfigString(tab.config, "username")?.trim();
  const protocol = PROTOCOL_LABELS[tab.connectionType] ?? tab.connectionType.toUpperCase();
  return { kind: "remote", label: `${user ? `${user}@` : ""}${host} (${protocol})` };
}
