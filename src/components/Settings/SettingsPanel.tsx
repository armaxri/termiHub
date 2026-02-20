import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "@/store/appStore";
import { AppSettings } from "@/types/connection";
import { SettingsCategory } from "./settingsRegistry";
import { filterSettings, getMatchingCategories } from "./settingsRegistry";
import { SettingsNav } from "./SettingsNav";
import { SettingsSearch } from "./SettingsSearch";
import { GeneralSettings } from "./GeneralSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { TerminalSettings } from "./TerminalSettings";
import { ExternalFilesSettings } from "./ExternalFilesSettings";
import "./SettingsPanel.css";

const STORAGE_KEY = "termihub-settings-category";
const SAVE_DEBOUNCE_MS = 300;

function loadSavedCategory(): SettingsCategory {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (
      saved === "general" ||
      saved === "appearance" ||
      saved === "terminal" ||
      saved === "external-files"
    ) {
      return saved;
    }
  } catch {
    // Ignore localStorage errors
  }
  return "general";
}

interface SettingsPanelProps {
  isVisible: boolean;
}

/**
 * Two-panel settings layout with categorized navigation, search, and version footer.
 */
export function SettingsPanel({ isVisible }: SettingsPanelProps) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(loadSavedCategory);
  const [searchQuery, setSearchQuery] = useState("");
  const [isCompact, setIsCompact] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSettingsRef = useRef<AppSettings | null>(null);

  // Load app version
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("unknown"));
  }, []);

  // ResizeObserver for compact mode
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsCompact(entry.contentRect.width < 480);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Persist active category to localStorage
  const handleCategoryChange = useCallback((category: SettingsCategory) => {
    setActiveCategory(category);
    try {
      localStorage.setItem(STORAGE_KEY, category);
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Debounced save for General/Appearance/Terminal settings
  const handleSettingsChange = useCallback(
    (newSettings: AppSettings) => {
      pendingSettingsRef.current = newSettings;
      // Update local state immediately via store for responsive UI
      useAppStore.setState({ settings: newSettings });

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(() => {
        const toSave = pendingSettingsRef.current;
        if (toSave) {
          pendingSettingsRef.current = null;
          updateSettings(toSave);
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [updateSettings]
  );

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        // Flush pending save
        const toSave = pendingSettingsRef.current;
        if (toSave) {
          pendingSettingsRef.current = null;
          updateSettings(toSave);
        }
      }
    };
  }, [updateSettings]);

  // Search filtering
  const isSearchActive = searchQuery.trim().length > 0;
  const highlightedCategories = useMemo(
    () => (isSearchActive ? getMatchingCategories(searchQuery) : undefined),
    [isSearchActive, searchQuery]
  );
  const visibleFields = useMemo(() => {
    if (!isSearchActive) return undefined;
    const matched = filterSettings(searchQuery);
    return new Set(matched.map((s) => s.id));
  }, [isSearchActive, searchQuery]);

  const renderContent = () => {
    if (isSearchActive) {
      // Show all categories that have matching settings
      const sections: React.ReactNode[] = [];
      if (highlightedCategories?.has("general")) {
        sections.push(
          <GeneralSettings
            key="general"
            settings={settings}
            onChange={handleSettingsChange}
            visibleFields={visibleFields}
          />
        );
      }
      if (highlightedCategories?.has("appearance")) {
        sections.push(
          <AppearanceSettings
            key="appearance"
            settings={settings}
            onChange={handleSettingsChange}
            visibleFields={visibleFields}
          />
        );
      }
      if (highlightedCategories?.has("terminal")) {
        sections.push(
          <TerminalSettings
            key="terminal"
            settings={settings}
            onChange={handleSettingsChange}
            visibleFields={visibleFields}
          />
        );
      }
      if (sections.length === 0) {
        return <div className="settings-panel__no-results">No settings match your search.</div>;
      }
      return <>{sections}</>;
    }

    switch (activeCategory) {
      case "general":
        return <GeneralSettings settings={settings} onChange={handleSettingsChange} />;
      case "appearance":
        return <AppearanceSettings settings={settings} onChange={handleSettingsChange} />;
      case "terminal":
        return <TerminalSettings settings={settings} onChange={handleSettingsChange} />;
      case "external-files":
        return <ExternalFilesSettings />;
    }
  };

  return (
    <div
      ref={containerRef}
      className={`settings-panel ${isVisible ? "" : "settings-panel--hidden"}`}
    >
      <SettingsSearch query={searchQuery} onQueryChange={setSearchQuery} />
      <div className={`settings-panel__body ${isCompact ? "settings-panel__body--compact" : ""}`}>
        <SettingsNav
          activeCategory={activeCategory}
          onCategoryChange={handleCategoryChange}
          highlightedCategories={highlightedCategories}
          isCompact={isCompact}
        />
        <div className="settings-panel__content">{renderContent()}</div>
      </div>
      <div className="settings-panel__footer">termiHub v{appVersion}</div>
    </div>
  );
}
