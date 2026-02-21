import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore } from "@/store/appStore";
import {
  LayoutConfig,
  ActivityBarPosition,
  SidebarPosition,
  LAYOUT_PRESETS,
} from "@/types/connection";
import "./CustomizeLayoutDialog.css";

/** Preset metadata for rendering cards. */
const PRESET_LIST: { key: string; label: string }[] = [
  { key: "default", label: "Default" },
  { key: "focus", label: "Focus" },
  { key: "zen", label: "Zen" },
];

/** Deep-compare a LayoutConfig against each preset to find a match. */
function detectActivePreset(config: LayoutConfig): string | null {
  for (const [key, preset] of Object.entries(LAYOUT_PRESETS)) {
    if (
      config.activityBarPosition === preset.activityBarPosition &&
      config.sidebarPosition === preset.sidebarPosition &&
      config.sidebarVisible === preset.sidebarVisible &&
      config.statusBarVisible === preset.statusBarVisible
    ) {
      return key;
    }
  }
  return null;
}

interface PresetSchematicProps {
  config: LayoutConfig;
}

/** Tiny CSS schematic showing the layout arrangement. */
function PresetSchematic({ config }: PresetSchematicProps) {
  const abPos = config.activityBarPosition;
  const sbPos = config.sidebarPosition;
  const sbVisible = config.sidebarVisible;
  const statusVisible = config.statusBarVisible;

  const abIsTop = abPos === "top";
  const abIsHidden = abPos === "hidden";

  return (
    <div className="customize-layout-dialog__schematic">
      {abIsTop && <div className="customize-layout-dialog__schematic-ab--top" />}
      <div className="customize-layout-dialog__schematic-main">
        {!abIsTop && !abIsHidden && abPos === "left" && (
          <div className="customize-layout-dialog__schematic-ab" />
        )}
        {sbVisible && sbPos === "left" && (
          <div className="customize-layout-dialog__schematic-sidebar" />
        )}
        <div className="customize-layout-dialog__schematic-terminal" />
        {sbVisible && sbPos === "right" && (
          <div className="customize-layout-dialog__schematic-sidebar" />
        )}
        {!abIsTop && !abIsHidden && abPos === "right" && (
          <div className="customize-layout-dialog__schematic-ab" />
        )}
      </div>
      {statusVisible && <div className="customize-layout-dialog__schematic-statusbar" />}
    </div>
  );
}

/**
 * Global dialog for customizing the application layout.
 * Reads open state from the Zustand store — no props needed.
 */
export function CustomizeLayoutDialog() {
  const open = useAppStore((s) => s.layoutDialogOpen);
  const layoutConfig = useAppStore((s) => s.layoutConfig);
  const setOpen = useAppStore((s) => s.setLayoutDialogOpen);
  const updateLayout = useAppStore((s) => s.updateLayoutConfig);
  const applyPreset = useAppStore((s) => s.applyLayoutPreset);

  const activePreset = detectActivePreset(layoutConfig);

  const handlePreset = (key: string) => {
    applyPreset(key as "default" | "focus" | "zen");
  };

  const handleActivityBarPosition = (pos: ActivityBarPosition) => {
    updateLayout({ activityBarPosition: pos });
  };

  const handleSidebarVisible = (visible: boolean) => {
    updateLayout({ sidebarVisible: visible });
  };

  const handleSidebarPosition = (pos: SidebarPosition) => {
    updateLayout({ sidebarPosition: pos });
  };

  const handleStatusBarVisible = (visible: boolean) => {
    updateLayout({ statusBarVisible: visible });
  };

  const abHidden = layoutConfig.activityBarPosition === "hidden";

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="customize-layout-dialog__overlay" />
        <Dialog.Content className="customize-layout-dialog__content">
          <Dialog.Title className="customize-layout-dialog__title">Customize Layout</Dialog.Title>

          {/* Presets */}
          <div className="customize-layout-dialog__presets">
            {PRESET_LIST.map(({ key, label }) => (
              <button
                key={key}
                className={`customize-layout-dialog__preset${activePreset === key ? " customize-layout-dialog__preset--active" : ""}`}
                onClick={() => handlePreset(key)}
                data-testid={`layout-preset-${key}`}
              >
                <PresetSchematic config={LAYOUT_PRESETS[key]} />
                <span className="customize-layout-dialog__preset-label">{label}</span>
              </button>
            ))}
          </div>

          {/* Activity Bar */}
          <div className="customize-layout-dialog__section">
            <span className="customize-layout-dialog__section-title">Activity Bar</span>
            <div className="customize-layout-dialog__control-row">
              <label className="customize-layout-dialog__label">
                <input
                  type="checkbox"
                  checked={!abHidden}
                  onChange={(e) => handleActivityBarPosition(e.target.checked ? "left" : "hidden")}
                  data-testid="layout-ab-visible"
                />
                Visible
              </label>
              <div className="customize-layout-dialog__radio-group">
                {(["left", "right", "top"] as ActivityBarPosition[]).map((pos) => (
                  <label
                    key={pos}
                    className={`customize-layout-dialog__radio-label${abHidden ? " customize-layout-dialog__radio-label--disabled" : ""}`}
                  >
                    <input
                      type="radio"
                      name="ab-position"
                      value={pos}
                      checked={!abHidden && layoutConfig.activityBarPosition === pos}
                      disabled={abHidden}
                      onChange={() => handleActivityBarPosition(pos)}
                      data-testid={`layout-ab-${pos}`}
                    />
                    {pos.charAt(0).toUpperCase() + pos.slice(1)}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="customize-layout-dialog__section">
            <span className="customize-layout-dialog__section-title">Sidebar</span>
            <div className="customize-layout-dialog__control-row">
              <label className="customize-layout-dialog__label">
                <input
                  type="checkbox"
                  checked={layoutConfig.sidebarVisible}
                  onChange={(e) => handleSidebarVisible(e.target.checked)}
                  data-testid="layout-sidebar-visible"
                />
                Visible
              </label>
              <div className="customize-layout-dialog__radio-group">
                {(["left", "right"] as SidebarPosition[]).map((pos) => (
                  <label
                    key={pos}
                    className={`customize-layout-dialog__radio-label${!layoutConfig.sidebarVisible ? " customize-layout-dialog__radio-label--disabled" : ""}`}
                  >
                    <input
                      type="radio"
                      name="sb-position"
                      value={pos}
                      checked={layoutConfig.sidebarPosition === pos}
                      disabled={!layoutConfig.sidebarVisible}
                      onChange={() => handleSidebarPosition(pos)}
                      data-testid={`layout-sidebar-${pos}`}
                    />
                    {pos.charAt(0).toUpperCase() + pos.slice(1)}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Status Bar */}
          <div className="customize-layout-dialog__section">
            <span className="customize-layout-dialog__section-title">Status Bar</span>
            <div className="customize-layout-dialog__control-row">
              <label className="customize-layout-dialog__label">
                <input
                  type="checkbox"
                  checked={layoutConfig.statusBarVisible}
                  onChange={(e) => handleStatusBarVisible(e.target.checked)}
                  data-testid="layout-statusbar-visible"
                />
                Visible
              </label>
            </div>
          </div>

          {/* Actions */}
          <div className="customize-layout-dialog__actions">
            <button
              className="customize-layout-dialog__btn customize-layout-dialog__btn--secondary"
              onClick={() => applyPreset("default")}
              data-testid="layout-reset-default"
            >
              Reset to Default
            </button>
            <Dialog.Close asChild>
              <button
                className="customize-layout-dialog__btn customize-layout-dialog__btn--primary"
                data-testid="layout-close"
              >
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
