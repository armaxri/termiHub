import { useMemo, useState } from "react";
import { CircleAlert, Power, Shield, SlidersHorizontal, Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";
import type { PluginDetailMeta } from "@/types/terminal";
import type { InstalledPlugin } from "@/types/plugin";
import { Button, ConfirmDialog } from "@/components/ui";
import {
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  extensionPoints,
  hasSettings,
  pluginDotState,
  pluginStatusLabel,
  pluginTypeIcon,
  pluginTypeLabel,
} from "./pluginPresentation";
import "./Plugins.css";

/** Props for {@link PluginDetailPanel}. */
export interface PluginDetailPanelProps {
  /** Identifies which plugin to show; the live record is looked up by id. */
  meta: PluginDetailMeta;
  /** Whether this tab is the active, front-most tab (SplitView convention). */
  isVisible: boolean;
}

/**
 * Count open terminal tabs whose connection type is served by this plugin's
 * terminal-backend extension — i.e. sessions that would be torn down by an
 * uninstall. Non-backend plugins never own sessions, so this is always 0.
 */
function useActiveSessionCount(plugin: InstalledPlugin | undefined): number {
  const rootPanel = useAppStore((s) => s.rootPanel);
  return useMemo(() => {
    const backendType = plugin?.manifest.extensions.terminalBackend?.connectionType;
    if (!backendType) return 0;
    let count = 0;
    for (const leaf of getAllLeaves(rootPanel)) {
      for (const tab of leaf.tabs) {
        if (tab.contentType === "terminal" && tab.config.type === backendType) count += 1;
      }
    }
    return count;
  }, [rootPanel, plugin]);
}

/**
 * The plugin detail panel shown in the main area (#1997). Renders a plugin's
 * identity, extension points, requested permissions, and state-appropriate
 * actions: Enable/Disable, Retry (on error), Settings… (when the plugin declares
 * settings — deep-links into the Plugins settings category, #2000), and Uninstall.
 * Uninstall warns first when the plugin has live sessions.
 *
 * The plugin is looked up live from the store by {@link PluginDetailMeta.pluginId},
 * so enabling/disabling/uninstalling it (here or elsewhere) reflects immediately.
 */
export function PluginDetailPanel({ meta, isVisible }: PluginDetailPanelProps) {
  const plugin = useAppStore((s) => s.plugins.find((p) => p.manifest.id === meta.pluginId));
  const enablePlugin = useAppStore((s) => s.enablePlugin);
  const disablePlugin = useAppStore((s) => s.disablePlugin);
  const uninstallPlugin = useAppStore((s) => s.uninstallPlugin);
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);

  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const activeSessions = useActiveSessionCount(plugin);

  if (!isVisible) return null;

  if (!plugin) {
    return (
      <div className="plugin-detail" data-testid="plugin-detail">
        <div className="plugin-detail__empty" data-testid="plugin-detail-missing">
          This plugin is no longer installed.
        </div>
      </div>
    );
  }

  const { manifest, state, errorMessage } = plugin;
  const dot = pluginDotState(state);
  const TypeIcon = pluginTypeIcon(manifest.extensions);
  const points = extensionPoints(manifest.extensions);
  const isError = dot === "error";
  const isEnabled = dot === "enabled";
  const showSettings = hasSettings(manifest);

  const handleUninstall = () => uninstallPlugin(manifest.id);

  return (
    <div className="plugin-detail" data-testid="plugin-detail">
      <div className="plugin-detail__head">
        <div className={`plugin-detail__icon${isError ? " plugin-detail__icon--error" : ""}`}>
          <TypeIcon size={22} aria-hidden="true" />
        </div>
        <div>
          <div className="plugin-detail__name">
            {manifest.name}
            <span
              className={`plugin-detail__status plugin-detail__status--${dot}`}
              data-testid="plugin-detail-status"
            >
              <span className={`plugin-state-dot plugin-state-dot--${dot}`} aria-hidden="true" />
              {pluginStatusLabel(state)}
            </span>
          </div>
          <div className="plugin-detail__meta">
            v{manifest.version} · by {manifest.author} ·{" "}
            <code>{pluginTypeLabel(manifest.extensions)}</code>
          </div>
        </div>
      </div>

      {manifest.description && <p className="plugin-detail__desc">{manifest.description}</p>}

      {isError && errorMessage && (
        <div className="plugin-detail__error" data-testid="plugin-detail-error">
          <CircleAlert className="plugin-detail__error-icon" aria-hidden="true" />
          <div>{errorMessage}</div>
        </div>
      )}

      <div className="plugin-detail__block">
        <div className="plugin-detail__section-title">Extension Points</div>
        <div className="plugin-detail__list">
          {points.map((point) => {
            const Icon = point.icon;
            return (
              <div className="plugin-detail__item" key={point.key}>
                <Icon className="plugin-detail__item-icon" aria-hidden="true" />
                <span>
                  {point.label}
                  {point.detail && (
                    <>
                      {" — "}
                      <code>{point.detail}</code>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {manifest.permissions.length > 0 && (
        <div className="plugin-detail__block">
          <div className="plugin-detail__section-title">Permissions</div>
          <div className="plugin-detail__list">
            {manifest.permissions.map((perm) => (
              <div className="plugin-detail__item" key={perm}>
                <Shield
                  className="plugin-detail__item-icon plugin-detail__item-icon--perm"
                  aria-hidden="true"
                />
                <span className="plugin-detail__item-name">{PERMISSION_LABELS[perm]}</span>
                <span className="plugin-detail__item-desc">— {PERMISSION_DESCRIPTIONS[perm]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="plugin-detail__actions">
        {isError ? (
          <Button
            variant="primary"
            icon={<Power size={14} />}
            onClick={() => enablePlugin(manifest.id)}
            data-testid="plugin-action-retry"
          >
            Retry
          </Button>
        ) : isEnabled ? (
          <Button
            variant="secondary"
            icon={<Power size={14} />}
            onClick={() => disablePlugin(manifest.id)}
            data-testid="plugin-action-disable"
          >
            Disable
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Power size={14} />}
            onClick={() => enablePlugin(manifest.id)}
            data-testid="plugin-action-enable"
          >
            Enable
          </Button>
        )}

        {showSettings && (
          <Button
            variant="secondary"
            icon={<SlidersHorizontal size={14} />}
            onClick={() => openSettingsTab({ category: "plugins", pluginId: manifest.id })}
            data-testid="plugin-action-settings"
          >
            Settings…
          </Button>
        )}

        <Button
          variant="danger"
          icon={<Trash2 size={14} />}
          onClick={() => setConfirmUninstall(true)}
          data-testid="plugin-action-uninstall"
        >
          Uninstall
        </Button>
      </div>

      <ConfirmDialog
        open={confirmUninstall}
        title={`Uninstall ${manifest.name}?`}
        variant="danger"
        confirmLabel="Uninstall"
        message={
          activeSessions > 0
            ? `This plugin has ${activeSessions} active ${
                activeSessions === 1 ? "session" : "sessions"
              } that will be closed. This removes the plugin and its configuration.`
            : "This removes the plugin and its configuration."
        }
        confirmErrorToast={false}
        onConfirm={handleUninstall}
        onCancel={() => setConfirmUninstall(false)}
        testIdBase="plugin-uninstall"
      />
    </div>
  );
}
