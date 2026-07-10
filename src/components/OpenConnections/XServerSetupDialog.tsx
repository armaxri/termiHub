import { useEffect, useState } from "react";
import { AppWindow } from "lucide-react";
import { toast } from "@/components/ui";
import { xServerInstallDependency } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import {
  isXServerError,
  type XServerError,
  type XServerProgress,
  type XServerStatusReport,
} from "@/types/xserver";
import { XServerSetupContent, type XServerSetupPhase } from "./XServerSetupContent";
import { driveXServerEnsure } from "./xServerProvisioning";
import { guideTerminalInstall } from "./guideTerminalInstall";

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
 * "Enable". Once consented, it drives `x_server_ensure` (streaming
 * `x-server-progress`) and resolves in place — a failure drops into a
 * recoverable error screen (with an install action when a dependency is
 * missing). The consent / progress / error markup is the shared
 * {@link XServerSetupContent}; this container owns the frontend-driven state
 * machine.
 */
export function XServerSetupDialog({ open, onOpenChange, onProvisioned }: XServerSetupDialogProps) {
  const [phase, setPhase] = useState<XServerSetupPhase>("consent");
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
    setProgress(null);
    return driveXServerEnsure({
      onProgress: setProgress,
      onSuccess: (report) => {
        frontendLog("x_server_setup", `provisioning succeeded (state=${report.state})`);
        toast.success("X server ready");
        onProvisioned?.(report);
        onOpenChange(false);
      },
      onFailure: (typed, raw) => {
        frontendLog(
          "x_server_setup",
          `provisioning failed: ${isXServerError(raw) ? raw.message : String(raw)}`
        );
        setRawError(raw);
        setError(typed);
        setPhase("error");
      },
    });
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

  return (
    <XServerSetupContent
      open={open}
      onOpenChange={onOpenChange}
      testIdPrefix="x-server-setup"
      phase={phase}
      progress={progress}
      error={error}
      rawError={rawError}
      consent={renderConsent()}
      onEnable={handleEnable}
      onNotNow={handleClose}
      onRetry={handleRetry}
      onInstallDependency={handleInstallDependency}
      onGuideTerminalInstall={guideTerminalInstall}
      onClose={handleClose}
    />
  );

  function renderConsent() {
    return (
      <div className="x-server-setup__consent" data-testid="x-server-setup-consent">
        <p className="x-server-setup__lead">
          <AppWindow className="x-server-setup__lead-icon" size={16} aria-hidden />
          Remote GUI apps forwarded over SSH (X11) need a local X server to open as native windows.
        </p>
        <p className="x-server-setup__body-text">
          On Windows, termiHub installs and manages <strong>VcXsrv</strong> via winget. On macOS and
          Linux it uses your detected X server, guiding you through setup when one is not yet
          available.
        </p>
      </div>
    );
  }
}
