import { Activity, Box, Cpu, Folder, Globe, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import type { ReactNode } from "react";
import { Chip } from "@/components/ui";
import type { PluginSandboxStatus } from "@/store/pluginSandboxBridge";
import type { InstalledPlugin } from "@/types/plugin";
import { denialDetail } from "@/components/Plugins/denialToastLimiter";
import {
  accessChips,
  missingLayerWarning,
  processLabel,
  type AccessChip,
  type IsolationBadge,
} from "./nativePluginSandbox";

/** Props for {@link NativePluginSandboxStatus}. */
export interface NativePluginSandboxStatusProps {
  /** The installed plugin (its manifest drives the access chips). */
  plugin: InstalledPlugin;
  /** The isolation badge to show, if any. */
  badge: IsolationBadge | undefined;
  /** The plugin's `plugin-sandbox` region row, if any. */
  status: PluginSandboxStatus | undefined;
}

const BADGE_ICONS: Record<IsolationBadge["tone"], ReactNode> = {
  ok: <ShieldCheck size={14} aria-hidden="true" />,
  warning: <ShieldAlert size={14} aria-hidden="true" />,
  error: <ShieldX size={14} aria-hidden="true" />,
  checking: <ShieldAlert size={14} aria-hidden="true" />,
};

const CHIP_ICONS: Record<string, ReactNode> = {
  network: <Globe size={12} />,
  data: <Folder size={12} />,
  "declared-files": <Folder size={12} />,
  files: <Folder size={12} />,
  programs: <Cpu size={12} />,
};

function chipIcon(chip: AccessChip): ReactNode {
  return CHIP_ICONS[chip.id] ?? <Box size={12} />;
}

/**
 * The sandbox part of a native plugin's Settings row (#4188, concept callouts
 * B–F): the isolation badge, the runner's process status, the access summary
 * and — for reduced or unavailable isolation — the plain-language note naming
 * the missing layer. Renders nothing when there is nothing to show.
 */
export function NativePluginSandboxStatus({
  plugin,
  badge,
  status,
}: NativePluginSandboxStatusProps) {
  const id = plugin.manifest.id;
  const process = processLabel(status);
  const showChips = badge?.kind === "isolated" || badge?.kind === "reduced";
  const showWarning = badge?.kind === "reduced" || badge?.kind === "unavailable";
  if (!badge && !process) return null;

  return (
    <div className="native-plugin-sandbox" data-testid={`native-plugin-sandbox-${id}`}>
      <div className="native-plugin-sandbox__meta">
        {badge && (
          <span
            className={`settings-panel__status-indicator settings-panel__status-indicator--${badge.tone} native-plugin-sandbox__indicator`}
            title={badge.detail}
            data-testid={`native-plugin-isolation-${id}`}
            data-kind={badge.kind}
          >
            {BADGE_ICONS[badge.tone]} {badge.label}
          </span>
        )}
        {process && (
          <span
            className="settings-panel__status-indicator settings-panel__status-indicator--checking native-plugin-sandbox__indicator"
            data-testid={`native-plugin-process-${id}`}
          >
            <Activity size={14} aria-hidden="true" /> {process}
          </span>
        )}
      </div>
      {showWarning && (
        <p
          className="settings-panel__description native-plugin-sandbox__warning"
          data-testid={`native-plugin-isolation-warning-${id}`}
        >
          {missingLayerWarning(status?.missing ?? [], status?.enforced ?? [])}
        </p>
      )}
      {(badge?.kind === "failed" || badge?.kind === "runnerMissing") && badge.detail && (
        <p
          className="settings-panel__description native-plugin-sandbox__detail"
          data-testid={`native-plugin-sandbox-detail-${id}`}
        >
          {badge.detail} Details are in the Log Viewer.
        </p>
      )}
      {status && status.denials.length > 0 && (
        <div className="native-plugin-sandbox__denials">
          <span className="settings-panel__description">Recently blocked:</span>
          <ul
            className="native-plugin-sandbox__denial-list"
            data-testid={`native-plugin-denials-${id}`}
          >
            {status.denials.map((denial) => (
              <li
                key={`${denial.atMs}-${denial.operation}-${denial.target}`}
                className="settings-panel__description"
              >
                {denialDetail(denial)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {showChips && (
        <div
          className="native-plugin-sandbox__chips"
          role="list"
          aria-label="What this plugin can reach"
          data-testid={`native-plugin-access-${id}`}
        >
          {accessChips(plugin, status).map((chip) => (
            <span role="listitem" key={chip.id}>
              <Chip
                label={chip.label}
                icon={chipIcon(chip)}
                denied={chip.denied}
                tooltip={chip.rule}
                data-testid={`native-plugin-access-${id}-${chip.id}`}
              />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
