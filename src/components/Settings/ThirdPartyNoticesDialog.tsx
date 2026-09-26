import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getThirdPartyNotices } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";
import { Button, EmptyState, Modal } from "@/components/ui";
import "./ThirdPartyNoticesDialog.css";

/** Online attribution page, shown when a build does not bundle the notices. */
export const THIRD_PARTY_LICENSES_URL =
  "https://github.com/armaxri/termiHub/blob/main/THIRD_PARTY_LICENSES.md";

/** Load state of the bundled notices file. */
type NoticesState =
  | { kind: "loading" }
  | { kind: "loaded"; text: string }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

/** Props for {@link ThirdPartyNoticesDialog}. */
export interface ThirdPartyNoticesDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** Called with the next open state. */
  onOpenChange: (open: boolean) => void;
}

/**
 * Viewer for the third-party license notices bundled with the app
 * (THIRD_PARTY_NOTICES.txt, generated from the real dependency graph — PKG-009).
 * The notices are fetched on first open; builds that do not bundle them (dev
 * builds) point to the online attribution page instead.
 */
export function ThirdPartyNoticesDialog({ open, onOpenChange }: ThirdPartyNoticesDialogProps) {
  const [state, setState] = useState<NoticesState>({ kind: "loading" });
  const needsLoad = open && state.kind === "loading";

  useEffect(() => {
    if (!needsLoad) return;
    let active = true;
    getThirdPartyNotices()
      .then((text) => {
        if (active) setState(text ? { kind: "loaded", text } : { kind: "unavailable" });
      })
      .catch((err: unknown) => {
        frontendLog("about", `Failed to load third-party notices: ${err}`);
        if (active) setState({ kind: "error", message: errorMessage(err) });
      });
    return () => {
      active = false;
    };
  }, [needsLoad]);

  const handleViewOnline = async () => {
    try {
      await openUrl(THIRD_PARTY_LICENSES_URL);
    } catch (err) {
      frontendLog("about", `Failed to open third-party licenses URL: ${err}`);
      throw err;
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Third-Party Licenses"
      description="License notices of the open-source software termiHub is built from"
      size="lg"
      data-testid="third-party-notices-dialog"
      footer={
        <Button
          variant="secondary"
          size="sm"
          icon={<ExternalLink size={13} />}
          onClick={handleViewOnline}
          data-testid="third-party-notices-online"
        >
          View Online
        </Button>
      }
    >
      {state.kind === "loading" && <EmptyState loading title="Loading license notices…" />}
      {state.kind === "loaded" && (
        <pre className="third-party-notices__text" data-testid="third-party-notices-text">
          {state.text}
        </pre>
      )}
      {state.kind === "unavailable" && (
        <EmptyState
          title="License notices are not bundled in this build"
          description="Release builds include the generated notices. View the attribution online instead."
          data-testid="third-party-notices-unavailable"
        />
      )}
      {state.kind === "error" && (
        <EmptyState
          title="Could not load the license notices"
          description={state.message}
          data-testid="third-party-notices-error"
        />
      )}
    </Modal>
  );
}
