import { RefreshCw, Info } from "lucide-react";
import { Modal } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { UpdateSettings } from "./UpdateSettings";
import { AboutSettings } from "./AboutSettings";
import "./OverlayViewPanel.css";

const VIEW_META = {
  updates: { label: "Updates", Icon: RefreshCw },
  about: { label: "About termiHub", Icon: Info },
} as const;

/** Modal that shows the Updates or About view, opened from the settings menu. */
export function OverlayViewPanel() {
  const overlayView = useAppStore((s) => s.overlayView);
  const closeOverlayView = useAppStore((s) => s.closeOverlayView);

  if (!overlayView) return null;

  const { label, Icon } = VIEW_META[overlayView];

  return (
    <Modal
      open={true}
      size="lg"
      onOpenChange={(open) => {
        if (!open) closeOverlayView();
      }}
      data-testid="overlay-view"
      title={
        <span className="overlay-view__title-row">
          <Icon size={14} className="overlay-view__icon" />
          {label}
        </span>
      }
    >
      {overlayView === "updates" && <UpdateSettings />}
      {overlayView === "about" && <AboutSettings />}
    </Modal>
  );
}
