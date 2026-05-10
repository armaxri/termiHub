import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { frontendLog } from "@/utils/frontendLog";
import {
  Settings2,
  Palette,
  TerminalSquare,
  Keyboard,
  Shield,
  FileJson,
  FileCode2,
  HardDrive,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { applyTheme } from "@/themes/engine";
import { AppSettings } from "@/types/connection";
import { SettingsCategory, CATEGORIES } from "./settingsRegistry";
import { filterSettings, getMatchingCategories } from "./settingsRegistry";
import { SettingsNav } from "./SettingsNav";
import { SettingsSearch } from "./SettingsSearch";
import { GeneralSettings } from "./GeneralSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { TerminalSettings } from "./TerminalSettings";
import { ExternalFilesSettings } from "./ExternalFilesSettings";
import { KeyboardSettings } from "./KeyboardSettings";
import { SecuritySettings } from "./SecuritySettings";
import { FileTypeSettings } from "./FileTypeSettings";
import { LanguagePackagesSettings } from "./LanguagePackagesSettings";
import { CustomGrammarsSettings } from "./CustomGrammarsSettings";
import { SerialPortSettings } from "./SerialPortSettings";
import { PortableModeSettings } from "./PortableModeSettings";
import { getAppInfo, type AppInfo } from "@/services/api";
import { UnsavedChangesDialog } from "@/components/ConnectionEditor/UnsavedChangesDialog";
import "./SettingsPanel.css";

const SETTINGS_ICONS: Record<SettingsCategory, LucideIcon> = {
  general: Settings2,
  appearance: Palette,
  terminal: TerminalSquare,
  keyboard: Keyboard,
  security: Shield,
  "external-files": FileJson,
  editor: FileCode2,
  portable: HardDrive,
};

const SAVE_DEBOUNCE_MS = 300;

interface SettingsPanelProps {
  tabId: string;
  isVisible: boolean;
}

/**
 * Two-panel settings layout with categorized navigation, search, and version footer.
 */
export function SettingsPanel({ tabId, isVisible }: SettingsPanelProps) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const setEditorDirty = useAppStore((s) => s.setEditorDirty);
  const pendingCloseRequest = useAppStore((s) => s.pendingCloseRequest);
  const setPendingCloseRequest = useAppStore((s) => s.setPendingCloseRequest);
  const closeTab = useAppStore((s) => s.closeTab);

  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("general");
  const [searchQuery, setSearchQuery] = useState("");
  const [isCompact, setIsCompact] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSettingsRef = useRef<AppSettings | null>(null);

  useEffect(() => {
    getAppInfo()
      .then(setAppInfo)
      .catch(() => setAppInfo(null));
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

  const handleCategoryChange = useCallback((category: SettingsCategory) => {
    setActiveCategory(category);
  }, []);

  // Debounced save for General/Appearance/Terminal settings
  const handleSettingsChange = useCallback(
    (newSettings: AppSettings) => {
      // Apply theme immediately so the user sees the change without waiting
      // for the debounced save (which would compare against already-updated state).
      if (newSettings.theme !== settings.theme) {
        applyTheme(newSettings.theme);
      }
      // Update local state immediately via store for responsive UI
      useAppStore.setState({ settings: newSettings });

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      // Only dirty if the new value actually differs from the last persisted state
      const isDirty =
        JSON.stringify(newSettings) !== JSON.stringify(useAppStore.getState().savedSettings);

      if (isDirty) {
        pendingSettingsRef.current = newSettings;
        setEditorDirty(tabId, true);
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = null;
          const toSave = pendingSettingsRef.current;
          if (toSave) {
            pendingSettingsRef.current = null;
            useAppStore.setState({ savedSettings: toSave });
            updateSettings(toSave);
            setEditorDirty(tabId, false);
          }
        }, SAVE_DEBOUNCE_MS);
      } else {
        pendingSettingsRef.current = null;
        setEditorDirty(tabId, false);
      }
    },
    [updateSettings, settings.theme, tabId, setEditorDirty]
  );

  // Before showing the unsaved-changes dialog, do a real-time equality check.
  // The dirty flag may be stale (e.g. the user reverted all changes back to the
  // saved state). If nothing actually changed, skip the dialog and close directly.
  useEffect(() => {
    frontendLog(
      "settings_panel",
      `pendingCloseRequest=${JSON.stringify(pendingCloseRequest)} tabId=${tabId}`
    );
    if (pendingCloseRequest?.tabId !== tabId) return;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const { settings: currentSettings, savedSettings } = useAppStore.getState();
    const currentJson = JSON.stringify(currentSettings);
    const savedJson = JSON.stringify(savedSettings);
    frontendLog("settings_panel", `close check — equal=${currentJson === savedJson}`);
    if (currentJson === savedJson) {
      pendingSettingsRef.current = null;
      setEditorDirty(tabId, false);
      const req = pendingCloseRequest;
      setPendingCloseRequest(null);
      closeTab(req.tabId, req.panelId);
    }
  }, [pendingCloseRequest, tabId, setEditorDirty, setPendingCloseRequest, closeTab]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        // Flush pending save
        const toSave = pendingSettingsRef.current;
        if (toSave) {
          pendingSettingsRef.current = null;
          useAppStore.setState({ savedSettings: toSave });
          updateSettings(toSave);
        }
      }
    };
  }, [updateSettings]);

  const flushAndClose = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const toSave = pendingSettingsRef.current;
    if (toSave) {
      pendingSettingsRef.current = null;
      useAppStore.setState({ savedSettings: toSave });
      updateSettings(toSave);
    }
    setEditorDirty(tabId, false);
    const req = pendingCloseRequest;
    setPendingCloseRequest(null);
    if (req) closeTab(req.tabId, req.panelId);
  }, [
    updateSettings,
    tabId,
    setEditorDirty,
    pendingCloseRequest,
    setPendingCloseRequest,
    closeTab,
  ]);

  const discardAndClose = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingSettingsRef.current = null;
    // Revert in-memory store to last persisted state
    const revertTo = useAppStore.getState().savedSettings;
    useAppStore.setState({ settings: revertTo });
    applyTheme(revertTo.theme);
    setEditorDirty(tabId, false);
    const req = pendingCloseRequest;
    setPendingCloseRequest(null);
    if (req) closeTab(req.tabId, req.panelId);
  }, [tabId, setEditorDirty, pendingCloseRequest, setPendingCloseRequest, closeTab]);

  const cancelClose = useCallback(() => {
    setPendingCloseRequest(null);
  }, [setPendingCloseRequest]);

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
        sections.push(<SerialPortSettings key="serial-ports" visibleFields={visibleFields} />);
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
      if (highlightedCategories?.has("keyboard")) {
        sections.push(<KeyboardSettings key="keyboard" visibleFields={visibleFields} />);
      }
      if (highlightedCategories?.has("security")) {
        sections.push(<SecuritySettings key="security" visibleFields={visibleFields} />);
      }
      if (highlightedCategories?.has("editor")) {
        sections.push(<FileTypeSettings key="editor" visibleFields={visibleFields} />);
        sections.push(
          <LanguagePackagesSettings key="lang-packages" visibleFields={visibleFields} />
        );
        sections.push(
          <CustomGrammarsSettings key="custom-grammars" visibleFields={visibleFields} />
        );
      }
      if (highlightedCategories?.has("portable")) {
        sections.push(<PortableModeSettings key="portable" />);
      }
      if (sections.length === 0) {
        return <div className="settings-panel__no-results">No settings match your search.</div>;
      }
      return <>{sections}</>;
    }

    switch (activeCategory) {
      case "general":
        return (
          <>
            <GeneralSettings settings={settings} onChange={handleSettingsChange} />
            <SerialPortSettings />
          </>
        );
      case "appearance":
        return <AppearanceSettings settings={settings} onChange={handleSettingsChange} />;
      case "terminal":
        return <TerminalSettings settings={settings} onChange={handleSettingsChange} />;
      case "keyboard":
        return <KeyboardSettings />;
      case "security":
        return <SecuritySettings />;
      case "external-files":
        return <ExternalFilesSettings />;
      case "editor":
        return (
          <>
            <FileTypeSettings />
            <LanguagePackagesSettings />
            <CustomGrammarsSettings />
          </>
        );
      case "portable":
        return <PortableModeSettings />;
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
          categories={CATEGORIES}
          iconMap={SETTINGS_ICONS}
          activeCategory={activeCategory}
          onCategoryChange={handleCategoryChange}
          highlightedCategories={highlightedCategories}
          isCompact={isCompact}
        />
        <div className="settings-panel__content">{renderContent()}</div>
      </div>
      <div className="settings-panel__footer">
        termiHub {appInfo ? `v${appInfo.version}` : ""} [DEV]
        {appInfo && (
          <span className="settings-panel__footer-hash" title="Git commit hash">
            {appInfo.gitHash}
          </span>
        )}
      </div>
      <UnsavedChangesDialog
        open={pendingCloseRequest?.tabId === tabId}
        onCancel={cancelClose}
        onJustClose={discardAndClose}
        onSaveAndClose={flushAndClose}
      />
    </div>
  );
}
