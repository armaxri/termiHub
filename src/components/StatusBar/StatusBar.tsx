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
  Pause,
  Play,
  X,
  Check,
  ArrowUpCircle,
  Monitor,
  Highlighter,
  AppWindow,
  Infinity as InfinityIcon,
  Puzzle,
} from "lucide-react";
import { useAppStore, getActiveTab, monitorKeyForTab } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { useProjectedMonitors } from "@/store/useProjectedMonitors";
import { currentMonitorsView } from "@/store/systemMonitorBridge";
import { resolveHighlightingConfig } from "@/services/syntaxHighlightingConfig";
import { frontendLog } from "@/utils/frontendLog";
import { useDesktopVersion } from "@/hooks/useDesktopVersion";
import { useWindowInfo } from "@/hooks/useWindowInfo";
import { summarizeAgentUpdates } from "@/utils/agentVersion";
import { jumpHostStatusLabel } from "@/utils/jumpHost";
import type { ConnectionTypeInfo } from "@/services/api";
import {
  SystemStats,
  MonitorStatus,
  MONITORING_INTERVAL_OPTIONS,
  DEFAULT_MONITORING_INTERVAL_MS,
} from "@/types/monitoring";
import { resolveFeatureEnabled } from "@/utils/featureFlags";
import { CredentialStoreIndicator } from "@/components/CredentialStoreIndicator";
import { TransferQueueIndicator } from "@/components/TransferQueue";
import { Tooltip, toast } from "@/components/ui";
import { PortableBadge } from "./PortableBadge";
import { UpdateIndicator } from "./UpdateIndicator";
import { BroadcastStatus } from "./BroadcastStatus";
import { PluginStatusBarWidgets } from "./PluginStatusBarWidgets";
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

