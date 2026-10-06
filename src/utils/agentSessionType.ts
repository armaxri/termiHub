/**
 * Agent session-type ids (the `sessionType` of a `remote-session` tab).
 *
 * The UI names a plain agent shell `"shell"` (the agent's "New Shell Session"
 * writes `sessionType: "shell"`), but the agent's connection-type registry — the
 * `capabilities.connectionTypes` it reports — lists that backend as `"local"`.
 * The backend maps the alias when it creates the session
 * (`session/remote_proxy.rs`, `agent/src/handler/dispatch.rs`), so every
 * frontend capability lookup must apply the same mapping, or an agent shell
 * reads as having no file browser.
 */
import type { ConnectionTypeInfo } from "@/types/connection";

/** Legacy / user-facing session-type aliases → the registry id. */
const AGENT_SESSION_TYPE_ALIASES: Readonly<Record<string, string>> = { shell: "local" };

/**
 * Normalize a session-type id to the id the agent's registry uses. An id the
 * registry already lists is kept as is, so a registry that does carry the alias
 * itself still wins.
 */
export function normalizeAgentTypeId(typeId: string, types: ConnectionTypeInfo[]): string {
  if (types.some((ct) => ct.typeId === typeId)) return typeId;
  return AGENT_SESSION_TYPE_ALIASES[typeId] ?? typeId;
}

/** The agent's connection-type entry for a tab's `sessionType`, alias-aware. */
export function findAgentConnectionType(
  types: ConnectionTypeInfo[],
  sessionType: string
): ConnectionTypeInfo | undefined {
  const typeId = normalizeAgentTypeId(sessionType, types);
  return types.find((ct) => ct.typeId === typeId);
}
