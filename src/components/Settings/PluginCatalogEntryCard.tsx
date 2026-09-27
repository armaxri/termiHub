import {
  CircleAlert,
  CircleCheck,
  CircleArrowUp,
  Cpu,
  Download,
  TriangleAlert,
} from "lucide-react";
import type { PluginIndexEntryView } from "@/types/plugin";
import { Button } from "@/components/ui";

/** Props for {@link PluginCatalogEntryCard}. */
export interface PluginCatalogEntryCardProps {
  view: PluginIndexEntryView;
  /**
   * The version of this plugin currently installed, from the live plugin list
   * (fresher than the index fetch, so a just-finished install shows at once).
   */
  liveInstalledVersion: string | null;
  /** Start the verified download → install dialog flow. */
  onInstall: (view: PluginIndexEntryView) => Promise<void>;
}

type BadgeTone = "ok" | "warn" | "bad";

interface Badge {
  key: string;
  tone: BadgeTone;
  label: string;
  title: string;
}

/** The compatibility badges for one entry: ABI, platform, toolchain, native. */
function compatibilityBadges(view: PluginIndexEntryView): Badge[] {
  const { entry } = view;
  const badges: Badge[] = [
    {
      key: "abi",
      tone: view.abiCompatible ? "ok" : "bad",
      label: `ABI ${entry.minHostAbi}`,
      title: view.abiCompatible
        ? `Needs plugin ABI ${entry.minHostAbi}; this termiHub provides ${view.hostAbi}.`
        : `Needs plugin ABI ${entry.minHostAbi}; this termiHub only provides ${view.hostAbi}.`,
    },
    {
      key: "platform",
      tone: view.platformSupported ? "ok" : "bad",
      label: view.platformSupported ? "This computer" : "Not for this computer",
      title: `Packages: ${entry.packages.flatMap((p) => p.platforms).join(", ")}. This computer: ${view.hostPlatform}.`,
    },
  ];
  if (entry.native) {
    const toolchain: Record<string, Omit<Badge, "key">> = {
      match: {
        tone: "ok",
        label: "Toolchain match",
        title: `Built with ${entry.toolchain?.rustc ?? ""}, the same Rust toolchain as this termiHub.`,
      },
      mismatch: {
        tone: "bad",
        label: "Toolchain mismatch",
        title: `Built with ${entry.toolchain?.rustc ?? ""} (panic=${entry.toolchain?.panicStrategy ?? ""}); this termiHub would refuse to load it.`,
      },
      undeclared: {
        tone: "warn",
        label: "Toolchain unknown",
        title: "The index lists no build toolchain; termiHub checks it when the plugin loads.",
      },
    };
    const t = toolchain[view.toolchain];
    if (t) badges.push({ key: "toolchain", ...t });
  }
  return badges;
}

/** The status line + action label for the entry's install state. */
function installState(
  view: PluginIndexEntryView,
  liveInstalledVersion: string | null
): { status: string | null; action: string } {
  const listed = view.entry.version;
  if (liveInstalledVersion === listed) {
    return { status: "Installed", action: "Install" };
  }
  if (view.installStatus === "updateAvailable") {
    return {
      status: `Update available: v${view.installedVersion ?? "?"} → v${listed}`,
      action: "Update…",
    };
  }
  if (view.installStatus === "installedNewer") {
    return { status: `Installed v${view.installedVersion ?? "?"} (newer)`, action: "Install" };
  }
  if (view.installStatus === "installed") return { status: "Installed", action: "Install" };
  return { status: null, action: "Install…" };
}

const TONE_ICON = { ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert } as const;

/**
 * One plugin listed in the curated plugin index (PROD-048): name, version,
 * author, description, compatibility badges and the Install / Update action.
 * The action is disabled — with the reason shown — whenever this computer
 * cannot install the listed version.
 */
export function PluginCatalogEntryCard({
  view,
  liveInstalledVersion,
  onInstall,
}: PluginCatalogEntryCardProps) {
  const { entry } = view;
  const { status, action } = installState(view, liveInstalledVersion);
  const current = liveInstalledVersion === entry.version;
  const installable = view.installable && !current;
  // Already-installed states speak for themselves in the status line; only a
  // real blocker (ABI, platform, toolchain) needs its reason spelled out.
  const alreadyInstalled =
    current || view.installStatus === "installed" || view.installStatus === "installedNewer";
  const showReason = !installable && !alreadyInstalled && Boolean(view.blockedReason);

  return (
    <li className="plugin-catalog__entry" data-testid={`plugin-catalog-entry-${entry.id}`}>
      <div className="plugin-catalog__entry-head">
        <span className="plugin-catalog__entry-name">{entry.name}</span>
        <span className="plugin-catalog__entry-version">v{entry.version}</span>
        {entry.native && (
          <span
            className="plugin-catalog__badge plugin-catalog__badge--warn"
            title="Runs native code in-process. Needs Settings → Plugins → native plugins enabled and a per-plugin trust acknowledgement."
            data-testid={`plugin-catalog-native-${entry.id}`}
          >
            <Cpu size={12} aria-hidden="true" /> Native
          </span>
        )}
        <span className="plugin-catalog__entry-author">by {entry.author}</span>
      </div>
      <p className="plugin-catalog__entry-desc">{entry.description}</p>
      <div className="plugin-catalog__badges">
        {compatibilityBadges(view).map((b) => {
          const Icon = TONE_ICON[b.tone];
          return (
            <span
              key={b.key}
              className={`plugin-catalog__badge plugin-catalog__badge--${b.tone}`}
              title={b.title}
              data-testid={`plugin-catalog-${b.key}-${entry.id}`}
              data-tone={b.tone}
            >
              <Icon size={12} aria-hidden="true" /> {b.label}
            </span>
          );
        })}
      </div>
      <div className="plugin-catalog__entry-foot">
        {status && (
          <span
            className="plugin-catalog__entry-status"
            data-testid={`plugin-catalog-status-${entry.id}`}
          >
            {view.installStatus === "updateAvailable" && !current && (
              <CircleArrowUp size={12} aria-hidden="true" />
            )}
            {status}
          </span>
        )}
        {showReason && (
          <span
            className="plugin-catalog__entry-blocked"
            data-testid={`plugin-catalog-blocked-${entry.id}`}
          >
            {view.blockedReason}
          </span>
        )}
        <Button
          variant={installable ? "primary" : "secondary"}
          size="sm"
          icon={<Download size={14} />}
          disabled={!installable}
          title={installable ? undefined : view.blockedReason}
          onClick={() => onInstall(view)}
          errorToast={false}
          data-testid={`plugin-catalog-install-${entry.id}`}
        >
          {action}
        </Button>
      </div>
    </li>
  );
}