/** Format a monitoring refresh interval (ms) as a compact label like "2s" (#1233). */
function formatIntervalLabel(intervalMs: number): string {
  return `${Math.round(intervalMs / 1000)}s`;
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
        <WindowIndicator />
        <BroadcastStatus />
        <PortableBadge />
        <JumpHostStatus />
        <RemoteDesktopStatus />
        <MonitoringStatus />
        <PersistentSessionsIndicator />
        <ServicesIndicator />
        <PluginsIndicator />
        <AgentUpdatesIndicator />
        <TransferQueueIndicator />
        <CredentialStoreIndicator />
        <PluginStatusBarWidgets position="left" />
      </div>
      <div className="status-bar__section status-bar__section--center">
        {chordPending && (
          <span className="status-bar__item" data-testid="chord-pending-indicator">
            ({chordPending}) was pressed. Waiting for second key...
          </span>
        )}
      </div>
      <div className="status-bar__section status-bar__section--right">
        <PluginStatusBarWidgets position="right" />
        <HighlightingIndicator />
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
 * Status-bar window affordance (#1902, epic #1899).
 *
 * When more than one native window is open, the status bar shows this window's
 * name (e.g. "Window 2") so windows are distinguishable at a glance. With a
 * single window it renders nothing — there is nothing to disambiguate. The count
 * and label come from the backend window registry (#1900), since stores are not
 * shared across windows.
 */
function WindowIndicator() {
  const { name, count } = useWindowInfo();

  if (count <= 1) return null;

  return (
    <span className="status-bar__item" data-testid="status-bar-window" title={name}>
      <AppWindow size={13} />
      {name}
    </span>
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
 * Shared status-bar segment for the active graphical remote-desktop tab (#1709).
 *
 * Shows `<monitor> host:port · WxH · N-bit` while a `remote-desktop` tab is
 * active: `host:port` and colour depth come from the connection config, and the
 * live `WxH` resolution comes from the framebuffer surfaced to the store
 * (`remoteDesktopResolutions`, keyed by session id). Renders nothing for any
 * other active tab, so it disappears the moment a non-graphical tab is focused.
 */
function RemoteDesktopStatus() {
  const activeTab = useAppStore((s) => {
    const tab = getActiveTab(s);
    return tab?.contentType === "remote-desktop" ? tab : null;
  });
  const sessionId = activeTab?.sessionId ?? null;
  const resolution = useAppStore((s) =>
    sessionId ? s.remoteDesktopResolutions[sessionId] : undefined
  );

  if (!activeTab) return null;

  const cfg = activeTab.config.config as Record<string, unknown>;
  const host = (cfg.host as string | undefined) || activeTab.title || "remote";
  const port = cfg.port;
  const hostPort = port !== undefined && port !== null && port !== "" ? `${host}:${port}` : host;
  const colorDepth = cfg.colorDepth;

  const parts = [hostPort];
  if (resolution) parts.push(`${resolution.width}×${resolution.height}`);
  if (colorDepth !== undefined && colorDepth !== null && colorDepth !== "") {
    parts.push(`${colorDepth}-bit`);
  }
  const label = parts.join(" · ");

  return (
    <span
      className="status-bar__item"
      data-testid="status-bar-remote-desktop"
      title={`Remote desktop: ${label}`}
    >
      <Monitor size={13} />
      {label}
    </span>
  );
}

/**
 * Terminal output syntax-highlighting indicator + quick toggle (epic #1696,
 * child #1704).
 *
 * For the active terminal session it shows "Highlighting: ON/OFF" reflecting
 * the resolved state — the global config folded with the per-connection
 * override ({@link resolveHighlightingConfig}) — plus the runtime per-session
 * toggle. Clicking flips the non-persisted per-session toggle
 * (`setSessionHighlighting`) that the terminal engine reacts to (#1700), so a
 * reconnect/reopen (new session id) returns to the resolved default.
 *
 * Stays hidden unless the feature is globally enabled or already effectively on
 * for this session, keeping the status bar uncluttered until highlighting is in
 * use.
 */
function HighlightingIndicator() {
  const activeTab = useAppStore((s) => {
    const tab = getActiveTab(s);
    return tab?.contentType === "terminal" ? tab : null;
  });
  const tabId = activeTab?.id ?? null;
  const sessionId = activeTab?.sessionId ?? null;
  const globalConfig = useProjectedSettings().syntaxHighlighting;
  const perConnection = useAppStore((s) =>
    tabId ? s.tabTerminalOptions[tabId]?.syntaxHighlighting : undefined
  );
  const sessionOverride = useAppStore((s) =>
    sessionId ? s.sessionHighlighting[sessionId] : undefined
  );
  const setSessionHighlighting = useAppStore((s) => s.setSessionHighlighting);

  if (!activeTab || !sessionId) return null;

  const resolved = resolveHighlightingConfig(globalConfig, perConnection);
  const effective = sessionOverride ?? resolved.enabled;
  const globalEnabled = globalConfig?.enabled ?? false;

  // Stay hidden until the feature is in play: globally enabled, or already
  // effectively on for this session via a per-connection/-session override.
  if (!globalEnabled && !effective) return null;

  const tooltip = effective
    ? "Syntax highlighting is on for this session — click to turn off"
    : "Syntax highlighting is off for this session — click to turn on";

  return (
    <Tooltip content={tooltip} side="top">
      <button
        className="status-bar__item status-bar__item--interactive"
        aria-label={tooltip}
        aria-pressed={effective}
        data-testid="status-bar-highlighting"
        onClick={() => setSessionHighlighting(sessionId, !effective)}
      >
        <Highlighter size={12} />
        Highlighting: {effective ? "ON" : "OFF"}
      </button>
    </Tooltip>
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
 * Installed-plugin count in the status bar (#1997).
 *
 * Shows "N plugins · M enabled", reflecting the store's installed-plugin list
 * (enabled = state `active`). Clicking opens the Plugins sidebar view. Renders
 * nothing when no plugins are installed, keeping the bar uncluttered.
 */
function PluginsIndicator() {
  const plugins = useAppStore((s) => s.plugins);
  const setSidebarView = useAppStore((s) => s.setSidebarView);

  const total = plugins.length;
  if (total === 0) return null;

  const enabled = plugins.filter((p) => p.state === "active").length;
  const label = `${total} plugin${total !== 1 ? "s" : ""} · ${enabled} enabled — click to open Plugins`;

  return (
    <Tooltip content={label} side="top">
      <button
        className="status-bar__item status-bar__item--interactive"
        aria-label={label}
        data-testid="plugins-indicator"
        onClick={() => setSidebarView("plugins")}
      >
        <Puzzle size={12} />
        {total} · {enabled}
      </button>
    </Tooltip>
  );
}

/**
 * Background persistent-session count in the status bar (#1882).
 *
 * Counts the persistent connections whose background process is currently
 * running — state `running` or `attached`, matching the sidebar's
 * `isPersistentRunning` classification (ConnectionList / AgentNode). Both
 * desktop-local and agent-hosted persistent sessions share the store's
 * `persistentSessions` map, so a single count covers every background session.
 *
 * Gives at-a-glance awareness that processes are alive with no tab in front of
 * them; clicking opens the Connections sidebar where they can be attached or
 * stopped. Renders nothing when none are running, keeping the bar uncluttered.
 */
function PersistentSessionsIndicator() {
  const persistentSessions = useAppStore((s) => s.persistentSessions);
  const setSidebarView = useAppStore((s) => s.setSidebarView);

  const runningCount = Object.values(persistentSessions).filter(
    (entry) => entry.state === "running" || entry.state === "attached"
  ).length;

  if (runningCount === 0) return null;

  const sessionsLabel = `${runningCount} background session${
    runningCount !== 1 ? "s" : ""
  } running — click to open Connections`;

  return (
    <Tooltip content={sessionsLabel} side="top">
      <button
        className="status-bar__item status-bar__item--interactive"
        aria-label={sessionsLabel}
        data-testid="persistent-sessions-indicator"
        onClick={() => setSidebarView("connections")}
      >
        <InfinityIcon size={12} />
        {runningCount}
      </button>
    </Tooltip>
  );
}

/**
 * Connected-agent summary in the status bar (#1347). Shows `N agents` and, when
 * any connected agent's version is older than the desktop's, `· M updates
 * available`. Clicking opens the Connections sidebar. Renders nothing when no
 * agent is connected.
 */
function AgentUpdatesIndicator() {
  const remoteAgents = useAppStore((s) => s.remoteAgents);
  const setSidebarView = useAppStore((s) => s.setSidebarView);
  const desktopVersion = useDesktopVersion();

  const { connectedCount, updatesAvailable } = summarizeAgentUpdates(remoteAgents, desktopVersion);
  if (connectedCount === 0) return null;

  const agentLabel = `${connectedCount} agent${connectedCount !== 1 ? "s" : ""}`;
  const summary =
    updatesAvailable > 0
      ? `${agentLabel} · ${updatesAvailable} update${updatesAvailable !== 1 ? "s" : ""} available — click to open Connections`
      : `${agentLabel} connected — click to open Connections`;

  return (
    <Tooltip content={summary} side="top">
      <button
        className="status-bar__item status-bar__item--interactive"
        aria-label={summary}
        data-testid="agent-updates-indicator"
        onClick={() => setSidebarView("connections")}
      >
        <Server size={12} />
        {connectedCount}
        {updatesAvailable > 0 && (
          <span className="status-bar__agent-updates" data-testid="agent-updates-count">
            <ArrowUpCircle size={11} />
            {updatesAvailable}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/**
 * Monitoring status displayed in the status bar left section.
 * Shows a connection picker when disconnected, and compact stats when connected.
 */
function MonitoringStatus() {
  const globalMonitoringEnabled = useProjectedSettings().powerMonitoringEnabled;
  const disconnectMonitoring = useAppStore((s) => s.disconnectMonitoring);
  const setMonitoringPaused = useAppStore((s) => s.setMonitoringPaused);
  const setMonitoringInterval = useAppStore((s) => s.setMonitoringInterval);
  const cancelMonitoring = useAppStore((s) => s.cancelMonitoring);
  const sessionCapabilities = useAppStore((s) => s.sessionCapabilities);

  const connectionTypes = useAppStore((s) => s.connectionTypes);
  const activeTabId = useAppStore((s) => getActiveTab(s)?.id ?? null);
  const activeTabConnectionType = useAppStore((s) => getActiveTab(s)?.connectionType ?? null);
  const activeTabConfig = useAppStore((s) => getActiveTab(s)?.config ?? undefined);
  const activeTabExited = useAppStore((s) => !!(activeTabId && s.terminalExitedTabs[activeTabId]));

  // Per-host keying (#1231, audit gap G6): the status bar renders the entry for
  // the active tab's monitor key — the owning terminal session id (#1232).
  // Switching tabs just changes which entry we show — other hosts keep
  // monitoring independently.
  const activeMonitorKey = useAppStore((s) => monitorKeyForTab(getActiveTab(s)));
  // The active tab's monitor entry, sourced from the projected `system-monitors`
  // region when it faithfully mirrors `appStore`, else `appStore` verbatim
  // (#2224 render cut). Picking the active key stays a per-client (presentation)
  // concern under partial projection.
  const { monitors: projectedMonitors } = useProjectedMonitors();
  const activeMonitor = activeMonitorKey ? (projectedMonitors[activeMonitorKey] ?? null) : null;
  const monitoringConnected = !!activeMonitor?.monitorSessionId;
  const monitoringHost = activeMonitor?.host ?? null;
  const monitoringStats = activeMonitor?.stats ?? null;
  const monitoringSampleCount = activeMonitor?.sampleCount ?? 0;
  const monitoringLoading = activeMonitor?.loading ?? false;
  const monitoringError = activeMonitor?.error ?? null;
  const monitoringStatus = activeMonitor?.status ?? null;
  const monitoringPaused = activeMonitor?.paused ?? false;
  const monitoringInterval = activeMonitor?.intervalMs ?? DEFAULT_MONITORING_INTERVAL_MS;

  const activeTabSupportsMonitoring = typeSupportsMonitoring(
    connectionTypes,
    activeTabConnectionType ?? "",
    sessionCapabilities,
    activeMonitorKey
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
  // authenticated terminal session. Collection cadence and pause are driven by
  // the backend loop via setMonitoringInterval / setMonitoringPaused (#1233),
  // so there is no frontend poll timer.
  useEffect(() => {
    if (!monitoringEnabled) return;

    // Don't auto-connect while the terminal session has exited unexpectedly.
    if (activeTabExited) {
      autoConnectFailedRef.current = null;
      return;
    }

    const activeTab = getActiveTab(useAppStore.getState());
    if (!activeTab) return;

    // The monitor key is the owning terminal session id (#1232), so it doubles
    // as the sessionId passed to connectMonitoring.
    const key = monitorKeyForTab(activeTab);
    if (!key) return;

    // Already monitoring this session (connected or in flight) → nothing to do.
    // Switching tabs no longer tears down other hosts (#1231, audit gap G6). The
    // monitor state is read from the authoritative `system-monitors` region (#2224).
    const existing = currentMonitorsView().monitors[key];
    if (existing && (existing.monitorSessionId || existing.loading)) return;
    if (autoConnectFailedRef.current === key) return;
    autoConnectFailedRef.current = key;

    const cfg = activeTab.config.config;
    const hostLabel = (cfg.host as string) || activeTab.title || key;

    const doConnect = async () => {
      try {
        // Resolves once the backend has folded `opened` into the region; rejects
        // (with `openFailed` already recorded) on a failed connect. Clear the
        // failed latch only on success so a failing host is not retried in a loop.
        await useAppStore.getState().connectMonitoring(key, hostLabel);
        autoConnectFailedRef.current = null;
      } catch (err) {
        frontendLog("monitoring", `monitoring auto-connect failed for ${key}: ${err}`);
      }
    };

    doConnect();
  }, [
    activeTabId,
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

  /** Toggle pause/resume for the active monitor with toast feedback (#1233). */
  const handleSetPaused = useCallback(
    async (paused: boolean) => {
      if (!activeMonitorKey) return;
      try {
        await setMonitoringPaused(activeMonitorKey, paused);
        toast.success(paused ? "Monitoring paused" : "Monitoring resumed");
      } catch (err) {
        frontendLog("monitoring", `Failed to ${paused ? "pause" : "resume"} monitoring: ${err}`);
        toast.error(`Failed to ${paused ? "pause" : "resume"} monitoring: ${err}`);
      }
    },
    [activeMonitorKey, setMonitoringPaused]
  );

  /** Change the active monitor's refresh interval with toast feedback (#1233). */
  const handleSetInterval = useCallback(
    async (intervalMs: number) => {
      if (!activeMonitorKey) return;
      try {
        await setMonitoringInterval(activeMonitorKey, intervalMs);
        toast.success(`Refresh interval set to ${formatIntervalLabel(intervalMs)}`);
      } catch (err) {
        frontendLog("monitoring", `Failed to set monitoring interval: ${err}`);
        toast.error(`Failed to set interval: ${err}`);
      }
    },
    [activeMonitorKey, setMonitoringInterval]
  );

  /** Cancel an in-flight monitoring connect with toast feedback (#1233). */
  const handleCancel = useCallback(async () => {
    if (!activeMonitorKey) return;
    try {
      await cancelMonitoring(activeMonitorKey);
      toast.success("Monitoring connect cancelled");
    } catch (err) {
      frontendLog("monitoring", `Failed to cancel monitoring: ${err}`);
      toast.error(`Failed to cancel: ${err}`);
    }
  }, [activeMonitorKey, cancelMonitoring]);

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
          <>
            <span
              className="status-bar__item monitoring-status__loading"
              data-testid="monitoring-loading"
            >
              <Loader2 size={12} className="monitoring-status__spinner" />
              Connecting...
            </span>
            {/*
              Cancel aborts the in-flight connect and tears the entry down so a
              stuck handshake is never a dead-end (#1233).
            */}
            <Tooltip content="Cancel monitoring connect" side="top">
              <button
                className="status-bar__item status-bar__item--interactive"
                aria-label="Cancel monitoring connect"
                data-testid="monitoring-cancel-btn"
                onClick={handleCancel}
              >
                <X size={12} />
                Cancel
              </button>
            </Tooltip>
          </>
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
  const isOffline = monitoringStatus === "offline";
  // Paused dims the numbers like stale (they are frozen), but is signalled with a
  // neutral badge rather than a warning one (#1233).
  const staleModifier = isStale || monitoringPaused ? " monitoring-status__stat--stale" : "";
  return (
    <>
      <MonitoringDetailDropdown
        host={monitoringHost}
        stats={monitoringStats}
        loading={monitoringLoading}
        monitorKey={activeMonitorKey}
        status={monitoringStatus}
        paused={monitoringPaused}
        intervalMs={monitoringInterval}
        onDisconnect={() => activeMonitorKey && disconnectMonitoring(activeMonitorKey)}
        onSetPaused={handleSetPaused}
        onSetInterval={handleSetInterval}
        onCancel={handleCancel}
        onRetry={handleRetry}
      />
      {monitoringPaused && (
        <span
          className="status-bar__item monitoring-status__paused-badge"
          title="Monitoring is paused — collection is stopped but the connection stays open."
          data-testid="monitoring-paused"
        >
          <Pause size={12} />
          Paused
        </span>
      )}
      {isOffline && (
        <Tooltip content="Retry monitoring connection" side="top">
          <button
            className="status-bar__item status-bar__item--interactive monitoring-status__error"
            aria-label="Retry monitoring connection"
            data-testid="monitoring-retry-btn"
            onClick={handleRetry}
          >
            <RotateCw size={12} />
            Offline — Retry
          </button>
        </Tooltip>
      )}
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

/** Props for {@link MonitoringDetailDropdown}. */
interface MonitoringDetailDropdownProps {
  host: string | null;
  stats: SystemStats | null;
  loading: boolean;
  /** Active monitor key, or null when none is resolvable. */
  monitorKey: string | null;
  /** Observable collector-loop status of the active monitor. */
  status: MonitorStatus | null;
  /** Whether collection is currently paused (#1233). */
  paused: boolean;
  /** Current per-entry refresh interval in ms (#1233). */
  intervalMs: number;
  onDisconnect: () => void;
  /** Pause/resume collection (#1233). */
  onSetPaused: (paused: boolean) => void | Promise<void>;
  /** Change the refresh interval (#1233). */
  onSetInterval: (intervalMs: number) => void | Promise<void>;
  /** Abort an in-flight connect (#1233). */
  onCancel: () => void | Promise<void>;
  /** Retry after an offline/failed connect (#1233). */
  onRetry: () => void;
}

/**
 * Hostname button with dropdown showing full monitoring details plus lifecycle
 * controls: Pause/Resume, a refresh-interval selector, and — depending on the
 * collector status — a Cancel (connecting) or Retry (offline) affordance, in
 * addition to the existing Refresh + Disconnect (#1233).
 */
function MonitoringDetailDropdown({
  host,
  stats,
  loading,
  monitorKey,
  status,
  paused,
  intervalMs,
  onDisconnect,
  onSetPaused,
  onSetInterval,
  onCancel,
  onRetry,
}: MonitoringDetailDropdownProps) {
  const isConnecting = status === "connecting" || (loading && !stats);
  const isOffline = status === "offline";
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
          {/* Pause / Resume — keeps the transport open, toggles collection (#1233). */}
          <DropdownMenu.Item
            className="monitoring-menu__action"
            onSelect={() => onSetPaused(!paused)}
            disabled={!monitorKey}
            data-testid={paused ? "monitoring-resume-btn" : "monitoring-pause-btn"}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? "Resume monitoring" : "Pause monitoring"}
          </DropdownMenu.Item>

          {/* Cancel an in-flight connect, or Retry after going offline (#1233). */}
          {isConnecting && (
            <DropdownMenu.Item
              className="monitoring-menu__action"
              onSelect={() => onCancel()}
              disabled={!monitorKey}
              data-testid="monitoring-cancel-btn"
            >
              <X size={14} />
              Cancel connect
            </DropdownMenu.Item>
          )}
          {isOffline && (
            <DropdownMenu.Item
              className="monitoring-menu__action"
              onSelect={onRetry}
              data-testid="monitoring-retry-btn"
            >
              <RotateCw size={14} />
              Retry
            </DropdownMenu.Item>
          )}

          <DropdownMenu.Separator className="monitoring-menu__separator" />

          {/* Refresh-interval selector — radio-style items (#1233). */}
          <DropdownMenu.Label className="monitoring-menu__label monitoring-menu__interval-label">
            Refresh interval
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={String(intervalMs)}
            onValueChange={(v) => onSetInterval(Number(v))}
          >
            {MONITORING_INTERVAL_OPTIONS.map((opt) => (
              <DropdownMenu.RadioItem
                key={opt}
                className="monitoring-menu__action monitoring-menu__radio"
                value={String(opt)}
                disabled={!monitorKey}
                data-testid={`monitoring-interval-${opt}`}
              >
                <DropdownMenu.ItemIndicator className="monitoring-menu__radio-indicator">
                  <Check size={14} />
                </DropdownMenu.ItemIndicator>
                <span className="monitoring-menu__radio-label">
                  Refresh every {formatIntervalLabel(opt)}
                </span>
                {opt === DEFAULT_MONITORING_INTERVAL_MS && (
                  <span className="monitoring-menu__radio-default">default</span>
                )}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator className="monitoring-menu__separator" />

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
