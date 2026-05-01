import { useEffect } from "react";
import { RefreshCw, Info, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { UpdateSettings } from "./UpdateSettings";
import { AboutSettings } from "./AboutSettings";
import "./OverlayViewPanel.css";

const VIEW_META = {
  updates: { label: "Updates", Icon: RefreshCw },
  about: { label: "About termiHub", Icon: Info },
} as const;

/** Full-screen overlay that shows the Updates or About view, opened from the settings menu. */
export function OverlayViewPanel() {
  const overlayView = useAppStore((s) => s.overlayView);
  const closeOverlayView = useAppStore((s) => s.closeOverlayView);

  useEffect(() => {
    if (!overlayView) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeOverlayView();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [overlayView, closeOverlayView]);

  if (!overlayView) return null;

  const { label, Icon } = VIEW_META[overlayView];

  return (
    <div className="overlay-view" onClick={closeOverlayView}>
      <div className="overlay-view__panel" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-view__header">
          <Icon size={14} className="overlay-view__icon" />
          <span className="overlay-view__title">{label}</span>
          <button className="overlay-view__close" onClick={closeOverlayView} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="overlay-view__content">
          {overlayView === "updates" && <UpdateSettings />}
          {overlayView === "about" && <AboutSettings />}
        </div>
      </div>
    </div>
  );
}
