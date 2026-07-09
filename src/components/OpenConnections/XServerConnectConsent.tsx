import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { AppWindow } from "lucide-react";
import { Modal, Button, toast } from "@/components/ui";
import { xServerConnectConsentReply } from "@/services/api";
import { onXServerConsentNeeded, onXServerProgress } from "@/services/events";
import { frontendLog } from "@/utils/frontendLog";
import type { XServerConsentRequest, XServerProgress } from "@/types/xserver";
import "./XServerSetupDialog.css";

/** Which screen of the connect-triggered flow is showing. */
type Phase = "consent" | "provisioning";

/** Progress steps that end the flow (dialog closes when one arrives). */
const TERMINAL_STEPS = new Set(["ready", "failed", "skipped"]);

/**
 * Connect-triggered X server download-consent + live progress dialog (#1116).
 *
 * Mounted once at the app root. It listens for the backend's
 * `x-server-consent-needed` event (emitted when opening an X11-forwarding SSH
 * connection would need to download the X dependency and the user has not
 * consented yet), shows the same consent screen as the manual setup dialog, and
 * — unlike the manual flow — hands the decision back to the **paused connect**
 * via `x_server_connect_consent_reply`. On "Enable" the backend resumes and
 * provisions, streaming `x-server-progress`; a terminal step closes the dialog.
 * "Not now" replies `notNow`, and the connect continues without X forwarding.
 */
export function XServerConnectConsent() {
  const [request, setRequest] = useState<XServerConsentRequest | null>(null);
  const [phase, setPhase] = useState<Phase>("consent");
  const [progress, setProgress] = useState<XServerProgress | null>(null);
  // Guards against replying twice for the same prompt (e.g. Enable then close).
  const repliedRef = useRef(false);

  // Subscribe to connect-time consent prompts for the lifetime of the app.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void (async () => {
      unlisten = await onXServerConsentNeeded((req) => {
        if (cancelled) return;
        frontendLog("x_server_connect_consent", `consent needed (id=${req.id})`);
        repliedRef.current = false;
        setRequest(req);
        setPhase("consent");
        setProgress(null);
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // While provisioning, stream progress and close on a terminal step.
  useEffect(() => {
    if (phase !== "provisioning") return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void (async () => {
      unlisten = await onXServerProgress((p) => {
        if (cancelled) return;
        setProgress(p);
        if (!TERMINAL_STEPS.has(p.step)) return;
        if (p.step === "ready") toast.success("X server ready");
        else if (p.step === "failed") toast.error(p.message);
        close();
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // Callbacks are stable per prompt; re-running would restart the listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const handleEnable = async () => {
    if (!request) return;
    repliedRef.current = true;
    await xServerConnectConsentReply(request.id, "enable");
    frontendLog("x_server_connect_consent", `enabled (id=${request.id})`);
    setPhase("provisioning");
    setProgress(null);
  };

  const handleNotNow = () => {
    reply("notNow");
    close();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) handleNotNow();
  };

  return (
    <Modal
      open={request !== null}
      onOpenChange={handleOpenChange}
      title="Set up X server"
      data-testid="x-server-connect-consent-dialog"
      footer={renderFooter()}
    >
      {phase === "consent" ? renderConsent() : renderProvisioning()}
    </Modal>
  );

  /** Reply to the current prompt exactly once (later replies are no-ops). */
  function reply(decision: "enable" | "notNow") {
    if (!request || repliedRef.current) return;
    repliedRef.current = true;
    void xServerConnectConsentReply(request.id, decision);
    frontendLog("x_server_connect_consent", `${decision} (id=${request.id})`);
  }

  /** Dismiss the dialog and reset local state for the next prompt. */
  function close() {
    setRequest(null);
    setPhase("consent");
    setProgress(null);
  }

  function renderConsent() {
    return (
      <div className="x-server-setup__consent" data-testid="x-server-connect-consent-body">
        <p className="x-server-setup__lead">
          <AppWindow className="x-server-setup__lead-icon" size={16} aria-hidden />
          This connection forwards remote GUI apps over SSH (X11), which need a local X server to
          open as native windows.
        </p>
        <p className="x-server-setup__body-text">
          termiHub can set one up now. On Windows it downloads and manages <strong>VcXsrv</strong>{" "}
          (~7&nbsp;MB, a one-time download). Nothing is downloaded until you choose{" "}
          <strong>Enable</strong>.
        </p>
      </div>
    );
  }

  function renderProvisioning() {
    const indeterminate = progress === null || progress.progress < 0;
    const pct = indeterminate ? 0 : Math.round(Math.min(1, Math.max(0, progress.progress)) * 100);
    return (
      <div className="x-server-setup__provisioning">
        <p className="x-server-setup__step">{progress?.message ?? "Starting…"}</p>
        <div
          className="x-server-setup__progress"
          data-testid="x-server-connect-consent-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : pct}
        >
          <div
            className={
              indeterminate
                ? "x-server-setup__progress-fill x-server-setup__progress-fill--indeterminate"
                : "x-server-setup__progress-fill"
            }
            style={indeterminate ? undefined : { width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }

  function renderFooter() {
    if (phase !== "consent") return null;
    return (
      <>
        <Button
          variant="secondary"
          onClick={handleNotNow}
          data-testid="x-server-connect-consent-not-now"
        >
          Not now
        </Button>
        <Button
          variant="primary"
          onClick={handleEnable}
          data-testid="x-server-connect-consent-enable"
        >
          Enable
        </Button>
      </>
    );
  }
}
