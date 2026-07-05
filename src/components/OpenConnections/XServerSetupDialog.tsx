import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { AppWindow } from "lucide-react";
import { Modal, Button, toast } from "@/components/ui";
import { xServerEnsure, xServerInstallDependency } from "@/services/api";
import { onXServerProgress } from "@/services/events";
import { frontendLog } from "@/utils/frontendLog";
import {
  isXServerError,
  type XServerError,
  type XServerProgress,
  type XServerStatusReport,
} from "@/types/xserver";
import "./XServerSetupDialog.css";

/** Which screen of the setup flow is showing. */
type Phase = "consent" | "provisioning" | "error";

interface XServerSetupDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** Called with the next open state (Modal fires `false` on ESC / close / cancel). */
  onOpenChange: (open: boolean) => void;
  /** Invoked with the final report once provisioning succeeds. */
  onProvisioned?: (report: XServerStatusReport) => void;
}

/**
 * Consent-gated setup and live provisioning-progress flow for the shared X
 * server (#1053). Nothing is downloaded or launched before the user hits
 * "Enable". Once consented, it subscribes to `x-server-progress` events, calls
 * `x_server_ensure`, and resolves in place — a failure drops into a recoverable
 * error screen (with an install action when a dependency is missing).
 */
export function XServerSetupDialog({ open, onOpenChange, onProvisioned }: XServerSetupDialogProps) {
  const [phase, setPhase] = useState<Phase>("consent");
  const [progress, setProgress] = useState<XServerProgress | null>(null);
  const [error, setError] = useState<XServerError | null>(null);
  const [rawError, setRawError] = useState<unknown>(null);

  // Reset to the consent screen whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setPhase("consent");
      setProgress(null);
      setError(null);
      setRawError(null);
    }
  }, [open]);

  // Drive provisioning: subscribe to progress events, then run x_server_ensure.
  useEffect(() => {
    if (phase !== "provisioning") return;

    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    setProgress(null);

    void (async () => {
      unlisten = await onXServerProgress((p) => {
        if (!cancelled) setProgress(p);
      });
      try {
        const report = await xServerEnsure();
        if (cancelled) return;
        frontendLog("x_server_setup", `provisioning succeeded (state=${report.state})`);
        toast.success("X server ready");
        onProvisioned?.(report);
        onOpenChange(false);
      } catch (e) {
        if (cancelled) return;
        frontendLog(
          "x_server_setup",
          `provisioning failed: ${isXServerError(e) ? e.message : String(e)}`
        );
        setRawError(e);
        setError(isXServerError(e) ? e : null);
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // Callbacks are stable per open cycle; re-running would restart provisioning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const handleEnable = () => setPhase("provisioning");
  const handleClose = () => onOpenChange(false);
  const handleRetry = () => setPhase("provisioning");

  const handleInstallDependency = async () => {
    const dep = error?.dependency ?? "dependency";
    try {
      await xServerInstallDependency();
      frontendLog("x_server_setup", `installed dependency ${dep}`);
      toast.success(`${dep} installed`);
      setPhase("provisioning");
    } catch (e) {
      const msg = isXServerError(e) ? e.message : String(e);
      frontendLog("x_server_setup", `dependency install failed: ${msg}`);
      toast.error(msg);
      throw e; // return the Button to idle without a success flash
    }
  };

  const title = phase === "error" ? "X server setup failed" : "Set up X server";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      data-testid="x-server-setup-dialog"
      footer={renderFooter()}
    >
      {phase === "consent" && renderConsent()}
      {phase === "provisioning" && renderProvisioning()}
      {phase === "error" && renderError()}
    </Modal>
  );

  function renderConsent() {
    return (
      <div className="x-server-setup__consent" data-testid="x-server-setup-consent">
        <p className="x-server-setup__lead">
          <AppWindow className="x-server-setup__lead-icon" size={16} aria-hidden />
          Remote GUI apps forwarded over SSH (X11) need a local X server to open as native windows.
        </p>
        <p className="x-server-setup__body-text">
          On Windows, termiHub downloads and manages <strong>VcXsrv</strong> (~7&nbsp;MB, a one-time
          download). On macOS and Linux it uses your detected X server, guiding you through setup
          when one is not yet available.
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
          data-testid="x-server-setup-progress"
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

  function renderError() {
    const message =
      error?.message ?? (rawError instanceof Error ? rawError.message : String(rawError));
    const isDependencyMissing = error?.kind === "dependencyMissing";
    return (
      <div className="x-server-setup__error">
        <p className="x-server-setup__error-message" data-testid="x-server-setup-error">
          {message}
        </p>
        {isDependencyMissing && error?.installHint && (
          <p className="x-server-setup__hint">{error.installHint}</p>
        )}
        {isDependencyMissing && error?.installCommand && (
          <pre className="x-server-setup__command">
            <code>{error.installCommand}</code>
          </pre>
        )}
      </div>
    );
  }

  function renderFooter() {
    if (phase === "consent") {
      return (
        <>
          <Button variant="secondary" onClick={handleClose} data-testid="x-server-setup-cancel">
            Not now
          </Button>
          <Button variant="primary" onClick={handleEnable} data-testid="x-server-setup-enable">
            Enable
          </Button>
        </>
      );
    }
    if (phase === "error") {
      return (
        <>
          <Button variant="secondary" onClick={handleClose} data-testid="x-server-setup-close">
            Close
          </Button>
          {error?.kind === "dependencyMissing" && (
            <Button
              variant="secondary"
              onClick={handleInstallDependency}
              errorToast={false}
              data-testid="x-server-setup-install-dep"
            >
              Install {error.dependency ?? "dependency"}
            </Button>
          )}
          <Button variant="primary" onClick={handleRetry} data-testid="x-server-setup-retry">
            Retry
          </Button>
        </>
      );
    }
    // provisioning — no footer actions (work is in flight).
    return null;
  }
}
