import { useMemo, useState } from "react";
import { CircleAlert, Power, Shield, SlidersHorizontal, Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useLayoutRenderTree } from "@/store/layoutSelectors";
import { getAllLeaves } from "@/utils/panelTree";
import { pluginConnectionTypeId } from "@/utils/pluginConnectionTypes";
import type { PluginDetailMeta } from "@/types/terminal";
import type { InstalledPlugin } from "@/types/plugin";
import { Button, ConfirmDialog, StatusDot } from "@/components/ui";
import {
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  extensionPoints,
  hasSettings,
  pluginDotState,
  pluginDotTone,
  pluginStatusLabel,
  pluginTypeIcon,
  pluginTypeLabel,
} from "./pluginPresentation";
import { pluginPlatformSupport } from "./pluginPlatforms";
import { PluginPlatformList } from "./PluginPlatformList";
import { PluginUpdateSection } from "./PluginUpdateSection";
import { currentIndexOffer, usePluginUpdateStore } from "@/plugins/pluginUpdateStore";
import { usePluginHostPlatform } from "@/hooks/usePluginHostPlatform";
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
  const rootPanel = useLayoutRenderTree();
  return useMemo(() => {
    const declared = plugin?.manifest.extensions.terminalBackend?.connectionType;
    if (!plugin || !declared) return 0;
    // Sessions carry the plugin's namespaced registry id, not the bare
    // manifest `connectionType` (PLG-007).
    const backendType = pluginConnectionTypeId(plugin.manifest.id, declared);
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
 * identity, extension points, supported platforms (native plugins, #3507),
 * requested permissions, and state-appropriate
 * actions: Enable/Disable, Retry (on error), Settings… (when the plugin declares
 * settings — deep-links into the Plugins settings category, #2000), and Uninstall.
 * Uninstall warns first when the plugin has live sessions.
 *
 * A plugin whose `manifest.json` no longer validates (`invalidManifest`, #4392)
 * is listed under a placeholder manifest and can never be enabled, so the panel
 * shows only its name, whatever version/author could be read, the rejection
 * reason and Uninstall — no Retry, no empty meta fragments or Extension Points
 * (#4578).
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
  const hostPlatform = usePluginHostPlatform();
  const hasIndexOffer = usePluginUpdateStore((s) =>
    plugin ? currentIndexOffer(s.indexOffers, plugin) !== undefined : false
  );

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
  const isInvalidManifest = plugin.invalidManifest === true;
  const isEnabled = dot === "enabled";
  const showSettings = hasSettings(manifest);
  const platforms = pluginPlatformSupport(manifest, hostPlatform);

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
              <StatusDot tone={pluginDotTone(dot)} ariaHidden />
              {pluginStatusLabel(state)}
            </span>
          </div>
          {isInvalidManifest ? (
            <InvalidManifestMeta version={manifest.version} author={manifest.author} />
          ) : (
            <div className="plugin-detail__meta">
              v{manifest.version} · by {manifest.author} ·{" "}
              <code>{pluginTypeLabel(manifest.extensions)}</code>
            </div>
          )}
        </div>
      </div>

      {manifest.description && <p className="plugin-detail__desc">{manifest.description}</p>}

      {isError && errorMessage && (
        <div className="plugin-detail__error" data-testid="plugin-detail-error">
          <CircleAlert className="plugin-detail__error-icon" aria-hidden="true" />
          <div>
            {errorMessage}
            {isInvalidManifest && (
              <div data-testid="plugin-detail-invalid-hint">
                This plugin's manifest is invalid, so it cannot be enabled. Uninstall it or install
                a fixed version.
              </div>
            )}
          </div>
        </div>
      )}

      {!isInvalidManifest && (
        <div className="plugin-detail__block" data-testid="plugin-detail-extension-points">
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
      )}

      {platforms && (
        <div className="plugin-detail__block">
          <div className="plugin-detail__section-title">Supported Platforms</div>
          <PluginPlatformList support={platforms} testIdBase="plugin-detail" />
        </div>
      )}

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

      {(manifest.updateUrl || hasIndexOffer) && <PluginUpdateSection plugin={plugin} />}

      <div className="plugin-detail__actions">
        {isInvalidManifest ? null : isError ? (
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

/**
 * The meta line for an invalid-manifest plugin (#4578): only the version and
 * author that could be read leniently from the rejected manifest, omitting
 * empty fragments (and the meaningless type label) instead of rendering
 * `v · by  · plugin`. Renders nothing when neither is known.
 */
function InvalidManifestMeta({ version, author }: { version: string; author: string }) {
  const parts: string[] = [];
  if (version) parts.push(`v${version}`);
  if (author) parts.push(`by ${author}`);
  if (parts.length === 0) return null;
  return (
    <div className="plugin-detail__meta" data-testid="plugin-detail-meta">
      {parts.join(" · ")}
    </div>
  );
}
