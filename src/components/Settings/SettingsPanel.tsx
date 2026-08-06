import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { frontendLog } from "@/utils/frontendLog";
import {
  Settings2,
  Palette,
  TerminalSquare,
  SquareMenu,
  Keyboard,
  Shield,
  FileJson,
  FileCode2,
  HardDrive,
  Puzzle,
  Check,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { currentSettingsView } from "@/store/settingsBridge";
import { useProjectedSettings } from "@/store/useProjectedSettings";
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
import { RdpTrustSettings } from "./RdpTrustSettings";
import { SshTrustSettings } from "./SshTrustSettings";
import { FileTypeSettings } from "./FileTypeSettings";
import { LanguagePackagesSettings } from "./LanguagePackagesSettings";
import { CustomGrammarsSettings } from "./CustomGrammarsSettings";
import { SerialPortSettings } from "./SerialPortSettings";
import { ShellIntegrationSettings } from "./ShellIntegrationSettings";
import { PortableModeSettings } from "./PortableModeSettings";
import { PluginSettingsSection } from "./PluginSettingsSection";
import { FrontendPluginGateSettings } from "./FrontendPluginGateSettings";
import { TrustedPublishersSettings } from "./TrustedPublishersSettings";
import { useAppInfo } from "@/hooks/useAppInfo";
import "./SettingsPanel.css";

const SETTINGS_ICONS: Record<SettingsCategory, LucideIcon> = {
  general: Settings2,
  appearance: Palette,
  terminal: TerminalSquare,
  "shell-integration": SquareMenu,
  keyboard: Keyboard,
  security: Shield,
  "external-files": FileJson,
  editor: FileCode2,
  plugins: Puzzle,
  portable: HardDrive,
};

const SAVE_DEBOUNCE_MS = 300;
const SAVED_ACK_MS = 1500;

interface SettingsPanelProps {
  tabId: string;
  isVisible: boolean;
}

/**
 * Two-panel settings layout with categorized navigation, search, and version footer.
 */
export function SettingsPanel({ tabId, isVisible }: SettingsPanelProps) {
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);
  const setEditorDirty = useAppStore((s) => s.setEditorDirty);
  const pendingCloseRequest = useAppStore((s) => s.pendingCloseRequest);
  const setPendingCloseRequest = useAppStore((s) => s.setPendingCloseRequest);
  const closeTab = useAppStore((s) => s.closeTab);
  const pendingSettingsCategory = useAppStore((s) => s.pendingSettingsCategory);
  const pendingSettingsPluginId = useAppStore((s) => s.pendingSettingsPluginId);

  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("general");
  const [focusPluginId, setFocusPluginId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isCompact, setIsCompact] = useState(false);
  const appInfo = useAppInfo();
  const [showSavedAck, setShowSavedAck] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSettingsRef = useRef<AppSettings | null>(null);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Briefly surface a transient "Saved" acknowledgment in the footer after a
   * debounced auto-save has actually persisted, then fade it out.
   */
  const acknowledgeSaved = useCallback(() => {
    setShowSavedAck(true);
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    ackTimerRef.current = setTimeout(() => {
      ackTimerRef.current = null;
      setShowSavedAck(false);
    }, SAVED_ACK_MS);
  }, []);

  /**
   * Cancel any pending debounced save and persist it immediately, so the last
   * <=300ms of edits aren't lost when the tab closes or the panel unmounts.
   */
  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const toSave = pendingSettingsRef.current;
    if (toSave) {
      pendingSettingsRef.current = null;
      // The persisted document is region-authoritative (#2404): `updateSettings`
      // persists and folds it into the region — no `appStore` slice to mark saved.
      updateSettings(toSave);
    }
  }, [updateSettings]);

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

  // Consume a one-shot deep-link target set by openSettingsTab (#2000): switch to
  // the requested category and, for Plugins, remember which plugin to focus.
  // Clearing the store fields prevents re-applying on the next unrelated open.
  useEffect(() => {
    if (!pendingSettingsCategory && !pendingSettingsPluginId) return;
    if (pendingSettingsCategory) {
      setActiveCategory(pendingSettingsCategory as SettingsCategory);
    }
    if (pendingSettingsPluginId) {
      setFocusPluginId(pendingSettingsPluginId);
    }
    useAppStore.setState({ pendingSettingsCategory: null, pendingSettingsPluginId: null });
  }, [pendingSettingsCategory, pendingSettingsPluginId]);

  // Debounced save for General/Appearance/Terminal settings
  const handleSettingsChange = useCallback(
    (newSettings: AppSettings) => {
      // Apply theme immediately so the user sees the change without waiting
      // for the debounced save (which would compare against already-updated state).
      if (newSettings.theme !== settings.theme) {
        applyTheme(newSettings.theme);
      }

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      // Only dirty if the new value actually differs from the last persisted state.
      // The persisted document is region-authoritative (#2404): compare against the
      // projected view (the current persisted settings), not a removed appStore slice.
      const isDirty = JSON.stringify(newSettings) !== JSON.stringify(currentSettingsView());

      if (isDirty) {
        pendingSettingsRef.current = newSettings;
        setEditorDirty(tabId, true);
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = null;
          const toSave = pendingSettingsRef.current;
          if (toSave) {
            pendingSettingsRef.current = null;
            updateSettings(toSave);
            setEditorDirty(tabId, false);
            acknowledgeSaved();
          }
        }, SAVE_DEBOUNCE_MS);
      } else {
        pendingSettingsRef.current = null;
        setEditorDirty(tabId, false);
      }
    },
    [updateSettings, settings.theme, tabId, setEditorDirty, acknowledgeSaved]
  );

  // Settings auto-save, so a close request never needs a confirmation dialog.
  // Flush any pending debounced write (so the last <=300ms of edits aren't lost)
  // and close the tab directly.
  useEffect(() => {
    if (pendingCloseRequest?.tabId !== tabId) return;
    frontendLog("settings_panel", `close request for tabId=${tabId} — flush and close`);

    flushPendingSave();
    setEditorDirty(tabId, false);
    const req = pendingCloseRequest;
    setPendingCloseRequest(null);
    closeTab(req.tabId, req.panelId);
  }, [
    pendingCloseRequest,
    tabId,
    flushPendingSave,
    setEditorDirty,
    setPendingCloseRequest,
    closeTab,
  ]);

  // Flush any pending debounced save and clear the ack timer on unmount.
  useEffect(() => {
    return () => {
      if (ackTimerRef.current) {
        clearTimeout(ackTimerRef.current);
        ackTimerRef.current = null;
      }
      flushPendingSave();
    };
  }, [flushPendingSave]);

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
      if (highlightedCategories?.has("shell-integration")) {
        sections.push(<ShellIntegrationSettings key="shell-integration" />);
      }
      if (highlightedCategories?.has("keyboard")) {
        sections.push(<KeyboardSettings key="keyboard" visibleFields={visibleFields} />);
      }
      if (highlightedCategories?.has("security")) {
        sections.push(<SecuritySettings key="security" visibleFields={visibleFields} />);
        sections.push(<RdpTrustSettings key="rdp-trust" visibleFields={visibleFields} />);
        sections.push(<SshTrustSettings key="ssh-trust" visibleFields={visibleFields} />);
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
      if (highlightedCategories?.has("plugins")) {
        sections.push(<FrontendPluginGateSettings key="frontend-plugin-gate" />);
        sections.push(<PluginSettingsSection key="plugins" focusPluginId={focusPluginId} />);
        sections.push(<TrustedPublishersSettings key="trusted-publishers" />);
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
      case "shell-integration":
        return <ShellIntegrationSettings />;
      case "keyboard":
        return <KeyboardSettings />;
      case "security":
        return (
          <>
            <SecuritySettings />
            <RdpTrustSettings />
            <SshTrustSettings />
          </>
        );
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
      case "plugins":
        return (
          <>
            <FrontendPluginGateSettings />
            <PluginSettingsSection focusPluginId={focusPluginId} />
            <TrustedPublishersSettings />
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
        <span
          data-testid="settings-saved-ack"
          className={`settings-panel__saved-ack ${
            showSavedAck ? "settings-panel__saved-ack--visible" : ""
          }`}
          role="status"
          aria-live="polite"
        >
          {showSavedAck && (
            <>
              <Check size={12} aria-hidden="true" />
              Saved
            </>
          )}
        </span>
      </div>
    </div>
  );
}
