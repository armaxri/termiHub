import { Checkbox } from "@/components/ui";
import type { AgentLogs } from "@/types/diagnostics";
import { formatBytes } from "@/utils/formatters";

/** Props for {@link AgentLogsSection}. */
export interface AgentLogsSectionProps {
  /** Connected agents' log files; `null` while still being gathered. */
  agents: AgentLogs[] | null;
  /** Display name for an agent id. */
  agentName: (agentId: string) => string;
  /** Ids of the agents whose log files the user excluded from the bundle. */
  excluded: ReadonlySet<string>;
  /** Include (`true`) or exclude (`false`) one agent's log files. */
  onToggle: (agentId: string, include: boolean) => void;
}

/**
 * The "agent log files" part of the Export Diagnostics preview (#4519): one
 * include checkbox per already-connected remote agent covering all of its
 * per-process log files, plus a note for agents that are too old to share
 * them or could not be reached. Renders nothing when no agent is connected.
 */
export function AgentLogsSection({ agents, agentName, excluded, onToggle }: AgentLogsSectionProps) {
  if (agents === null) {
    return (
      <p className="diagnostics__note" data-testid="diagnostics-agent-logs-loading">
        Checking connected agents for log files…
      </p>
    );
  }
  if (agents.length === 0) return null;

  return (
    <section className="diagnostics__agents" data-testid="diagnostics-agent-logs">
      <p className="diagnostics__note">
        Log files from connected agents (newest lines only, fetched over the existing connection,
        redacted on the agent and again before saving):
      </p>
      <ul className="diagnostics__list">
        {agents.map((agent) => (
          <AgentLogRow
            key={agent.agentId}
            agent={agent}
            name={agentName(agent.agentId)}
            included={!excluded.has(agent.agentId)}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </section>
  );
}

interface AgentLogRowProps {
  agent: AgentLogs;
  name: string;
  included: boolean;
  onToggle: (agentId: string, include: boolean) => void;
}

/** One agent's row: an include checkbox for its log files, or why it has none. */
function AgentLogRow({ agent, name, included, onToggle }: AgentLogRowProps) {
  let status: string | null = null;
  if (!agent.supported) status = "skipped — this agent version cannot share its log files";
  else if (agent.error) status = `skipped — could not list log files: ${agent.error}`;
  else if (agent.logs.length === 0) status = "no log files";

  if (status !== null) {
    return (
      <li className="diagnostics__row" data-testid={`diagnostics-agent-logs-${agent.agentId}`}>
        <span className="diagnostics__name">{name}</span>
        <span className="diagnostics__meta">{status}</span>
      </li>
    );
  }

  const id = `diagnostics-agent-logs-include-${agent.agentId}`;
  const total = agent.logs.reduce((sum, log) => sum + log.size, 0);
  const count = agent.logs.length;
  return (
    <li className="diagnostics__row">
      <span className="diagnostics__check">
        <Checkbox
          id={id}
          checked={included}
          onCheckedChange={(include) => onToggle(agent.agentId, include)}
          data-testid={id}
        />
        <label htmlFor={id} className="diagnostics__name">
          {name}: agent log files
        </label>
      </span>
      <span className="diagnostics__meta">
        {count} {count === 1 ? "file" : "files"} · {formatBytes(total)} on the agent
      </span>
    </li>
  );
}
