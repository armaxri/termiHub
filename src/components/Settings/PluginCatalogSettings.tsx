import { useCallback, useEffect, useMemo, useState } from "react";
import { PackageSearch, RefreshCw, RotateCcw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { downloadPluginFromIndex, fetchPluginIndex } from "@/services/api";
import type { PluginIndexEntryView, PluginIndexResult } from "@/types/plugin";
import { Button, EmptyState, Input, SearchInput, toast } from "@/components/ui";
import { PluginInstallDialog } from "@/components/Plugins/PluginInstallDialog";
import type { DownloadedPackageReview } from "@/components/Plugins/pluginDownloadReview";
import { reviewDownloadedPackage } from "@/components/Plugins/pluginDownloadReview";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { usePluginUpdateStore } from "@/plugins/pluginUpdateStore";
import { SettingsField } from "./SettingsField";
import { PluginCatalogEntryCard } from "./PluginCatalogEntryCard";
import { PluginUrlInstall, urlFieldError } from "./PluginUrlInstall";
import "./PluginCatalogSettings.css";

/** Shown when the index URL setting is unset — mirrors the backend default. */
const DEFAULT_PLUGIN_INDEX_URL =
  "https://raw.githubusercontent.com/armaxri/termiHub/main/plugins/index.json";

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; result: PluginIndexResult }
  | { phase: "error"; error: string };

/** Case-insensitive match on name, id, author and description. */
export function entryMatches(view: PluginIndexEntryView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const { name, id, author, description } = view.entry;
  return [name, id, author, description].some((field) => field.toLowerCase().includes(q));
}

/**
 * Settings → Plugins → Browse Plugins (PROD-048).
 *
 * Lists the curated plugin index with each plugin's compatibility on this
 * computer, and installs a listed (or pasted-URL) plugin. The index is fetched
 * by the backend, and only when the user clicks Load / Refresh. Every install
 * downloads the package in the backend, verifies its SHA-256 before anything
 * reads it, and then opens the **same install dialog** as "Install from file…":
 * nothing is installed, enabled or trusted without the user's confirmation.
 */
export function PluginCatalogSettings() {
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);
  const plugins = useAppStore((s) => s.plugins);

  const savedUrl = settings.pluginIndexUrl ?? "";
  const [urlDraft, setUrlDraft] = useState(savedUrl);
  const [load, setLoad] = useState<LoadState>({ phase: "idle" });
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<DownloadedPackageReview | null>(null);

  useEffect(() => setUrlDraft(savedUrl), [savedUrl]);

  const urlError = urlFieldError(urlDraft);

  const saveUrl = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      if (urlFieldError(trimmed) || trimmed === savedUrl) return;
      void updateSettings({ ...settings, pluginIndexUrl: trimmed === "" ? undefined : trimmed });
      setLoad({ phase: "idle" });
    },
    [savedUrl, settings, updateSettings]
  );

  const handleLoad = useCallback(async () => {
    setLoad({ phase: "loading" });
    try {
      const result = await fetchPluginIndex();
      // Share the offers with the Plugins sidebar badge and detail panel.
      usePluginUpdateStore.getState().recordIndex(result);
      setLoad({ phase: "loaded", result });
    } catch (err) {
      const error = errorMessage(err);
      frontendLog("plugin_catalog", `Loading the plugin index failed: ${error}`);
      setLoad({ phase: "error", error });
    }
  }, []);

  const handleInstall = useCallback(async (view: PluginIndexEntryView) => {
    const toastId = toast.loading(`Downloading ${view.entry.name}…`);
    try {
      const review = await reviewDownloadedPackage(await downloadPluginFromIndex(view.entry.id));
      toast.dismiss(toastId);
      setPending(review);
    } catch (err) {
      frontendLog("plugin_catalog", `Download of ${view.entry.id} failed: ${errorMessage(err)}`);
      toast.error(`Could not download ${view.entry.name}: ${errorMessage(err)}`, { id: toastId });
    }
  }, []);

  const installedVersions = useMemo(
    () => new Map(plugins.map((p) => [p.manifest.id, p.manifest.version])),
    [plugins]
  );

  const entries = load.phase === "loaded" ? load.result.entries : [];
  const visible = entries.filter((e) => entryMatches(e, query));

  return (
    <div className="settings-panel__category">
      <div className="settings-panel__section" data-testid="settings-plugin-catalog">
        <h3 className="settings-panel__section-title">
          <PackageSearch size={16} aria-hidden="true" /> Browse Plugins
        </h3>
        <p className="settings-panel__description">
          termiHub can list plugins from a curated plugin index. The index is only fetched when you
          click Load. Installing downloads the package, checks it against the index&apos;s SHA-256
          checksum, and then asks you to review it exactly like installing from a file — nothing is
          installed or trusted automatically.
        </p>

        <SettingsField
          label="Plugin Index URL"
          hint={
            savedUrl
              ? "A custom index. Only use indexes you trust."
              : "The termiHub-maintained index (default)."
          }
          error={urlError ?? undefined}
        >
          <Input
            value={urlDraft}
            placeholder={DEFAULT_PLUGIN_INDEX_URL}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={() => saveUrl(urlDraft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveUrl(urlDraft);
            }}
            spellCheck={false}
            data-testid="plugin-catalog-url"
          />
        </SettingsField>

        <div className="plugin-catalog__actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={handleLoad}
            disabled={load.phase === "loading" || Boolean(urlError)}
            errorToast={false}
            data-testid="plugin-catalog-load"
          >
            {load.phase === "loaded" ? "Refresh" : "Load plugin index"}
          </Button>
          {savedUrl && (
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw size={14} />}
              onClick={() => saveUrl("")}
              data-testid="plugin-catalog-url-reset"
            >
              Use default index
            </Button>
          )}
        </div>

        {load.phase === "loading" && <EmptyState loading title="Loading plugin index…" />}
        {load.phase === "error" && (
          <p className="plugin-catalog__error" role="alert" data-testid="plugin-catalog-error">
            {load.error}
          </p>
        )}
        {load.phase === "loaded" && (
          <>
            {entries.length > 0 && (
              <SearchInput
                size="sm"
                placeholder="Search the plugin index…"
                aria-label="Search the plugin index"
                value={query}
                onValueChange={setQuery}
                clearLabel="Clear plugin index search"
                data-testid="plugin-catalog-search"
              />
            )}
            {visible.length === 0 ? (
              <EmptyState
                title={
                  entries.length === 0
                    ? "This index lists no plugins yet."
                    : "No plugins match your search."
                }
                data-testid="plugin-catalog-empty"
              />
            ) : (
              <ul className="plugin-catalog__list" data-testid="plugin-catalog-list">
                {visible.map((view) => (
                  <PluginCatalogEntryCard
                    key={view.entry.id}
                    view={view}
                    liveInstalledVersion={installedVersions.get(view.entry.id) ?? null}
                    onInstall={handleInstall}
                  />
                ))}
              </ul>
            )}
          </>
        )}

        <PluginUrlInstall onReady={setPending} />
      </div>

      {pending && (
        <PluginInstallDialog
          filePath={pending.filePath}
          manifest={pending.manifest}
          trust={pending.trust}
          hostPlatform={pending.hostPlatform}
          platformSupported={pending.platformSupported}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}
