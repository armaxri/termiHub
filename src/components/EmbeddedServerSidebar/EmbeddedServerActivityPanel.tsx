import { useMemo, useState, type ReactNode } from "react";
import { Copy, Trash2, X } from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { Button, EmptyState, SearchInput, toast } from "@/components/ui";
import { useEmbeddedServerActivity } from "@/hooks/useEmbeddedServerActivity";
import { formatBytes, formatClockTime } from "@/utils/formatters";
import { errorMessage } from "@/utils/errorMessage";
import { t, tf } from "@/i18n/catalog";
import { itemMatchesQuery } from "@/hooks/useListFilter";
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
  onClose: () => void;
}

/** What the panel says when there is nothing to read. */
export function unavailableMessage(
  live: boolean,
  hostAgent?: ActivityHostAgent
): {
  title: string;
  description: string;
} {
  if (hostAgent && !hostAgent.supportsActivity) {
    return {
      title: t("server.activity.unavailable"),
      description: tf("server.activity.oldAgent", { agent: hostAgent.name }),
    };
  }
  return live
    ? { title: t("server.activity.unavailable"), description: t("server.activity.noAnswer") }
    : { title: t("server.activity.notYet"), description: t("server.activity.appearsWhenRun") };
}

/** The visible, searchable fields of an access-log entry. */
function accessLogEntryFields(entry: AccessLogEntry): ReadonlyArray<string | null | undefined> {
  return [entry.client, entry.user, entry.method, entry.path, entry.status, entry.detail];
}

/**
 * Case- and diacritic-insensitive substring match of `query` against an entry's
 * visible fields, through the shared {@link itemMatchesQuery} (#4582).
 */
export function entryMatches(entry: AccessLogEntry, query: string): boolean {
  return itemMatchesQuery(entry, accessLogEntryFields, query.trim());
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
  return formatClockTime(timestamp) || timestamp;
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
 * paths/clients and a filterable, clearable list of requests (PROD-034,
 * PROD-036). Closed from its own heading, which is always there (#6063).
 */
export function EmbeddedServerActivityPanel({ serverId, live, hostAgent, onClose }: Props) {
  const { view, available, error, clear, retry } = useEmbeddedServerActivity(serverId, live);
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
      // toast-policy: no-in-place-surface — the entries are on the clipboard
      toast.success(`Copied ${visible.length} requests`);
    } catch (err) {
      toast.error("Failed to copy the requests", { description: errorMessage(err) });
    }
  };

  const handleClear = async () => {
    try {
      await clear();
    } catch (err) {
      toast.error("Failed to clear the requests", { description: errorMessage(err) });
    }
  };

  const panel = (content: ReactNode) => (
    <div
      className="server-activity"
      data-testid={`server-activity-${serverId}`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="server-activity__header">
        <span className="server-activity__title">{t("service.action.activity")}</span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t("server.activity.close")}
          icon={<X size={12} />}
          onClick={onClose}
          data-testid={`server-activity-close-${serverId}`}
        />
      </div>
      {content}
    </div>
  );
  const retryButton = (
    <Button
      variant="secondary"
      size="sm"
      onClick={retry}
      data-testid={`server-activity-retry-${serverId}`}
    >
      {t("service.action.retry")}
    </Button>
  );

  const { stats } = view;
  if (!available) {
    const message = unavailableMessage(live, hostAgent);
    const helps = live && (!hostAgent || hostAgent.supportsActivity);
    return panel(
      <EmptyState
        title={message.title}
        description={message.description}
        action={helps ? retryButton : undefined}
      />
    );
  }
  if (!stats && error) {
    return panel(
      <EmptyState
        title={t("server.activity.unavailable")}
        description={error}
        action={retryButton}
      />
    );
  }
  if (stats && stats.totalRequests === 0 && stats.totalConnections === 0) {
    return panel(
      <EmptyState
        title={t("server.activity.nobody")}
        description={t("server.activity.nobody.hint")}
        data-testid={`server-activity-empty-${serverId}`}
      />
    );
  }

  return panel(
    <>
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
          placeholder="Filter requests"
          aria-label="Filter requests"
          data-testid={`server-activity-filter-${serverId}`}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Copy requests"
          icon={<Copy size={12} />}
          disabled={visible.length === 0}
          onClick={handleCopy}
          data-testid={`server-activity-copy-${serverId}`}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Clear requests"
          icon={<Trash2 size={12} />}
          errorToast={false}
          onClick={handleClear}
          data-testid={`server-activity-clear-${serverId}`}
        />
      </div>
      {error && <span className="sidebar-list-item__error">{error}</span>}
      {visible.length === 0 ? (
        <EmptyState
          title={view.entries.length === 0 ? "No requests yet" : "No entries match the filter"}
          data-testid={`server-activity-empty-${serverId}`}
        />
      ) : (
        <ol className="server-activity__log" aria-label="Requests">
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
    </>
  );
}
