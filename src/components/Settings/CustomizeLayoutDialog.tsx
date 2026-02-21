import { useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore } from "@/store/appStore";
import type { LayoutConfig, ActivityBarPosition, SidebarPosition } from "@/types/connection";
import { LAYOUT_PRESETS } from "@/types/connection";
import "./CustomizeLayoutDialog.css";

/**
 * Returns the preset key that exactly matches the given config,
 * or `null` if the config doesn't match any preset.
 */
export function getActivePreset(config: LayoutConfig): string | null {
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

interface ThumbnailLayout {
  activityBar: "left" | "right" | "top" | "hidden";
  sidebar: "left" | "right" | "hidden";
  statusBar: boolean;
}

/** CSS-only mini schematic showing a layout arrangement. */
function PresetThumbnail({ layout }: { layout: ThumbnailLayout }) {
  const showAbLeft = layout.activityBar === "left";
  const showAbRight = layout.activityBar === "right";
  const showAbTop = layout.activityBar === "top";
  const showSbLeft = layout.sidebar === "left";
  const showSbRight = layout.sidebar === "right";

  return (
    <div className="customize-layout-dialog__thumbnail">
      {showAbTop && (
        <div className="customize-layout-dialog__thumbnail-ab customize-layout-dialog__thumbnail-ab--h" />
      )}
      <div className="customize-layout-dialog__thumbnail-main">
        {showAbLeft && (
          <div className="customize-layout-dialog__thumbnail-ab customize-layout-dialog__thumbnail-ab--v" />
        )}
        {showSbLeft && <div className="customize-layout-dialog__thumbnail-sb" />}
        <div className="customize-layout-dialog__thumbnail-editor" />
        {showSbRight && <div className="customize-layout-dialog__thumbnail-sb" />}
        {showAbRight && (
          <div className="customize-layout-dialog__thumbnail-ab customize-layout-dialog__thumbnail-ab--v" />
        )}
      </div>
      {layout.statusBar && <div className="customize-layout-dialog__thumbnail-statusbar" />}
    </div>
  );
}

function presetToThumbnail(preset: LayoutConfig): ThumbnailLayout {
  return {
    activityBar: preset.activityBarPosition,
    sidebar: preset.sidebarVisible ? preset.sidebarPosition : "hidden",
    statusBar: preset.statusBarVisible,
  };
}

const PRESET_LABELS: Record<string, string> = {
  default: "Default",
  focus: "Focus",
  zen: "Zen",
};

/**
 * Modal dialog for customizing the app layout — toggling visibility and
 * repositioning the Activity Bar, Sidebar, and Status Bar, plus applying presets.
 */
export function CustomizeLayoutDialog() {
  const open = useAppStore((s) => s.layoutDialogOpen);
  const layoutConfig = useAppStore((s) => s.layoutConfig);
  const setLayoutDialogOpen = useAppStore((s) => s.setLayoutDialogOpen);
  const updateLayoutConfig = useAppStore((s) => s.updateLayoutConfig);
  const applyLayoutPreset = useAppStore((s) => s.applyLayoutPreset);

  // Track the last non-hidden Activity Bar position so unchecking/rechecking
  // visibility restores it rather than defaulting to "left".
  const lastNonHiddenPos = useRef<"left" | "right" | "top">(
    layoutConfig.activityBarPosition !== "hidden" ? layoutConfig.activityBarPosition : "left"
  );

  // Keep the ref in sync when the user picks a visible position
  if (layoutConfig.activityBarPosition !== "hidden") {
    lastNonHiddenPos.current = layoutConfig.activityBarPosition;
  }

  const activePreset = getActivePreset(layoutConfig);
  const activityBarVisible = layoutConfig.activityBarPosition !== "hidden";

  const handleActivityBarVisibilityChange = (visible: boolean) => {
    if (visible) {
      updateLayoutConfig({ activityBarPosition: lastNonHiddenPos.current });
    } else {
      updateLayoutConfig({ activityBarPosition: "hidden" });
    }
  };

  const handleActivityBarPositionChange = (pos: ActivityBarPosition) => {
    if (pos !== "hidden") {
      lastNonHiddenPos.current = pos;
    }
    updateLayoutConfig({ activityBarPosition: pos });
  };

  const handleSidebarPositionChange = (pos: SidebarPosition) => {
    updateLayoutConfig({ sidebarPosition: pos });
  };

  return (
    <Dialog.Root open={open} onOpenChange={setLayoutDialogOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="customize-layout-dialog__overlay" />
        <Dialog.Content className="customize-layout-dialog__content">
          <Dialog.Title className="customize-layout-dialog__title">Customize Layout</Dialog.Title>

          {/* Presets */}
          <div className="customize-layout-dialog__presets">
            {Object.entries(LAYOUT_PRESETS).map(([key, preset]) => (
              <button
                key={key}
                className={`customize-layout-dialog__preset${
                  activePreset === key ? " customize-layout-dialog__preset--active" : ""
                }`}
                onClick={() => applyLayoutPreset(key as "default" | "focus" | "zen")}
                data-testid={`preset-${key}`}
              >
                <PresetThumbnail layout={presetToThumbnail(preset)} />
                <span className="customize-layout-dialog__preset-label">
                  {PRESET_LABELS[key] ?? key}
                </span>
              </button>
            ))}
          </div>

          <div className="customize-layout-dialog__separator" />

          {/* Activity Bar */}
          <div className="customize-layout-dialog__section">
            <h3 className="customize-layout-dialog__section-title">Activity Bar</h3>
            <div className="customize-layout-dialog__checkbox-row">
              <input
                type="checkbox"
                id="ab-visible"
                checked={activityBarVisible}
                onChange={(e) => handleActivityBarVisibilityChange(e.target.checked)}
                data-testid="ab-visible"
              />
              <label htmlFor="ab-visible">Visible</label>
            </div>
            <div className="customize-layout-dialog__radio-group">
              {(["left", "right", "top"] as const).map((pos) => (
                <label
                  key={pos}
                  className={`customize-layout-dialog__radio-label${
                    !activityBarVisible ? " customize-layout-dialog__radio-label--disabled" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="ab-position"
                    value={pos}
                    checked={
                      activityBarVisible
                        ? layoutConfig.activityBarPosition === pos
                        : lastNonHiddenPos.current === pos
                    }
                    disabled={!activityBarVisible}
                    onChange={() => handleActivityBarPositionChange(pos)}
                  />
                  {pos.charAt(0).toUpperCase() + pos.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {/* Sidebar */}
          <div className="customize-layout-dialog__section">
            <h3 className="customize-layout-dialog__section-title">Sidebar</h3>
            <div className="customize-layout-dialog__checkbox-row">
              <input
                type="checkbox"
                id="sb-visible"
                checked={layoutConfig.sidebarVisible}
                onChange={(e) => updateLayoutConfig({ sidebarVisible: e.target.checked })}
                data-testid="sb-visible"
              />
              <label htmlFor="sb-visible">Visible</label>
            </div>
            <div className="customize-layout-dialog__radio-group">
              {(["left", "right"] as const).map((pos) => (
                <label
                  key={pos}
                  className={`customize-layout-dialog__radio-label${
                    !layoutConfig.sidebarVisible
                      ? " customize-layout-dialog__radio-label--disabled"
                      : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="sb-position"
                    value={pos}
                    checked={layoutConfig.sidebarPosition === pos}
                    disabled={!layoutConfig.sidebarVisible}
                    onChange={() => handleSidebarPositionChange(pos)}
                  />
                  {pos.charAt(0).toUpperCase() + pos.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {/* Status Bar */}
          <div className="customize-layout-dialog__section">
            <h3 className="customize-layout-dialog__section-title">Status Bar</h3>
            <div className="customize-layout-dialog__checkbox-row">
              <input
                type="checkbox"
                id="statusbar-visible"
                checked={layoutConfig.statusBarVisible}
                onChange={(e) => updateLayoutConfig({ statusBarVisible: e.target.checked })}
                data-testid="statusbar-visible"
              />
              <label htmlFor="statusbar-visible">Visible</label>
            </div>
          </div>

          {/* Actions */}
          <div className="customize-layout-dialog__actions">
            <button
              className="customize-layout-dialog__btn customize-layout-dialog__btn--secondary"
              onClick={() => applyLayoutPreset("default")}
              data-testid="reset-default"
            >
              Reset to Default
            </button>
            <Dialog.Close asChild>
              <button
                className="customize-layout-dialog__btn customize-layout-dialog__btn--primary"
                data-testid="close-dialog"
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
