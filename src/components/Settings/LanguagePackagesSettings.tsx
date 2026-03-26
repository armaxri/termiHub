import { useState, useMemo, useCallback } from "react";
import { PackagePlus, PackageMinus, Search } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { ALL_LANGUAGE_PACKAGES, BUILTIN_PACKAGE_IDS } from "@/utils/monacoLanguagePackages";
import { registerAdditionalLanguagePackages } from "@/utils/monacoCustomLanguages";

interface LanguagePackagesSettingsProps {
  visibleFields?: Set<string>;
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
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [searchQuery, setSearchQuery] = useState("");
  const [pendingUninstall, setPendingUninstall] = useState<Set<string>>(new Set());

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
      setPendingUninstall((prev) => new Set([...prev, id]));
    },
    [settings, updateSettings]
  );

  const filteredPackages = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return ALL_LANGUAGE_PACKAGES;
    return ALL_LANGUAGE_PACKAGES.filter(
      (p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  const installedPackages = useMemo(
    () => ALL_LANGUAGE_PACKAGES.filter((p) => installed.has(p.id)),
    [installed]
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
              {installedPackages.map((pkg) => (
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
                  {pendingUninstall.has(pkg.id) && (
                    <span className="settings-panel__badge">restart required</span>
                  )}
                  <button
                    className="settings-panel__file-remove"
                    onClick={() => handleUninstall(pkg.id)}
                    title={`Uninstall ${pkg.name}`}
                    data-testid={`lang-pkg-uninstall-${pkg.id}`}
                  >
                    <PackageMinus size={14} />
                  </button>
                </li>
              ))}

              {installedPackages.length === 0 && (
                <div className="settings-panel__empty">No additional packages installed.</div>
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
              <div style={{ position: "relative", flex: 1 }}>
                <Search
                  size={14}
                  style={{
                    position: "absolute",
                    left: "8px",
                    top: "50%",
                    transform: "translateY(-50%)",
                    opacity: 0.5,
                    pointerEvents: "none",
                  }}
                />
                <input
                  className="settings-panel__create-input"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search languages…"
                  style={{ paddingLeft: "28px", width: "100%", boxSizing: "border-box" }}
                  data-testid="lang-pkg-search"
                />
              </div>
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
                      <button
                        className="settings-panel__file-remove"
                        onClick={() => handleInstall(pkg.id)}
                        title={`Install ${pkg.name}`}
                        data-testid={`lang-pkg-install-${pkg.id}`}
                      >
                        <PackagePlus size={14} />
                      </button>
                    )}
                  </li>
                );
              })}
              {filteredPackages.length === 0 && (
                <div className="settings-panel__empty">No packages match your search.</div>
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
