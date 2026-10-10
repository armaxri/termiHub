import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  lazy,
  Suspense,
  Fragment,
  type ReactNode,
} from "react";
import { frontendLog } from "@/utils/frontendLog";
import {
  Settings2,
  Palette,
  TerminalSquare,
  Cable,
  Accessibility,
  SquareMenu,
  Keyboard,
  History,
  MessageCircleWarning,
  Monitor,
  Shield,
  FileJson,
  FileCode2,
  HardDrive,
  DatabaseBackup,
  Puzzle,
  RefreshCw,
  Check,
  CalendarClock,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { mirrorSettingsIntent } from "@/store/settingsBridge";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { useDebouncedCallback } from "@/hooks/useDebounce";
import { applyEffectiveTheme } from "@/services/workspaceSettings";
import { AppSettings } from "@/types/connection";
import { SettingsCategory, CATEGORIES } from "./settingsRegistry";
import { filterSettings, getMatchingCategories } from "./settingsRegistry";
import { SettingsNav } from "./SettingsNav";
import { SettingsSearch } from "./SettingsSearch";
import { GeneralSettings, type SettingsUpdate } from "./GeneralSettings";
import { SessionSettings } from "./SessionSettings";
import { SafetyPromptSettings } from "./SafetyPromptSettings";
import { XServerSettings } from "./XServerSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { TerminalSettings } from "./TerminalSettings";
import { AccessibilitySettings } from "./AccessibilitySettings";
import { ExternalFilesSettings } from "./ExternalFilesSettings";
import { KeyboardSettings } from "./KeyboardSettings";
import { SecuritySettings } from "./SecuritySettings";
import { RdpTrustSettings } from "./RdpTrustSettings";
import { SshTrustSettings } from "./SshTrustSettings";
import { SerialPortSettings } from "./SerialPortSettings";
import { ShellIntegrationSettings } from "./ShellIntegrationSettings";
import { PortableModeSettings } from "./PortableModeSettings";
import { BackupRestoreSettings } from "./BackupRestoreSettings";
import { SchedulesSettings } from "./SchedulesSettings";
import { PluginSettingsSection } from "./PluginSettingsSection";
import { FrontendPluginGateSettings } from "./FrontendPluginGateSettings";
import { PluginUpdateCheckSettings } from "./PluginUpdateCheckSettings";
import { PluginCatalogSettings } from "./PluginCatalogSettings";
import { NativePluginGateSettings } from "./NativePluginGateSettings";
import { TrustedPublishersSettings } from "./TrustedPublishersSettings";
import { UpdateSettings } from "./UpdateSettings";
import { useAppInfo } from "@/hooks/useAppInfo";
import "./SettingsPanel.css";

/**
 * The Editor settings category (file types, language packages, custom grammars)
 * is code-split out of the main bundle (PERF-001): it is the only Settings
 * category that pulls in Monaco / Shiki. Loading it lazily keeps that machinery
 * out of the eager Settings/entry chunk — it is fetched only when the user opens
 * the Editor category (or searches for an editor setting).
 */
const EditorSettingsSection = lazy(() =>
  import("./EditorSettingsSection").then((m) => ({ default: m.EditorSettingsSection }))
);

const SETTINGS_ICONS: Record<SettingsCategory, LucideIcon> = {
  general: Settings2,
  appearance: Palette,
  terminal: TerminalSquare,
  serial: Cable,
  accessibility: Accessibility,
  "shell-integration": SquareMenu,
  keyboard: Keyboard,
  sessions: History,
  "safety-prompts": MessageCircleWarning,
  "x-server": Monitor,
  security: Shield,
  "external-files": FileJson,
  editor: FileCode2,
  plugins: Puzzle,
  backup: DatabaseBackup,
  schedules: CalendarClock,
  portable: HardDrive,
  updates: RefreshCw,
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
  // The latest not-yet-persisted edit (the base a functional updater resolves
  // against). Set exactly while a debounced save is pending.
  const pendingSettingsRef = useRef<AppSettings | null>(null);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last-persisted document — the dirty-tracking baseline. Since the settings
  // slice was removed from `appStore` (#2404), the panel owns this baseline locally
  // rather than reading a removed `savedSettings` field: the projected view is the
  // optimistic/live document (updated on every edit), so it cannot double as the
  // "clean" reference. Seeded from the projection and re-pinned on each persisted
  // save; an external region change that lands while the tab is clean updates it
  // (via the effect below), but one that lands mid-edit does not (so the tab stays
  // dirty).
  const savedSettingsRef = useRef<AppSettings>(settings);
  const dirtyRef = useRef(false);
  // Always-fresh view of the projected settings, updated every render. A change
  // handler resolves a functional updater against this (or the pending edit)
  // rather than a captured render snapshot, so two edits fired back-to-back before
  // a re-render both apply instead of the second clobbering the first (#2680).
  const settingsRef = useRef<AppSettings>(settings);
  settingsRef.current = settings;

  // Keep the persisted baseline current with external region updates (e.g. a
  // startup load or a skipUpdate refresh) — but only while the tab is clean, so an
  // external change during an edit never silently shifts the dirty baseline.
  useEffect(() => {
    if (!dirtyRef.current) savedSettingsRef.current = settings;
  }, [settings]);

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
   * Persist a settings document. The persisted document is region-authoritative
   * (#2404): `updateSettings` persists and folds it into the region. Pin the local
   * baseline so a later edit's dirty check compares against what we just persisted.
   */
  const persistSettings = useCallback(
    (toSave: AppSettings) => {
      pendingSettingsRef.current = null;
      savedSettingsRef.current = toSave;
      dirtyRef.current = false;
      updateSettings(toSave);
    },
    [updateSettings]
  );

  // Debounced auto-save. A normal fire persists, clears the tab's dirty flag and
  // surfaces the "Saved" acknowledgment. An early run — a close request, or the
  // panel unmounting (`flushOnUnmount`) — persists the last <=300ms of edits via
  // `onFlush` but deliberately does *neither* side effect: flushing must not
  // write the dirty flag to the store or arm a new ack timer during unmount (the
  // close-request path clears the dirty flag itself).
  const debouncedSave = useDebouncedCallback(
    (toSave: AppSettings) => {
      persistSettings(toSave);
      setEditorDirty(tabId, false);
      acknowledgeSaved();
    },
    SAVE_DEBOUNCE_MS,
    { onFlush: persistSettings, flushOnUnmount: true }
  );

  /**
   * Cancel any pending debounced save and persist it immediately, so the last
   * <=300ms of edits aren't lost when the tab closes.
   */
  const flushPendingSave = debouncedSave.flush;

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

  // Debounced save for General/Appearance/Terminal settings. Accepts either a full
  // replacement document or a functional updater `(prev) => next` (#2680): the
  // updater is resolved against the latest state — the pending (not-yet-persisted)
  // edit if there is one, else the freshest projected view — so rapid successive
  // edits compose instead of each rebuilding from a stale snapshot.
  const handleSettingsChange = useCallback(
    (update: SettingsUpdate) => {
      const base = pendingSettingsRef.current ?? settingsRef.current;
      const newSettings = typeof update === "function" ? update(base) : update;

      // Apply theme immediately so the user sees the change without waiting
      // for the debounced save (which would compare against already-updated state).
      if (newSettings.theme !== base.theme) {
        applyEffectiveTheme(newSettings);
      }

      debouncedSave.cancel();

      // Optimistically reflect the edit into the authoritative region so the UI
      // (which renders from `useProjectedSettings`, #2404) updates instantly — the
      // debounced `updateSettings` below persists it. This is the region-era
      // replacement for the removed local `appStore.settings` optimistic write.
      mirrorSettingsIntent("settings.replace", { settings: newSettings });

      // Only dirty if the new value actually differs from the last persisted state.
      // Compare against the locally-tracked persisted baseline, not the projected
      // view — the optimistic write above just made the projection equal to
      // `newSettings`, so it can no longer serve as the "clean" reference.
      const isDirty = JSON.stringify(newSettings) !== JSON.stringify(savedSettingsRef.current);
      dirtyRef.current = isDirty;

      if (isDirty) {
        pendingSettingsRef.current = newSettings;
        setEditorDirty(tabId, true);
        debouncedSave(newSettings);
      } else {
        pendingSettingsRef.current = null;
        setEditorDirty(tabId, false);
      }
    },
    [tabId, setEditorDirty, debouncedSave]
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

  // Clear the ack timer on unmount. (The pending debounced save is flushed on
  // unmount by `useDebouncedCallback`'s `flushOnUnmount`.)
  useEffect(() => {
    return () => {
      if (ackTimerRef.current) {
        clearTimeout(ackTimerRef.current);
        ackTimerRef.current = null;
      }
    };
  }, []);

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

  /**
   * Every settings section, keyed by its category. This single table drives both
   * the category view (`visibleFields` undefined → the whole section) and search
   * mode (each category with a matching registry entry, gated to the matched
   * fields), so a section registered here is searchable automatically — the
   * `Record` type makes a category without a section a compile error (#3308).
   */
  const sections: Record<SettingsCategory, (fields?: Set<string>) => ReactNode> = {
    general: (fields) => (
      <GeneralSettings settings={settings} onChange={handleSettingsChange} visibleFields={fields} />
    ),
    appearance: (fields) => (
      <AppearanceSettings
        settings={settings}
        onChange={handleSettingsChange}
        visibleFields={fields}
      />
    ),
    terminal: (fields) => (
      <TerminalSettings
        settings={settings}
        onChange={handleSettingsChange}
        visibleFields={fields}
      />
    ),
    serial: (fields) => <SerialPortSettings visibleFields={fields} />,
    accessibility: (fields) => (
      <AccessibilitySettings
        settings={settings}
        onChange={handleSettingsChange}
        visibleFields={fields}
      />
    ),
    "shell-integration": () => <ShellIntegrationSettings />,
    keyboard: (fields) => <KeyboardSettings visibleFields={fields} />,
    sessions: (fields) => (
      <SessionSettings settings={settings} onChange={handleSettingsChange} visibleFields={fields} />
    ),
    "safety-prompts": (fields) => (
      <SafetyPromptSettings
        settings={settings}
        onChange={handleSettingsChange}
        visibleFields={fields}
      />
    ),
    "x-server": (fields) => (
      <XServerSettings settings={settings} onChange={handleSettingsChange} visibleFields={fields} />
    ),
    security: (fields) => (
      <>
        <SecuritySettings visibleFields={fields} />
        <RdpTrustSettings visibleFields={fields} />
        <SshTrustSettings visibleFields={fields} />
      </>
    ),
    "external-files": () => <ExternalFilesSettings />,
    editor: (fields) => (
      <Suspense fallback={<div className="settings-panel__lazy-fallback" />}>
        <EditorSettingsSection visibleFields={fields} />
      </Suspense>
    ),
    plugins: () => (
      <>
        <FrontendPluginGateSettings />
        <NativePluginGateSettings />
        <PluginSettingsSection focusPluginId={focusPluginId} />
        <PluginCatalogSettings />
        <PluginUpdateCheckSettings />
        <TrustedPublishersSettings />
      </>
    ),
    backup: () => <BackupRestoreSettings />,
    schedules: () => <SchedulesSettings />,
    portable: () => <PortableModeSettings />,
    updates: (fields) => <UpdateSettings visibleFields={fields} />,
  };

  const renderContent = () => {
    if (!isSearchActive) return sections[activeCategory]();

    // Show every category that has a matching setting, in navigation order.
    const matched = CATEGORIES.filter((c) => highlightedCategories?.has(c.id));
    if (matched.length === 0) {
      return <div className="settings-panel__no-results">No settings match your search.</div>;
    }
    return (
      <>
        {matched.map((c) => (
          <Fragment key={c.id}>{sections[c.id](visibleFields)}</Fragment>
        ))}
      </>
    );
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
