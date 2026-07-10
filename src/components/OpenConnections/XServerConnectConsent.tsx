import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { AppWindow } from "lucide-react";
import { toast } from "@/components/ui";
import { xServerConnectConsentReply, xServerInstallDependency } from "@/services/api";
import { onXServerConsentNeeded, onXServerProgress } from "@/services/events";
import { frontendLog } from "@/utils/frontendLog";
import {
  isXServerError,
  type XServerConsentRequest,
  type XServerError,
  type XServerProgress,
} from "@/types/xserver";
import { XServerSetupContent, type XServerSetupPhase } from "./XServerSetupContent";
import { driveXServerEnsure } from "./xServerProvisioning";
import { guideTerminalInstall } from "./guideTerminalInstall";

/** Progress steps that end the backend-driven connect provisioning. */
const TERMINAL_STEPS = new Set(["ready", "failed", "skipped"]);

/**
 * Which path is provisioning while in the `provisioning` phase:
 * - `backend` — the paused connect resumed on Enable; progress (and its terminal
 *   step) is driven entirely by the backend.
 * - `ensure` — a frontend-driven `x_server_ensure` retry from the error screen,
 *   whose promise resolution (not a progress step) decides the outcome.
 */
type Driver = "backend" | "ensure";

/**
 * Connect-triggered X server download-consent + live progress dialog (#1116,
 * #1296). Mounted once at the app root. It listens for the backend's
 * `x-server-consent-needed` event (emitted when opening an X11-forwarding SSH
 * connection would need to download the X dependency and the user has not
 * consented yet), shows the shared consent screen, and — unlike the manual flow
 * — hands the decision back to the **paused connect** via
 * `x_server_connect_consent_reply`. On "Enable" the backend resumes and
 * provisions, streaming `x-server-progress`. A `ready`/`skipped` step closes the
 * dialog; a `failed` step drops into the same recoverable error screen as the
 * manual dialog (Retry re-provisions via `x_server_ensure`; a `dependencyMissing`
 * failure adds an Install action). "Not now" replies `notNow` and the connect
 * continues without X forwarding. The consent / progress / error markup is the
 * shared {@link XServerSetupContent}.
 */
export function XServerConnectConsent() {
  const [request, setRequest] = useState<XServerConsentRequest | null>(null);
  const [phase, setPhase] = useState<XServerSetupPhase>("consent");
  const [progress, setProgress] = useState<XServerProgress | null>(null);
  const [error, setError] = useState<XServerError | null>(null);
  const [rawError, setRawError] = useState<unknown>(null);
  // Guards against replying twice for the same prompt (e.g. Enable then close).
  const repliedRef = useRef(false);
  // Which provisioning path the current `provisioning` phase is running.
  const driverRef = useRef<Driver>("backend");

  // Subscribe to connect-time consent prompts for the lifetime of the app.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void (async () => {
      unlisten = await onXServerConsentNeeded((req) => {
        if (cancelled) return;
        frontendLog("x_server_connect_consent", `consent needed (id=${req.id})`);
        repliedRef.current = false;
        driverRef.current = "backend";
        setRequest(req);
        setPhase("consent");
        setProgress(null);
        setError(null);
        setRawError(null);
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // While provisioning, stream progress. The backend path resolves on a terminal
  // step; the ensure (retry) path resolves via the x_server_ensure promise.
  useEffect(() => {
    if (phase !== "provisioning") return;
    setProgress(null);

    if (driverRef.current === "ensure") {
      return driveXServerEnsure({
        onProgress: setProgress,
        onSuccess: () => {
          toast.success("X server ready");
          close();
        },
        onFailure: (typed, raw) => {
          frontendLog("x_server_connect_consent", `retry failed: ${String(raw)}`);
          setRawError(raw);
          setError(typed);
          setPhase("error");
        },
      });
    }

    // Backend-driven: the resumed connect emits progress and a terminal step.
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void (async () => {
      unlisten = await onXServerProgress((p) => {
        if (cancelled) return;
        setProgress(p);
        if (!TERMINAL_STEPS.has(p.step)) return;
        if (p.step === "ready") {
          toast.success("X server ready");
          close();
        } else if (p.step === "skipped") {
          close();
        } else {
          // failed — surface a recoverable error screen instead of closing.
          frontendLog("x_server_connect_consent", `provisioning failed: ${p.message}`);
          setError(null);
          setRawError(p.message);
          setPhase("error");
        }
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // Only the phase transition should (re)start provisioning; driverRef is read
    // fresh each run and the helper callbacks are stable.
  }, [phase]);

  const handleEnable = async () => {
    if (!request) return;
    repliedRef.current = true;
    driverRef.current = "backend";
    await xServerConnectConsentReply(request.id, "enable");
    frontendLog("x_server_connect_consent", `enabled (id=${request.id})`);
    setPhase("provisioning");
    setProgress(null);
  };

  const handleNotNow = () => {
    reply("notNow");
    close();
  };

  const handleRetry = () => {
    driverRef.current = "ensure";
    setPhase("provisioning");
  };

  const handleInstallDependency = async () => {
    const dep = error?.dependency ?? "dependency";
    try {
      await xServerInstallDependency();
      frontendLog("x_server_connect_consent", `installed dependency ${dep}`);
      toast.success(`${dep} installed`);
      driverRef.current = "ensure";
      setPhase("provisioning");
    } catch (e) {
      const msg = isXServerError(e) ? e.message : String(e);
      frontendLog("x_server_connect_consent", `dependency install failed: ${msg}`);
      toast.error(msg);
      throw e; // return the Button to idle without a success flash
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    if (phase === "consent") handleNotNow();
    else close();
  };

  return (
    <XServerSetupContent
      open={request !== null}
      onOpenChange={handleOpenChange}
      testIdPrefix="x-server-connect-consent"
      phase={phase}
      progress={progress}
      error={error}
      rawError={rawError}
      consent={renderConsent()}
      onEnable={handleEnable}
      onNotNow={handleNotNow}
      onRetry={handleRetry}
      onInstallDependency={handleInstallDependency}
      onGuideTerminalInstall={guideTerminalInstall}
      onClose={close}
    />
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
    setError(null);
    setRawError(null);
    driverRef.current = "backend";
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
          termiHub can set one up now. On Windows it installs and manages <strong>VcXsrv</strong>{" "}
          via winget (a one-time install). Nothing is installed until you choose{" "}
          <strong>Enable</strong>.
        </p>
      </div>
    );
  }
}
