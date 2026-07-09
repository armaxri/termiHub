import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Activity,
  AlertTriangle,
  Unplug,
  Loader2,
  Server,
  Route,
  RotateCw,
  ArrowDownUp,
} from "lucide-react";
import { useAppStore, getActiveTab, monitorKeyForTab, selectMonitor } from "@/store/appStore";
import { frontendLog } from "@/utils/frontendLog";
import { jumpHostStatusLabel } from "@/utils/jumpHost";
import type { ConnectionTypeInfo } from "@/services/api";
import { SystemStats } from "@/types/monitoring";
import { resolveFeatureEnabled } from "@/utils/featureFlags";
import { CredentialStoreIndicator } from "@/components/CredentialStoreIndicator";
import { Tooltip } from "@/components/ui";
import { PortableBadge } from "./PortableBadge";
import { UpdateIndicator } from "./UpdateIndicator";
import "./StatusBar.css";

const INDENT_SIZES = [1, 2, 4, 8] as const;

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

/** Check if a connection type supports monitoring.
 *
 * For "remote-session" tabs the desktop registry has no entry, so we check
 * the per-session capabilities fetched after the session was established.
 */
function typeSupportsMonitoring(
  connectionTypes: ConnectionTypeInfo[],
  typeId: string,
  sessionCapabilities: Record<string, { monitoring: boolean }>,
  sessionId: string | null
): boolean {
  if (typeId === "remote-session") {
    return sessionId != null && (sessionCapabilities[sessionId]?.monitoring ?? false);
  }
  const typeInfo = connectionTypes.find((ct) => ct.typeId === typeId);
  return typeInfo?.capabilities.monitoring ?? false;
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
  const chordPending = useAppStore((s) => s.chordPending);

  const indentLabel = editorStatus
    ? editorStatus.insertSpaces
      ? `Spaces: ${editorStatus.tabSize}`
      : `Tab Size: ${editorStatus.tabSize}`
    : "";

  return (
    <div className="status-bar" data-testid="status-bar">
      <div className="status-bar__section status-bar__section--left">
        <PortableBadge />
        <JumpHostStatus />
        <MonitoringStatus />
        <ServicesIndicator />
        <TransfersIndicator />
        <CredentialStoreIndicator />
      </div>
      <div className="status-bar__section status-bar__section--center">
        {chordPending && (
          <span className="status-bar__item" data-testid="chord-pending-indicator">
            ({chordPending}) was pressed. Waiting for second key...
          </span>
        )}
      </div>
      <div className="status-bar__section status-bar__section--right">
        <UpdateIndicator />
        {editorStatus && (
          <>
            <span className="status-bar__item">
              Ln {editorStatus.line}, Col {editorStatus.column}
            </span>
            <DropdownMenu.Root>
              <Tooltip content="Select indentation" side="top">
                <DropdownMenu.Trigger asChild>
                  <button
                    className="status-bar__item status-bar__item--interactive"
                    aria-label="Select indentation"
                    data-testid="status-bar-tab-size"
                  >
                    {indentLabel}
                  </button>
                </DropdownMenu.Trigger>
              </Tooltip>
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
            <Tooltip content="Toggle line endings" side="top">
              <button
                className="status-bar__item status-bar__item--interactive"
                onClick={() => editorActions?.toggleEol()}
                aria-label="Toggle line endings"
                data-testid="status-bar-eol"
              >
                {editorStatus.eol}
              </button>
            </Tooltip>
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
 * Shows the SSH jump-host (ProxyJump) chain for the active terminal.
 *
 * When the active tab connects through one or more bastions, the status bar
 * shows `SSH: user@target via gateway` so the hop chain is visible at a glance.
 * Hidden for direct connections and non-SSH tabs.
 */
function JumpHostStatus() {
  const activeTabConfig = useAppStore((s) => getActiveTab(s)?.config ?? undefined);
  const label = jumpHostStatusLabel(activeTabConfig);

  if (!label) return null;

  return (
    <span className="status-bar__item" data-testid="status-bar-jump-host" title={`SSH: ${label}`}>
      <Route size={13} />
      SSH: {label}
    </span>
  );
}

/**
 * Shows running embedded servers count in the status bar.
 * Clicking opens the Services sidebar panel.
 */
function ServicesIndicator() {
  const embeddedServerStates = useAppStore((s) => s.embeddedServerStates);
  const setSidebarView = useAppStore((s) => s.setSidebarView);

  const runningCount = Object.values(embeddedServerStates).filter(
    (s) => s.status === "running"
  ).length;

  if (runningCount === 0) return null;

  const servicesLabel = `${runningCount} service${runningCount !== 1 ? "s" : ""} running — click to open Services`;

  return (
    <Tooltip content={servicesLabel} side="top">
      <button
        className="status-bar__item status-bar__item--interactive"
        aria-label={servicesLabel}
        data-testid="services-indicator"
        onClick={() => setSidebarView("services")}
      >
        <Server size={12} />
        {runningCount}
      </button>
    </Tooltip>
  );
}

/**
 * Aggregate SFTP transfer indicator (#1247). Shows `N transfers · P%` where P is
 * the aggregate percentage across sized transfers; when every transfer is
 * indeterminate (unknown total), the percentage is omitted. Renders nothing
 * when no transfers are in flight.
 */
function TransfersIndicator() {
  const transfers = useAppStore((s) => s.transfers);

  const list = Object.values(transfers);
  const count = list.length;
  if (count === 0) return null;

  const sized = list.filter((t) => t.total > 0);
  const totalBytes = sized.reduce((sum, t) => sum + t.total, 0);
  const doneBytes = sized.reduce((sum, t) => sum + t.transferred, 0);
  const pct = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : null;

  const noun = count === 1 ? "transfer" : "transfers";
  const label = pct !== null ? `${count} ${noun} · ${pct}%` : `${count} ${noun}`;
  const tooltip = `${count} active SFTP ${count === 1 ? "transfer" : "transfers"}`;

  return (
    <Tooltip content={tooltip} side="top">
      <span className="status-bar__item" data-testid="status-bar-transfers" aria-label={tooltip}>
        <ArrowDownUp size={12} />
        {label}
      </span>
    </Tooltip>
  );
}

/**
 * Monitoring status displayed in the status bar left section.
 * Shows a connection picker when disconnected, and compact stats when connected.
 */
function MonitoringStatus() {
  const globalMonitoringEnabled = useAppStore((s) => s.settings.powerMonitoringEnabled);
  const disconnectMonitoring = useAppStore((s) => s.disconnectMonitoring);
  const sessionCapabilities = useAppStore((s) => s.sessionCapabilities);

  const connectionTypes = useAppStore((s) => s.connectionTypes);
  const activeTabId = useAppStore((s) => getActiveTab(s)?.id ?? null);
  const activeTabSessionId = useAppStore((s) => getActiveTab(s)?.sessionId ?? null);
  const activeTabConnectionType = useAppStore((s) => getActiveTab(s)?.connectionType ?? null);
  const activeTabConfig = useAppStore((s) => getActiveTab(s)?.config ?? undefined);
  const activeTabExited = useAppStore((s) => !!(activeTabId && s.terminalExitedTabs[activeTabId]));

  // Per-host keying (#1231, audit gap G6): the status bar renders the entry for
  // the active tab's monitor key (the owning session id). Switching tabs just
  // changes which entry we show — other hosts keep monitoring independently.
  const activeMonitorKey = useAppStore((s) => monitorKeyForTab(getActiveTab(s)));
  const activeMonitor = useAppStore((s) => selectMonitor(s, monitorKeyForTab(getActiveTab(s))));
  const monitoringConnected = !!activeMonitor?.monitorSessionId;
  const monitoringHost = activeMonitor?.host ?? null;
  const monitoringStats = activeMonitor?.stats ?? null;
  const monitoringSampleCount = activeMonitor?.sampleCount ?? 0;
  const monitoringLoading = activeMonitor?.loading ?? false;
  const monitoringError = activeMonitor?.error ?? null;
  const monitoringStatus = activeMonitor?.status ?? null;

  const activeTabSupportsMonitoring = typeSupportsMonitoring(
    connectionTypes,
    activeTabConnectionType ?? "",
    sessionCapabilities,
    activeTabSessionId
  );
  const monitoringEnabled = activeTabSupportsMonitoring
    ? resolveFeatureEnabled(activeTabConfig, "enableMonitoring", globalMonitoringEnabled)
    : false;

  /** Tracks which monitor key already failed auto-connect to prevent retry loops. */
  const autoConnectFailedRef = useRef<string | null>(null);

  /**
   * Bumped by the Retry control to re-run the auto-connect effect after clearing
   * the failed-host latch, so a failed auto-connect is not a dead-end (audit
   * gaps G7 + G9).
   */
  const [retryNonce, setRetryNonce] = useState(0);

  // Auto-connect monitoring when the active tab supports it. Every monitorable
  // tab — desktop-direct SSH and remote-session alike — subscribes to its own
  // terminal session's MonitoringProvider push path, keyed by that session id
  // (#1232). No credentials are prompted: the provider reuses the already
  // authenticated terminal session.
  useEffect(() => {
    if (!monitoringEnabled) return;

    // Don't auto-connect while the terminal session has exited unexpectedly.
    if (activeTabExited) {
      autoConnectFailedRef.current = null;
      return;
    }

    const activeTab = getActiveTab(useAppStore.getState());
    if (!activeTab) return;

    const key = monitorKeyForTab(activeTab);
    if (!key) return;

    // Already monitoring this session (connected or in flight) → nothing to do.
    // Switching tabs no longer tears down other hosts (#1231, audit gap G6).
    const existing = useAppStore.getState().monitors[key];
    if (existing && (existing.monitorSessionId || existing.loading)) return;
    if (autoConnectFailedRef.current === key) return;
    autoConnectFailedRef.current = key;

    const sessionId = activeTab.sessionId;
    if (!sessionId) return;
    const cfg = activeTab.config.config;
    const hostLabel = (cfg.host as string) || activeTab.title || sessionId;

    const doConnect = async () => {
      await useAppStore.getState().connectMonitoring(sessionId, hostLabel);
      if (useAppStore.getState().monitors[key]?.monitorSessionId) {
        autoConnectFailedRef.current = null;
      }
    };

    doConnect();
  }, [
    activeTabId,
    activeTabSessionId,
    activeMonitorKey,
    monitoringConnected,
    monitoringEnabled,
    activeTabExited,
    // Re-run auto-connect when the user hits Retry (audit gaps G7 + G9).
    retryNonce,
  ]);

  /**
   * Retry auto-connect after a failure. Clears the failed-host latch and the
   * stale error, then bumps the nonce so the auto-connect effect fires again
   * (audit gaps G7 + G9).
   */
  const handleRetry = useCallback(() => {
    frontendLog("monitoring", "user retrying monitoring auto-connect");
    autoConnectFailedRef.current = null;
    if (activeMonitorKey) {
      useAppStore.getState().clearMonitoringError(activeMonitorKey);
    }
    setRetryNonce((n) => n + 1);
  }, [activeMonitorKey]);

  // Hide monitoring UI when disabled or when active tab doesn't support monitoring
  if (!monitoringEnabled) return null;

  // While reconnecting we already have cached stats — skip the "Connecting" block
  // so the last-known data is shown immediately instead of a blank loading state.
  const isReconnectingWithCache =
    !monitoringConnected && monitoringLoading && monitoringStats !== null;

  // Not connected: show connect button (or loading/error/cancelled state)
  if (!monitoringConnected && !isReconnectingWithCache) {
    // Monitoring auto-connects for every monitorable tab, so the disconnected
    // arm only ever surfaces transient feedback: the connecting spinner, or a
    // failed-connect error with a reachable Retry (audit gaps G7 + G9). When
    // there is nothing to show, render nothing and let auto-connect run.
    if (!monitoringLoading && !monitoringError) return null;

    const showRetry = !monitoringLoading && monitoringError !== null;

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

        {showRetry && (
          <Tooltip content="Retry monitoring connection" side="top">
            <button
              className="status-bar__item status-bar__item--interactive"
              aria-label="Retry monitoring connection"
              data-testid="monitoring-retry-btn"
              onClick={handleRetry}
            >
              <RotateCw size={12} />
              Retry
            </button>
          </Tooltip>
        )}
      </>
    );
  }

  // Connected (or reconnecting with cached stats): show compact stats.
  // A "stale" status (mid-stream drop) dims the numbers and shows a warning
  // badge so frozen data is never rendered as live (#1229, audit gap G1).
  const isStale = monitoringStatus === "stale";
  const staleModifier = isStale ? " monitoring-status__stat--stale" : "";
  return (
    <>
      <MonitoringDetailDropdown
        host={monitoringHost}
        stats={monitoringStats}
        loading={monitoringLoading}
        onDisconnect={() => activeMonitorKey && disconnectMonitoring(activeMonitorKey)}
      />
      {monitoringStats && (
        <>
          {/*
            A mid-stream transport drop moves the collector loop to "stale"
            (#1229, audit gap G1). The last-known numbers are kept but dimmed and
            prefixed with a warning badge so frozen data is never shown as live.
            Recovery flips the status back to "live" and un-dims them.
          */}
          {isStale && (
            <span
              className="status-bar__item monitoring-status__stale-badge"
              title="Monitoring data is stale — the connection dropped and the numbers below are frozen at their last-known values."
              data-testid="monitoring-stale"
            >
              <AlertTriangle size={12} />
              Stale
            </span>
          )}
          {/*
            The remote collectors report CPU 0% on the first sample because there
            is no prior delta to compute a rate from (audit gap G10). Until the
            second sample arrives, show a priming indicator so the placeholder is
            not mistaken for a real 0% reading. Memory and disk are correct on
            the first sample and always render numerically.
          */}
          {monitoringSampleCount < 2 ? (
            <span
              className={`status-bar__item monitoring-status__stat monitoring-status__stat--priming${staleModifier}`}
              title="CPU: priming (waiting for second sample)"
              data-testid="monitoring-cpu"
            >
              CPU —
            </span>
          ) : (
            <span
              className={`status-bar__item monitoring-status__stat monitoring-status__stat--${severityLevel(monitoringStats.cpuUsagePercent)}${staleModifier}`}
              title={`CPU: ${monitoringStats.cpuUsagePercent.toFixed(1)}%`}
              data-testid="monitoring-cpu"
            >
              CPU {monitoringStats.cpuUsagePercent.toFixed(0)}%
            </span>
          )}
          <span
            className={`status-bar__item monitoring-status__stat monitoring-status__stat--${severityLevel(monitoringStats.memoryUsedPercent)}${staleModifier}`}
            title={`Memory: ${formatKb(monitoringStats.memoryTotalKb - monitoringStats.memoryAvailableKb)} / ${formatKb(monitoringStats.memoryTotalKb)}`}
            data-testid="monitoring-mem"
          >
            Mem {monitoringStats.memoryUsedPercent.toFixed(0)}%
          </span>
          <span
            className={`status-bar__item monitoring-status__stat monitoring-status__stat--${severityLevel(monitoringStats.diskUsedPercent)}${staleModifier}`}
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
  onDisconnect,
}: {
  host: string | null;
  stats: SystemStats | null;
  loading: boolean;
  onDisconnect: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="status-bar__item status-bar__item--interactive monitoring-status__host"
          // Intentional no-tooltip (#1163): the visible label already shows the
          // hostname, so a normal-state hover would only duplicate it. Keep a
          // title only while reconnecting, where it conveys transient state the
          // collapsed spinner label does not spell out.
          title={loading ? `Reconnecting to ${host ?? "monitor"}…` : undefined}
          data-testid="monitoring-host"
        >
          {loading ? (
            <Loader2 size={12} className="monitoring-status__spinner" />
          ) : (
            <Activity size={12} />
          )}
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
      <Tooltip content="Select language mode" side="top">
        <DropdownMenu.Trigger asChild>
          <button
            className="status-bar__item status-bar__item--interactive"
            aria-label="Select language mode"
            data-testid="status-bar-language"
          >
            {displayName}
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
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
