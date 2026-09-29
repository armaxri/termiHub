import { useState, useMemo, useCallback } from "react";
import { PackagePlus, PackageMinus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import {
  ALL_LANGUAGE_PACKAGES,
  BUILTIN_PACKAGE_IDS,
  type LanguagePackageInfo,
} from "@/utils/monacoLanguagePackages";
import { registerAdditionalLanguagePackages } from "@/utils/monacoCustomLanguages";
import { Button, Tooltip, EmptyState, SearchInput } from "@/components/ui";
import { useListFilter, type ListFilterMatcher } from "@/hooks/useListFilter";

interface LanguagePackagesSettingsProps {
  visibleFields?: Set<string>;
}

/**
 * Case-insensitive match of a language package against the (already normalized)
 * query on its id or display name. Module-level so the {@link useListFilter}
 * memo stays stable across renders.
 */
const languagePackageMatches: ListFilterMatcher<LanguagePackageInfo> = (pkg, query) => {
  if (!query) return true;
  return pkg.id.toLowerCase().includes(query) || pkg.name.toLowerCase().includes(query);
};

/**
 * Ids uninstalled during this app session. Their grammars stay loaded in Monaco
 * until restart, so the Installed list keeps showing them with a "restart required"
 * badge. Module-level (not component state) so the hint survives the settings
 * panel being closed and reopened; it resets naturally on app restart.
 */
const pendingUninstallIds = new Set<string>();

/** Test hook: forget every pending uninstall. */
export function resetPendingLanguagePackageUninstalls(): void {
  pendingUninstallIds.clear();
}

/**
 * Settings panel for installing additional Shiki language packages.
 *
 * Users can browse ~235 TextMate grammars bundled with Shiki (the same set
 * VS Code uses) and install them for syntax highlighting in the file editor.
 * Built-in packages (cmake, toml, nginx, nix) are always active and cannot
 * be removed.
 */
export function LanguagePackagesSettings({ visibleFields }: LanguagePackagesSettingsProps) {
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [pendingUninstall, setPendingUninstall] = useState<ReadonlySet<string>>(
    () => new Set(pendingUninstallIds)
  );
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    filtered: filteredPackages,
  } = useListFilter(ALL_LANGUAGE_PACKAGES, languagePackageMatches);

  const show = (field: string) => !visibleFields || visibleFields.has(field);

  const installed: ReadonlySet<string> = useMemo(
    () => new Set(settings.installedLanguagePackages ?? []),
    [settings.installedLanguagePackages]
  );

  const handleInstall = useCallback(
    (id: string) => {
      const updated = [...(settings.installedLanguagePackages ?? []), id];
      updateSettings({ ...settings, installedLanguagePackages: updated });
      void registerAdditionalLanguagePackages([id]);
      // Reinstalling cancels a pending uninstall: the grammar never left.
      if (pendingUninstallIds.delete(id)) setPendingUninstall(new Set(pendingUninstallIds));
    },
    [settings, updateSettings]
  );

  const handleUninstall = useCallback(
    (id: string) => {
      const updated = (settings.installedLanguagePackages ?? []).filter((p) => p !== id);
      updateSettings({
        ...settings,
        installedLanguagePackages: updated.length > 0 ? updated : undefined,
      });
      pendingUninstallIds.add(id);
      setPendingUninstall(new Set(pendingUninstallIds));
    },
    [settings, updateSettings]
  );

  // Installed packages plus uninstalled-but-still-loaded ones (pending restart).
  const installedPackages = useMemo(
    () => ALL_LANGUAGE_PACKAGES.filter((p) => installed.has(p.id) || pendingUninstall.has(p.id)),
    [installed, pendingUninstall]
  );

  return (
    <div className="settings-panel__category" data-testid="language-packages-settings">
      {show("installedLanguagePackages") && (
        <>
          <h3 className="settings-panel__category-title">Language Packages</h3>

          {/* Installed packages */}
          <div className="settings-panel__section">
            <div className="settings-panel__section-header">
              <h3 className="settings-panel__section-title">Installed</h3>
            </div>
            <p className="settings-panel__description">
              Built-in packages are always active. User-installed packages are loaded on startup.
              Uninstalling takes effect after a restart.
            </p>

            <ul className="settings-panel__file-list">
              {/* Built-in (always on) */}
              {ALL_LANGUAGE_PACKAGES.filter((p) => BUILTIN_PACKAGE_IDS.has(p.id)).map((pkg) => (
                <li key={pkg.id} className="settings-panel__file-item">
                  <span className="settings-panel__file-path" style={{ fontFamily: "monospace" }}>
                    {pkg.id}
                  </span>
                  <span
                    className="settings-panel__file-path settings-panel__file-path--disabled"
                    style={{ fontFamily: "monospace" }}
                  >
                    {pkg.name}
                  </span>
                  <span className="settings-panel__badge">built-in</span>
                </li>
              ))}

              {/* User-installed */}
              {installedPackages.map((pkg) => {
                const awaitingRestart = !installed.has(pkg.id);
                return (
                  <li
                    key={pkg.id}
                    className="settings-panel__file-item"
                    data-testid={`lang-pkg-installed-${pkg.id}`}
                  >
                    <span className="settings-panel__file-path" style={{ fontFamily: "monospace" }}>
                      {pkg.id}
                    </span>
                    <span
                      className="settings-panel__file-path settings-panel__file-path--disabled"
                      style={{ fontFamily: "monospace" }}
                    >
                      {pkg.name}
                    </span>
                    {awaitingRestart ? (
                      <Tooltip content={`${pkg.name} is uninstalled and unloads after a restart`}>
                        <span className="settings-panel__badge" tabIndex={0}>
                          restart required
                        </span>
                      </Tooltip>
                    ) : (
                      <Tooltip content={`Uninstall ${pkg.name}`}>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          icon={<PackageMinus size={14} />}
                          onClick={() => handleUninstall(pkg.id)}
                          aria-label={`Uninstall ${pkg.name}`}
                          data-testid={`lang-pkg-uninstall-${pkg.id}`}
                        />
                      </Tooltip>
                    )}
                  </li>
                );
              })}

              {installedPackages.length === 0 && (
                <EmptyState variant="panel" title="No additional packages installed." />
              )}
            </ul>
          </div>

          {/* Package browser */}
          <div className="settings-panel__section">
            <div className="settings-panel__section-header">
              <h3 className="settings-panel__section-title">Available Packages</h3>
            </div>
            <p className="settings-panel__description">
              {ALL_LANGUAGE_PACKAGES.length} language packages from Shiki's TextMate grammar library
              (the same grammars used by VS Code). Installed packages are active immediately; the
              language ID can be used in File Type Mappings.
            </p>

            <div className="settings-panel__create-prompt">
              <SearchInput
                value={searchQuery}
                onValueChange={setSearchQuery}
                placeholder="Search languages…"
                clearLabel="Clear language search"
                data-testid="lang-pkg-search"
              />
            </div>

            <ul
              className="settings-panel__file-list"
              style={{ maxHeight: "320px", overflowY: "auto" }}
            >
              {filteredPackages.map((pkg) => {
                const isBuiltin = BUILTIN_PACKAGE_IDS.has(pkg.id);
                const isInstalled = installed.has(pkg.id);
                return (
                  <li key={pkg.id} className="settings-panel__file-item">
                    <span className="settings-panel__file-path" style={{ fontFamily: "monospace" }}>
                      {pkg.id}
                    </span>
                    <span
                      className="settings-panel__file-path settings-panel__file-path--disabled"
                      style={{ fontFamily: "monospace" }}
                    >
                      {pkg.name}
                    </span>
                    {isBuiltin ? (
                      <span className="settings-panel__badge">built-in</span>
                    ) : isInstalled ? (
                      <span className="settings-panel__badge">installed</span>
                    ) : (
                      <Tooltip content={`Install ${pkg.name}`}>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          icon={<PackagePlus size={14} />}
                          onClick={() => handleInstall(pkg.id)}
                          aria-label={`Install ${pkg.name}`}
                          data-testid={`lang-pkg-install-${pkg.id}`}
                        />
                      </Tooltip>
                    )}
                  </li>
                );
              })}
              {filteredPackages.length === 0 && (
                <EmptyState variant="panel" title="No packages match your search." />
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
