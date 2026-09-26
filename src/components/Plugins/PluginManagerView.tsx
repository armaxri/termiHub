import { useCallback, useState } from "react";
import { CircleArrowUp, FileUp, RefreshCw } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import { assessPluginTrust, validatePlugin } from "@/services/api";
import type { InstalledPlugin, PluginManifest, PluginTrustInfo } from "@/types/plugin";
import { Button, SearchInput, StatusDot, toast } from "@/components/ui";
import { useListFilter, type ListFilterMatcher } from "@/hooks/useListFilter";
import { frontendLog } from "@/utils/frontendLog";
import { pluginDotState, pluginDotTone, pluginTypeIcon } from "./pluginPresentation";
import { PluginInstallDialog } from "./PluginInstallDialog";
import "./Plugins.css";
import { errorMessage } from "@/utils/errorMessage";
import {
  hasAvailableUpdate,
  hasUpdateSource,
  usePluginUpdateStore,
} from "@/plugins/pluginUpdateStore";

/** A picked-and-validated package awaiting the user's install confirmation. */
interface PendingInstall {
  filePath: string;
  manifest: PluginManifest;
  trust: PluginTrustInfo;
}

/**
 * Case-insensitive match of a plugin against the (already normalized) query on
 * its manifest name. Module-level so the {@link useListFilter} memo stays stable.
 */
const pluginNameMatches: ListFilterMatcher<InstalledPlugin> = (plugin, query) => {
  if (!query) return true;
  return plugin.manifest.name.toLowerCase().includes(query);
};

/**
 * The Plugins sidebar view (#1997): a search box, the installed-plugin list, and
 * a footer "Install from file…" button. Each plugin is a row with a state dot
 * (green enabled / grey disabled / red error), a type icon, its name, and
 * version. Selecting a row opens the plugin's detail panel in the main area.
 *
 * The list and all mutations are driven by the plugin store slice (#1993); this
 * component only projects it and dispatches the native file-picker → validate →
 * confirm install flow.
 */
export function PluginManagerView() {
  const plugins = useAppStore((s) => s.plugins);
  const selectedPluginId = useAppStore((s) => s.selectedPluginId);
  const selectPlugin = useAppStore((s) => s.selectPlugin);

  const updateEntries = usePluginUpdateStore((s) => s.entries);
  const checkingAll = usePluginUpdateStore((s) => s.checkingAll);
  const checkForUpdates = usePluginUpdateStore((s) => s.checkForUpdates);

  const [pending, setPending] = useState<PendingInstall | null>(null);

  const updatable = plugins.some(hasUpdateSource);

  const handleCheckUpdates = useCallback(async () => {
    await checkForUpdates();
    const { entries } = usePluginUpdateStore.getState();
    const available = plugins.filter((p) => hasAvailableUpdate(entries, p)).length;
    const failed = plugins.filter(
      (p) => hasUpdateSource(p) && entries[p.manifest.id]?.phase === "error"
    ).length;
    if (available > 0) {
      toast.success(
        `${available} plugin ${available === 1 ? "update is" : "updates are"} available`
      );
    } else if (failed > 0) {
      toast.error(`Update check failed for ${failed} ${failed === 1 ? "plugin" : "plugins"}`);
    } else {
      toast.success("All plugins are up to date");
    }
  }, [checkForUpdates, plugins]);

  const { query, setQuery, filtered } = useListFilter(plugins, pluginNameMatches);

  const handlePickFile = useCallback(async () => {
    let filePath: string | null;
    try {
      filePath = (await open({
        multiple: false,
        directory: false,
        filters: [{ name: "termiHub plugin", extensions: ["termihub-plugin"] }],
      })) as string | null;
    } catch (err) {
      frontendLog("plugin_manager", `File picker failed: ${err}`);
      toast.error(`Could not open file picker: ${errorMessage(err)}`);
      return;
    }
    if (!filePath) return;

    const toastId = toast.loading("Validating plugin…");
    try {
      const [manifest, trust] = await Promise.all([
        validatePlugin(filePath),
        assessPluginTrust(filePath),
      ]);
      toast.dismiss(toastId);
      setPending({ filePath, manifest, trust });
    } catch (err) {
      toast.error(`Invalid plugin package: ${errorMessage(err)}`, {
        id: toastId,
      });
    }
  }, []);

  return (
    <div className="plugin-manager" data-testid="plugin-manager">
      <div className="plugin-manager__search">
        <SearchInput
          size="sm"
          placeholder="Search plugins…"
          aria-label="Search plugins"
          value={query}
          onValueChange={setQuery}
          clearLabel="Clear plugin search"
          data-testid="plugin-search"
        />
      </div>

      <div className="plugin-manager__list" data-testid="plugin-list">
        <div className="plugin-manager__sep">Installed ({plugins.length})</div>
        {filtered.length === 0 ? (
          <div className="plugin-manager__empty" data-testid="plugin-list-empty">
            {plugins.length === 0 ? "No plugins installed" : "No plugins match your search"}
          </div>
        ) : (
          filtered.map((plugin) => {
            const { manifest, state } = plugin;
            const dot = pluginDotState(state);
            const TypeIcon = pluginTypeIcon(manifest.extensions);
            const isSelected = manifest.id === selectedPluginId;
            return (
              <button
                key={manifest.id}
                type="button"
                className={`plugin-row${isSelected ? " plugin-row--selected" : ""}${
                  dot === "disabled" ? " plugin-row--disabled" : ""
                }`}
                onClick={() => selectPlugin(manifest.id)}
                title={`${manifest.name} v${manifest.version}`}
                data-testid={`plugin-row-${manifest.id}`}
              >
                <StatusDot
                  tone={pluginDotTone(dot)}
                  testId={`plugin-state-dot-${manifest.id}`}
                  ariaHidden
                />
                <TypeIcon className="plugin-row__icon" aria-hidden="true" />
                <span className="plugin-row__name">{manifest.name}</span>
                {hasAvailableUpdate(updateEntries, plugin) && (
                  <CircleArrowUp
                    className="plugin-row__update"
                    aria-label="Update available"
                    data-testid={`plugin-update-badge-${manifest.id}`}
                  />
                )}
                <span className="plugin-row__ver">v{manifest.version}</span>
              </button>
            );
          })
        )}
      </div>

      <div className="plugin-manager__footer">
        {updatable && (
          <Button
            variant="ghost"
            size="sm"
            fullWidth
            icon={<RefreshCw size={14} />}
            onClick={handleCheckUpdates}
            disabled={checkingAll}
            errorToast={false}
            data-testid="plugin-check-updates"
          >
            Check for updates
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          fullWidth
          icon={<FileUp size={14} />}
          onClick={handlePickFile}
          data-testid="plugin-install-from-file"
        >
          Install from file…
        </Button>
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
