import { useCallback, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CircleArrowUp,
  CircleAlert,
  CircleCheck,
  Download,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { assessPluginTrust, downloadPluginUpdate, validatePlugin } from "@/services/api";
import type { InstalledPlugin, PluginManifest, PluginTrustInfo } from "@/types/plugin";
import { Button, toast } from "@/components/ui";
import { currentEntry, usePluginUpdateStore } from "@/plugins/pluginUpdateStore";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { PluginInstallDialog } from "./PluginInstallDialog";
import "./Plugins.css";

/** Props for {@link PluginUpdateSection}. */
export interface PluginUpdateSectionProps {
  /** The installed plugin; must declare a `manifest.updateUrl`. */
  plugin: InstalledPlugin;
}

/** A downloaded, verified update package awaiting the install dialog. */
interface PendingUpdate {
  filePath: string;
  manifest: PluginManifest;
  trust: PluginTrustInfo;
}

/**
 * The "Updates" block of the plugin detail panel (PROD-051), shown only for a
 * plugin that declares an `updateUrl`.
 *
 * "Check for updates" asks the backend to fetch the plugin's update document;
 * nothing is downloaded. When a newer version is offered, "Download & install…"
 * downloads it, the backend verifies its SHA-256 / id / version, and the package
 * then opens in the **same install dialog** as a manual install — trust banner,
 * permissions, and the downgrade / same-version confirmation all apply. An
 * update is never installed without that confirmation.
 */
export function PluginUpdateSection({ plugin }: PluginUpdateSectionProps) {
  const entry = usePluginUpdateStore((s) => currentEntry(s.entries, plugin));
  const checkForUpdates = usePluginUpdateStore((s) => s.checkForUpdates);
  const [pending, setPending] = useState<PendingUpdate | null>(null);

  const { id, name } = plugin.manifest;

  const handleCheck = useCallback(() => checkForUpdates([id]), [checkForUpdates, id]);

  const handleDownload = useCallback(async () => {
    const toastId = toast.loading(`Downloading ${name} update…`);
    try {
      const filePath = await downloadPluginUpdate(id);
      const [manifest, trust] = await Promise.all([
        validatePlugin(filePath),
        assessPluginTrust(filePath),
      ]);
      toast.dismiss(toastId);
      setPending({ filePath, manifest, trust });
    } catch (err) {
      frontendLog("plugin_update", `Downloading update for ${id} failed: ${errorMessage(err)}`);
      toast.error(`Could not download the update: ${errorMessage(err)}`, { id: toastId });
    }
  }, [id, name]);

  const handleChangelog = useCallback(async (url: string) => {
    try {
      await openUrl(url);
    } catch (err) {
      toast.error(`Could not open the changelog: ${errorMessage(err)}`);
    }
  }, []);

  const outcome = entry?.phase === "checked" ? entry.outcome : null;

  return (
    <div className="plugin-detail__block" data-testid="plugin-update">
      <div className="plugin-detail__section-title">Updates</div>

      {entry?.phase === "checking" && (
        <p className="plugin-update__line" data-testid="plugin-update-checking">
          <RefreshCw className="plugin-update__icon" aria-hidden="true" />
          Checking for updates…
        </p>
      )}

      {entry?.phase === "error" && (
        <p
          className="plugin-update__line plugin-update__line--error"
          data-testid="plugin-update-error"
        >
          <CircleAlert className="plugin-update__icon" aria-hidden="true" />
          Update check failed: {entry.error}
        </p>
      )}

      {outcome?.status === "upToDate" && (
        <p className="plugin-update__line" data-testid="plugin-update-uptodate">
          <CircleCheck className="plugin-update__icon plugin-update__icon--ok" aria-hidden="true" />
          Up to date — the latest published version is v{outcome.latestVersion}.
        </p>
      )}

      {outcome?.status === "incompatibleHost" && (
        <p className="plugin-update__line" data-testid="plugin-update-incompatible">
          <CircleAlert className="plugin-update__icon" aria-hidden="true" />v{outcome.latestVersion}{" "}
          is available but needs a newer termiHub (plugin ABI {outcome.minHostAbi}). Update termiHub
          first.
        </p>
      )}

      {outcome?.status === "updateAvailable" && (
        <p
          className="plugin-update__line plugin-update__line--available"
          data-testid="plugin-update-available"
        >
          <CircleArrowUp
            className="plugin-update__icon plugin-update__icon--accent"
            aria-hidden="true"
          />
          Update available: v{plugin.manifest.version} → v{outcome.latestVersion}
        </p>
      )}

      {!entry && (
        <p
          className="plugin-update__line plugin-update__line--muted"
          data-testid="plugin-update-idle"
        >
          This plugin publishes updates. termiHub only checks when you ask (or when periodic checks
          are turned on in Settings → Plugins) and never installs without your confirmation.
        </p>
      )}

      <div className="plugin-update__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw size={14} />}
          onClick={handleCheck}
          disabled={entry?.phase === "checking"}
          errorToast={false}
          data-testid="plugin-update-check"
        >
          Check for updates
        </Button>
        {outcome?.status === "updateAvailable" && (
          <Button
            variant="primary"
            size="sm"
            icon={<Download size={14} />}
            onClick={handleDownload}
            errorToast={false}
            data-testid="plugin-update-download"
          >
            Download &amp; install…
          </Button>
        )}
        {outcome?.changelogUrl && outcome.status !== "upToDate" && (
          <Button
            variant="ghost"
            size="sm"
            icon={<ExternalLink size={14} />}
            onClick={() => handleChangelog(outcome.changelogUrl ?? "")}
            data-testid="plugin-update-changelog"
          >
            Changelog
          </Button>
        )}
      </div>

      {pending && (
        <PluginInstallDialog
          filePath={pending.filePath}
          manifest={pending.manifest}
          trust={pending.trust}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}
