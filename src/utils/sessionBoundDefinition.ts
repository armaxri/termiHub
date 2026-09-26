import type { AgentDefinitionInfo } from "@/services/api";

/** The fields needed to open a running agent session in a tab (#3369). */
export interface OpenableAgentSession {
  sessionId: string;
  title: string;
  type: string;
  definitionId?: string | null;
}

/**
 * A session-scoped stand-in definition for an agent session that was not
 * created from a saved connection (#3369), so opening it still goes through the
 * adopt+attach path and binds the tab to that exact session instead of spawning
 * a fresh one. The agent reports shells as `"local"`; the desktop calls them
 * `"shell"`.
 */
export function sessionBoundDefinition(session: OpenableAgentSession): AgentDefinitionInfo {
  return {
    id: `session:${session.sessionId}`,
    name: session.title || `Session ${session.sessionId.slice(0, 8)}`,
    sessionType: session.type === "local" ? "shell" : session.type,
    config: {},
    persistent: true,
    folderId: null,
  };
}
