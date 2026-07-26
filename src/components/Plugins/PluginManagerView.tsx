import { useCallback, useMemo, useState } from "react";
import { FileUp } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import { assessPluginTrust, validatePlugin } from "@/services/api";
import type { PluginManifest, PluginTrustInfo } from "@/types/plugin";
import { Button, Input, toast } from "@/components/ui";
import { frontendLog } from "@/utils/frontendLog";
import { pluginDotState, pluginTypeIcon } from "./pluginPresentation";
import { PluginInstallDialog } from "./PluginInstallDialog";
import "./Plugins.css";

/** A picked-and-validated package awaiting the user's install confirmation. */
interface PendingInstall {
  filePath: string;
  manifest: PluginManifest;
  trust: PluginTrustInfo;
}

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

  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<PendingInstall | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return plugins;
    return plugins.filter((p) => p.manifest.name.toLowerCase().includes(q));
  }, [plugins, query]);

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
      toast.error(
        `Could not open file picker: ${err instanceof Error ? err.message : String(err)}`
      );
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
      toast.error(`Invalid plugin package: ${err instanceof Error ? err.message : String(err)}`, {
        id: toastId,
      });
    }
  }, []);

  return (
    <div className="plugin-manager" data-testid="plugin-manager">
      <div className="plugin-manager__search">
        <Input
          size="sm"
          type="search"
          placeholder="Search plugins…"
          aria-label="Search plugins"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
                <span
                  className={`plugin-state-dot plugin-state-dot--${dot}`}
                  data-testid={`plugin-state-dot-${manifest.id}`}
                  aria-hidden="true"
                />
                <TypeIcon className="plugin-row__icon" aria-hidden="true" />
                <span className="plugin-row__name">{manifest.name}</span>
                <span className="plugin-row__ver">v{manifest.version}</span>
              </button>
            );
          })
        )}
      </div>

      <div className="plugin-manager__footer">
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
