/**
 * Which open tabs can back the dual-pane transfer view's remote pane
 * (PROD-007, #3558): connected, non-local terminal / file-browser tabs whose
 * connection type (or, for an agent session, the agent's session type) has the
 * file-browser capability and whose connection did not opt out of it.
 */

import type { ConnectionTypeInfo } from "@/services/api";
import type { TabContent } from "@/types/terminal";
import { readConfigString } from "@/utils/connectionConfigFields";
import { resolveFeatureEnabled } from "@/utils/featureFlags";

/** One selectable remote for the transfer view. */
export interface TransferRemoteOption {
  /** The terminal tab owning the session. */
  tabId: string;
  /** The tab's title, shown in the remote picker. */
  title: string;
  /** The tab's live session id. */
  sessionId: string;
}

/** The part of a remote agent the capability check needs. */
export interface TransferRemoteAgent {
  id: string;
  capabilities?: { connectionTypes?: ConnectionTypeInfo[] } | null;
}

const LOCAL_TYPES = new Set(["local", "wsl"]);

function supportsFileBrowser(typeId: string, types: ConnectionTypeInfo[]): boolean {
  return types.find((t) => t.typeId === typeId)?.capabilities.fileBrowser ?? false;
}

function isBrowsableRemote(
  tab: TabContent,
  types: ConnectionTypeInfo[],
  agents: TransferRemoteAgent[]
): boolean {
  if (tab.contentType !== "terminal" && tab.contentType !== "file-browser") return false;
  if (LOCAL_TYPES.has(tab.connectionType)) return false;
  if (!resolveFeatureEnabled(tab.config, "enableFileBrowser", true)) return false;
  if (tab.connectionType === "remote-session") {
    const agentId = readConfigString(tab.config, "agentId");
    const sessionType = readConfigString(tab.config, "sessionType") ?? "local";
    const agent = agents.find((a) => a.id === agentId);
    return supportsFileBrowser(sessionType, agent?.capabilities?.connectionTypes ?? []);
  }
  return supportsFileBrowser(tab.connectionType, types);
}

/** The connected tabs that can back the remote pane, in the given order. */
export function transferRemoteOptions(
  tabs: TabContent[],
  types: ConnectionTypeInfo[],
  agents: TransferRemoteAgent[]
): TransferRemoteOption[] {
  return tabs
    .filter((t) => t.sessionId && isBrowsableRemote(t, types, agents))
    .map((t) => ({ tabId: t.id, title: t.title, sessionId: t.sessionId as string }));
}
