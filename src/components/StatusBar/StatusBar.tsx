import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Activity, RefreshCw, Unplug, Loader2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { SshConfig, ConnectionConfig } from "@/types/terminal";
import { SavedConnection } from "@/types/connection";
import { SystemStats } from "@/types/monitoring";
import "./StatusBar.css";

const INDENT_SIZES = [1, 2, 4, 8] as const;
const REFRESH_INTERVAL_MS = 5000;

/** Format seconds into a human-readable uptime string. */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Format kB into a human-readable size. */
function formatKb(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / (1024 * 1024)).toFixed(1)} GB`;
}

/** Extract SshConfig from a saved connection, if it's SSH type. */
function extractSshConfig(config: ConnectionConfig): SshConfig | null {
  if (config.type === "ssh") return config.config;
  return null;
}

/** Get severity level for a percentage value. */
function severityLevel(value: number): "normal" | "warning" | "critical" {
  if (value >= 90) return "critical";
  if (value >= 70) return "warning";
  return "normal";
}

/**
 * Status bar displayed at the bottom of the application window.
 * Shows monitoring stats on the left and editor status on the right.
 */
export function StatusBar() {
  const editorStatus = useAppStore((s) => s.editorStatus);
  const editorActions = useAppStore((s) => s.editorActions);

  const indentLabel = editorStatus
    ? editorStatus.insertSpaces
      ? `Spaces: ${editorStatus.tabSize}`
      : `Tab Size: ${editorStatus.tabSize}`
    : "";

  return (
    <div className="status-bar">
      <div className="status-bar__section status-bar__section--left">
        <MonitoringStatus />
      </div>
      <div className="status-bar__section status-bar__section--center" />
      <div className="status-bar__section status-bar__section--right">
        {editorStatus && (
          <>
            <span className="status-bar__item">
              Ln {editorStatus.line}, Col {editorStatus.column}
            </span>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  className="status-bar__item status-bar__item--interactive"
                  title="Select indentation"
                  data-testid="status-bar-tab-size"
                >
                  {indentLabel}
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="indent-menu__content"
                  side="top"
                  align="start"
                  sideOffset={4}
                >
                  <DropdownMenu.Label className="indent-menu__label">
                    Indent Using Spaces
                  </DropdownMenu.Label>
                  {INDENT_SIZES.map((size) => (
                    <DropdownMenu.Item
                      key={`spaces-${size}`}
                      className="indent-menu__item"
                      onSelect={() => editorActions?.setIndent(size, true)}
                      data-testid={`indent-spaces-${size}`}
                    >
                      {size} {size === 1 ? "Space" : "Spaces"}
                    </DropdownMenu.Item>
                  ))}
                  <DropdownMenu.Separator className="indent-menu__separator" />
                  <DropdownMenu.Label className="indent-menu__label">
                    Indent Using Tabs
                  </DropdownMenu.Label>
                  {INDENT_SIZES.map((size) => (
                    <DropdownMenu.Item
                      key={`tabs-${size}`}
                      className="indent-menu__item"
                      onSelect={() => editorActions?.setIndent(size, false)}
                      data-testid={`indent-tabs-${size}`}
                    >
                      Tab Size: {size}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <span className="status-bar__item">{editorStatus.encoding}</span>
            <button
              className="status-bar__item status-bar__item--interactive"
              onClick={() => editorActions?.toggleEol()}
              title="Toggle line endings"
              data-testid="status-bar-eol"
            >
              {editorStatus.eol}
            </button>
            <LanguageSelector
              currentLanguage={editorStatus.language}
              languages={editorStatus.availableLanguages}
              onSelect={(id) => editorActions?.setLanguage(id)}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Monitoring status displayed in the status bar left section.
 * Shows a connection picker when disconnected, and compact stats when connected.
 */
function MonitoringStatus() {
  const monitoringSessionId = useAppStore((s) => s.monitoringSessionId);
  const monitoringHost = useAppStore((s) => s.monitoringHost);
  const monitoringStats = useAppStore((s) => s.monitoringStats);
  const monitoringLoading = useAppStore((s) => s.monitoringLoading);
  const monitoringError = useAppStore((s) => s.monitoringError);
  const connectMonitoring = useAppStore((s) => s.connectMonitoring);
  const disconnectMonitoring = useAppStore((s) => s.disconnectMonitoring);
  const refreshMonitoring = useAppStore((s) => s.refreshMonitoring);

  const connections = useAppStore((s) => s.connections);
  const externalSources = useAppStore((s) => s.externalSources);

  const sshConnections = useMemo(() => {
    const result: SavedConnection[] = [];
    for (const c of connections) {
      if (c.config.type === "ssh") result.push(c);
    }
    for (const source of externalSources) {
      for (const c of source.connections) {
        if (c.config.type === "ssh") result.push(c);
      }
    }
    return result;
  }, [connections, externalSources]);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-refresh polling
  useEffect(() => {
    if (monitoringSessionId) {
      intervalRef.current = setInterval(() => {
        refreshMonitoring();
      }, REFRESH_INTERVAL_MS);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [monitoringSessionId, refreshMonitoring]);

  const handleConnect = useCallback(
    (connection: SavedConnection) => {
      const sshConfig = extractSshConfig(connection.config);
      if (sshConfig) {
        connectMonitoring(sshConfig);
      }
    },
    [connectMonitoring]
  );

  // Not connected: show connect button (or loading/error state)
  if (!monitoringSessionId) {
    if (sshConnections.length === 0) return null;

    return (
      <>
        {monitoringLoading && (
          <span
            className="status-bar__item monitoring-status__loading"
            data-testid="monitoring-loading"
          >
            <Loader2 size={12} className="monitoring-status__spinner" />
            Connecting...
          </span>
        )}

        {monitoringError && (
          <span
            className="status-bar__item monitoring-status__error"
            title={monitoringError}
            data-testid="monitoring-error"
          >
            Monitor error
          </span>
        )}

        {!monitoringLoading && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                className="status-bar__item status-bar__item--interactive"
                title="Connect monitoring"
                data-testid="monitoring-connect-btn"
              >
                <Activity size={12} />
                Monitor
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="monitoring-picker__content"
                side="top"
                align="start"
                sideOffset={4}
              >
                <DropdownMenu.Label className="monitoring-picker__label">
                  Connect Monitoring
                </DropdownMenu.Label>
                {sshConnections.map((conn) => (
                  <DropdownMenu.Item
                    key={conn.id}
                    className="monitoring-picker__item"
                    onSelect={() => handleConnect(conn)}
                    data-testid={`monitoring-connect-${conn.id}`}
                  >
                    {conn.name}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </>
    );
  }

  // Connected: show compact stats
  return (
    <>
      <MonitoringDetailDropdown
        host={monitoringHost}
        stats={monitoringStats}
        loading={monitoringLoading}
        onRefresh={refreshMonitoring}
        onDisconnect={disconnectMonitoring}
      />
      {monitoringStats && (
        <>
          <span
            className={`status-bar__item monitoring-status__stat monitoring-status__stat--${severityLevel(monitoringStats.cpuUsagePercent)}`}
            title={`CPU: ${monitoringStats.cpuUsagePercent.toFixed(1)}%`}
            data-testid="monitoring-cpu"
          >
            CPU {monitoringStats.cpuUsagePercent.toFixed(0)}%
          </span>
          <span
            className={`status-bar__item monitoring-status__stat monitoring-status__stat--${severityLevel(monitoringStats.memoryUsedPercent)}`}
            title={`Memory: ${formatKb(monitoringStats.memoryTotalKb - monitoringStats.memoryAvailableKb)} / ${formatKb(monitoringStats.memoryTotalKb)}`}
            data-testid="monitoring-mem"
          >
            Mem {monitoringStats.memoryUsedPercent.toFixed(0)}%
          </span>
          <span
            className={`status-bar__item monitoring-status__stat monitoring-status__stat--${severityLevel(monitoringStats.diskUsedPercent)}`}
            title={`Disk: ${formatKb(monitoringStats.diskUsedKb)} / ${formatKb(monitoringStats.diskTotalKb)}`}
            data-testid="monitoring-disk"
          >
            Disk {monitoringStats.diskUsedPercent.toFixed(0)}%
          </span>
        </>
      )}
    </>
  );
}

/**
 * Hostname button with dropdown showing full monitoring details.
 */
function MonitoringDetailDropdown({
  host,
  stats,
  loading,
  onRefresh,
  onDisconnect,
}: {
  host: string | null;
  stats: SystemStats | null;
  loading: boolean;
  onRefresh: () => void;
  onDisconnect: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="status-bar__item status-bar__item--interactive monitoring-status__host"
          title={host ?? "Monitoring"}
          data-testid="monitoring-host"
        >
          <Activity size={12} />
          {host}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="monitoring-menu__content"
          side="top"
          align="start"
          sideOffset={4}
        >
          {stats && (
            <>
              <div className="monitoring-menu__info">
                <div className="monitoring-menu__row">
                  <span className="monitoring-menu__label">Host</span>
                  <span className="monitoring-menu__value">{stats.hostname}</span>
                </div>
                <div className="monitoring-menu__row">
                  <span className="monitoring-menu__label">OS</span>
                  <span className="monitoring-menu__value">{stats.osInfo}</span>
                </div>
                <div className="monitoring-menu__row">
                  <span className="monitoring-menu__label">Uptime</span>
                  <span className="monitoring-menu__value">
                    {formatUptime(stats.uptimeSeconds)}
                  </span>
                </div>
                <div className="monitoring-menu__row">
                  <span className="monitoring-menu__label">Load</span>
                  <span className="monitoring-menu__value">
                    {stats.loadAverage.map((v) => v.toFixed(2)).join(" ")}
                  </span>
                </div>
              </div>
              <DropdownMenu.Separator className="monitoring-menu__separator" />
            </>
          )}
          <DropdownMenu.Item
            className="monitoring-menu__action"
            onSelect={onRefresh}
            disabled={loading}
            data-testid="monitoring-refresh"
          >
            <RefreshCw size={14} className={loading ? "monitoring-status__spinner" : ""} />
            Refresh
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="monitoring-menu__action"
            onSelect={onDisconnect}
            data-testid="monitoring-disconnect"
          >
            <Unplug size={14} />
            Disconnect
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Language selector dropdown with search filtering.
 */
function LanguageSelector({
  currentLanguage,
  languages,
  onSelect,
}: {
  currentLanguage: string;
  languages: { id: string; name: string }[];
  onSelect: (languageId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const displayName = languages.find((l) => l.id === currentLanguage)?.name ?? currentLanguage;

  const filtered = useMemo(() => {
    if (!search) return languages;
    const lower = search.toLowerCase();
    return languages.filter(
      (l) => l.name.toLowerCase().includes(lower) || l.id.toLowerCase().includes(lower)
    );
  }, [languages, search]);

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (!isOpen) setSearch("");
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          className="status-bar__item status-bar__item--interactive"
          title="Select language mode"
          data-testid="status-bar-language"
        >
          {displayName}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="lang-menu__content"
          side="top"
          align="end"
          sideOffset={4}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className="lang-menu__search-wrapper">
            <input
              className="lang-menu__search"
              placeholder="Search languages..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              autoFocus
              data-testid="lang-menu-search"
            />
          </div>
          <div className="lang-menu__list">
            {filtered.map((lang) => (
              <DropdownMenu.Item
                key={lang.id}
                className="lang-menu__item"
                onSelect={() => onSelect(lang.id)}
                data-testid={`lang-${lang.id}`}
              >
                {lang.name}
                {lang.id !== lang.name.toLowerCase() && (
                  <span className="lang-menu__item-id">{lang.id}</span>
                )}
              </DropdownMenu.Item>
            ))}
            {filtered.length === 0 && <div className="lang-menu__empty">No matching languages</div>}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
