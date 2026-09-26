import { Checkbox } from "@/components/ui";
import type { AgentCrashReports } from "@/types/diagnostics";
import { formatBytes } from "@/utils/formatters";

/** Stable key of one remote report in the include/exclude set. */
export function agentReportKey(agentId: string, name: string): string {
  return `${agentId}\u0000${name}`;
}

/** Props for {@link AgentCrashReportsSection}. */
export interface AgentCrashReportsSectionProps {
  /** Connected agents' crash reports; `null` while still being gathered. */
  agents: AgentCrashReports[] | null;
  /** Display name for an agent id. */
  agentName: (agentId: string) => string;
  /** Keys ({@link agentReportKey}) the user excluded from the bundle. */
  excluded: ReadonlySet<string>;
  /** Include (`true`) or exclude (`false`) one report. */
  onToggle: (key: string, include: boolean) => void;
}

/**
 * The "Connected agents" part of the Export Diagnostics preview (#3574): each
 * already-connected remote agent's crash reports with an include checkbox, plus
 * a note for agents that are too old to share them or could not be reached.
 * Renders nothing when no agent is connected.
 */
export function AgentCrashReportsSection({
  agents,
  agentName,
  excluded,
  onToggle,
}: AgentCrashReportsSectionProps) {
  if (agents === null) {
    return (
      <p className="diagnostics__note" data-testid="diagnostics-agent-reports-loading">
        Checking connected agents for crash reports…
      </p>
    );
  }
  if (agents.length === 0) return null;

  return (
    <section className="diagnostics__agents" data-testid="diagnostics-agent-reports">
      <p className="diagnostics__note">
        Crash reports from connected agents (fetched over the existing connection, redacted again
        before saving):
      </p>
      <ul className="diagnostics__list">
        {agents.map((agent) => (
          <AgentRows
            key={agent.agentId}
            agent={agent}
            name={agentName(agent.agentId)}
            excluded={excluded}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </section>
  );
}

interface AgentRowsProps {
  agent: AgentCrashReports;
  name: string;
  excluded: ReadonlySet<string>;
  onToggle: (key: string, include: boolean) => void;
}

/** One agent's rows: its reports, or why it has none to offer. */
function AgentRows({ agent, name, excluded, onToggle }: AgentRowsProps) {
  let status: string | null = null;
  if (!agent.supported) status = "skipped — this agent version cannot share crash reports";
  else if (agent.error) status = `skipped — could not list crash reports: ${agent.error}`;
  else if (agent.reports.length === 0) status = "no crash reports";

  if (status !== null) {
    return (
      <li className="diagnostics__row" data-testid={`diagnostics-agent-${agent.agentId}`}>
        <span className="diagnostics__name">{name}</span>
        <span className="diagnostics__meta">{status}</span>
      </li>
    );
  }

  return (
    <>
      {agent.reports.map((report) => {
        const key = agentReportKey(agent.agentId, report.name);
        const id = `diagnostics-agent-report-${agent.agentId}-${report.name}`;
        return (
          <li key={key} className="diagnostics__row">
            <span className="diagnostics__check">
              <Checkbox
                id={id}
                checked={!excluded.has(key)}
                onCheckedChange={(include) => onToggle(key, include)}
                data-testid={id}
              />
              <label htmlFor={id} className="diagnostics__name">
                {name}: {report.name}
              </label>
            </span>
            <span className="diagnostics__meta">
              Remote agent crash report · {formatBytes(report.size)}
            </span>
          </li>
        );
      })}
    </>
  );
}
