import { useMemo, useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { Button, EmptyState, SearchInput, toast } from "@/components/ui";
import { useEmbeddedServerActivity } from "@/hooks/useEmbeddedServerActivity";
import { formatBytes } from "@/utils/formatters";
import { errorMessage } from "@/utils/errorMessage";
import type { AccessLogEntry, DetailedServerStats, TopEntry } from "@/types/embeddedServer";

/** The agent a server is hosted on, when it runs on one (#3453). */
export interface ActivityHostAgent {
  /** Display name of the agent. */
  name: string;
  /** Whether the agent serves the access log (`embeddedServerActivity`). */
  supportsActivity: boolean;
}

interface Props {
  serverId: string;
  /** Whether the server is running (the log is polled live only then). */
  live: boolean;
  /** Set when the server runs on a remote agent rather than this computer. */
  hostAgent?: ActivityHostAgent;
}

/** Empty-state copy when the backend has no log for the server. */
export function unavailableMessage(hostAgent?: ActivityHostAgent): {
  title: string;
  description: string;
} {
  if (hostAgent && !hostAgent.supportsActivity) {
    return {
      title: "Access log not supported by this agent version",
      description: `Update ${hostAgent.name} to see this server's access log and detailed stats.`,
    };
  }
  return {
    title: "No access log yet",
    description: hostAgent
      ? `The log appears once the server has run on ${hostAgent.name}.`
      : "The log appears once the server has run on this computer.",
  };
}

/** Case-insensitive match of `query` against an entry's visible fields. */
export function entryMatches(entry: AccessLogEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [entry.client, entry.user, entry.method, entry.path, entry.status, entry.detail].some(
    (field) => field?.toLowerCase().includes(q)
  );
}

/** Render one entry as a tab-separated line for export. */
export function entryToTsv(entry: AccessLogEntry): string {
  return [
    entry.timestamp,
    entry.client ?? "",
    entry.user ?? "",
    entry.method,
    entry.path ?? "",
    entry.status,
    String(entry.bytes),
    entry.durationMs === undefined ? "" : String(entry.durationMs),
    entry.detail ?? "",
  ].join("\t");
}

const TSV_HEADER = "time\tclient\tuser\tmethod\tpath\tstatus\tbytes\tduration_ms\tdetail";

function timeOf(timestamp: string): string {
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? timestamp : d.toLocaleTimeString();
}

function StatsGrid({ stats, dropped }: { stats: DetailedServerStats; dropped: number }) {
  const items: [string, string][] = [
    ["Requests", String(stats.totalRequests)],
    ["Errors", String(stats.errors)],
    ["Active", String(stats.activeConnections)],
    ["Sent", formatBytes(stats.bytesSent, { maxUnit: "GB" })],
    ["Received", formatBytes(stats.bytesReceived, { maxUnit: "GB" })],
  ];
  if (dropped > 0) items.push(["Dropped", String(dropped)]);
  return (
    <dl className="server-activity__stats">
      {items.map(([label, value]) => (
        <div key={label} className="server-activity__stat">
          <dt>{label}</dt>
          <dd data-testid={`server-activity-stat-${label.toLowerCase()}`}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TopList({ title, items }: { title: string; items: TopEntry[] }) {
  if (items.length === 0) return null;
  return (
    <div className="server-activity__top">
      <span className="server-activity__heading">{title}</span>
      <ul>
        {items.map((item) => (
          <li key={item.key}>
            <span className="server-activity__mono">{item.key}</span>
            <span className="server-activity__count">{item.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Expandable per-server activity panel: detailed stats, current transfers, top
 * paths/clients and a filterable, clearable access log (PROD-034, PROD-036).
 */
export function EmbeddedServerActivityPanel({ serverId, live, hostAgent }: Props) {
  const { view, available, error, clear } = useEmbeddedServerActivity(serverId, live);
  const [filter, setFilter] = useState("");

  const visible = useMemo(
    () =>
      view.entries
        .filter((e) => entryMatches(e, filter))
        .slice()
        .reverse(),
    [view.entries, filter]
  );

  const handleCopy = async () => {
    const text = [TSV_HEADER, ...visible.map(entryToTsv)].join("\n");
    try {
      await writeClipboard(text);
      toast.success(`Copied ${visible.length} log entries`);
    } catch (err) {
      toast.error("Failed to copy access log", { description: errorMessage(err) });
    }
  };

  const handleClear = async () => {
    try {
      await clear();
      toast.success("Access log cleared");
    } catch (err) {
      toast.error("Failed to clear access log", { description: errorMessage(err) });
    }
  };

  if (!available) {
    const message = unavailableMessage(hostAgent);
    return (
      <div className="server-activity" data-testid={`server-activity-${serverId}`}>
        <EmptyState title={message.title} description={message.description} />
      </div>
    );
  }

  const stats = view.stats;
  return (
    <div
      className="server-activity"
      data-testid={`server-activity-${serverId}`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {stats && <StatsGrid stats={stats} dropped={view.dropped} />}
      {stats && stats.currentTransfers.length > 0 && (
        <div className="server-activity__top" data-testid={`server-activity-transfers-${serverId}`}>
          <span className="server-activity__heading">Current transfers</span>
          <ul>
            {stats.currentTransfers.map((t) => (
              <li key={t.id}>
                <span className="server-activity__mono">
                  {t.method} {t.path ?? ""} {t.client ? `· ${t.client}` : ""}
                </span>
                <span className="server-activity__count">{formatBytes(t.bytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {stats && <TopList title="Top paths" items={stats.topPaths} />}
      {stats && <TopList title="Top clients" items={stats.topClients} />}
      <div className="server-activity__toolbar">
        <SearchInput
          size="sm"
          value={filter}
          onValueChange={setFilter}
          placeholder="Filter log"
          aria-label="Filter access log"
          data-testid={`server-activity-filter-${serverId}`}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Copy access log"
          icon={<Copy size={12} />}
          disabled={visible.length === 0}
          onClick={handleCopy}
          data-testid={`server-activity-copy-${serverId}`}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Clear access log"
          icon={<Trash2 size={12} />}
          errorToast={false}
          onClick={handleClear}
          data-testid={`server-activity-clear-${serverId}`}
        />
      </div>
      {error && <span className="sidebar-list-item__error">{error}</span>}
      {visible.length === 0 ? (
        <span className="server-activity__empty" data-testid={`server-activity-empty-${serverId}`}>
          {view.entries.length === 0 ? "No requests yet" : "No entries match the filter"}
        </span>
      ) : (
        <ol className="server-activity__log" aria-label="Access log">
          {visible.map((e) => (
            <li
              key={e.seq}
              className={
                e.success
                  ? "server-activity__row"
                  : "server-activity__row server-activity__row--error"
              }
              data-testid={`server-activity-row-${e.seq}`}
              title={e.detail}
            >
              <span className="server-activity__time">{timeOf(e.timestamp)}</span>
              <span className="server-activity__mono">
                {e.method} {e.path ?? ""}
              </span>
              <span className="server-activity__status">{e.status}</span>
              <span className="server-activity__meta">
                {[
                  e.client,
                  e.user,
                  formatBytes(e.bytes),
                  e.durationMs === undefined ? "" : `${e.durationMs} ms`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
