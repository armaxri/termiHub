import { useEffect, useRef, useState } from "react";
import { AppWindow } from "lucide-react";
import { toast } from "@/components/ui";
import { xServerConnectConsentReply, xServerInstallDependency } from "@/services/api";
import {
  onXServerConnectFailed,
  onXServerConsentNeeded,
  onXServerProgress,
} from "@/services/events";
import { frontendLog } from "@/utils/frontendLog";
import {
  type XServerConsentRequest,
  type XServerError,
  type XServerProgress,
} from "@/types/xserver";
import { XServerSetupContent, type XServerSetupPhase } from "./XServerSetupContent";
import { driveXServerEnsure } from "./xServerProvisioning";
import { guideTerminalInstall } from "./guideTerminalInstall";
import { errorMessage } from "@/utils/errorMessage";
import { subscribeGuarded, useTauriSubscription } from "@/hooks/useTauriListener";

/**
 * Stable id of the connect-time "X11 forwarding unavailable" toast (#5079), so
 * a burst of failing connects (e.g. restoring several X11 tabs) updates one
 * toast instead of stacking a copy per connect.
 */
export const X_SERVER_CONNECT_FAILED_TOAST_ID = "x-server-connect-failed";

/**
 * Toast copy for a connect whose X server provisioning failed (#5079): the
 * typed message plus, for a missing dependency, its install hint — so the
 * guidance is readable without opening anything — and an action that opens the
 * shared error screen (with its Install / Retry recovery).
 */
export function connectFailureToast(error: XServerError): {
  title: string;
  description: string;
  actionLabel: string;
} {
  const isDependencyMissing = error.kind === "dependencyMissing";
  const hint = isDependencyMissing ? error.installHint : undefined;
  return {
    title: "X11 forwarding unavailable",
    description: hint ? `${error.message} ${hint}` : error.message,
    actionLabel: isDependencyMissing
      ? `Install ${error.dependency ?? "dependency"}…`
      : "Show details",
  };
}

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
 *
 * A connect whose provisioning fails outside this dialog (e.g. a Wayland-only
 * Linux session without XWayland, #5079) arrives as `x-server-connect-failed`
 * with the typed error: it raises a toast carrying the guidance, whose action
 * opens this dialog straight on the error screen. If this dialog is already
 * showing that connect's provisioning, the typed error is folded into its error
 * screen instead, so the user never gets both.
 */
export function XServerConnectConsent() {
  const [request, setRequest] = useState<XServerConsentRequest | null>(null);
  // Showing a connect failure's details (#5079) — open without a consent prompt.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [phase, setPhase] = useState<XServerSetupPhase>("consent");
  const [progress, setProgress] = useState<XServerProgress | null>(null);
  const [error, setError] = useState<XServerError | null>(null);
  const [rawError, setRawError] = useState<unknown>(null);
  // Guards against replying twice for the same prompt (e.g. Enable then close).
  const repliedRef = useRef(false);
  // Which provisioning path the current `provisioning` phase is running.
  const driverRef = useRef<Driver>("backend");

  // Subscribe to connect-time consent prompts for the lifetime of the app.
  useTauriSubscription(
    onXServerConsentNeeded,
    (req) => {
      frontendLog("x_server_connect_consent", `consent needed (id=${req.id})`);
      repliedRef.current = false;
      driverRef.current = "backend";
      setRequest(req);
      setPhase("consent");
      setProgress(null);
      setError(null);
      setRawError(null);
    },
    "x_server_connect_consent"
  );

  // A connect could not get a usable X server (#5079): surface the typed
  // guidance now rather than only in the log.
  useTauriSubscription(
    onXServerConnectFailed,
    (failure) => {
      frontendLog(
        "x_server_connect_consent",
        `connect failed: ${failure.kind}: ${failure.message}`
      );
      const dialogOpen = request !== null || detailsOpen;
      if (dialogOpen && phase !== "consent") {
        // This dialog is driving that connect's provisioning — give its error
        // screen the typed error (install hint + action) instead of a toast.
        setError(failure);
        setRawError(failure.message);
        setPhase("error");
        return;
      }
      const copy = connectFailureToast(failure);
      toast.error(copy.title, {
        id: X_SERVER_CONNECT_FAILED_TOAST_ID,
        description: copy.description,
        testId: "x-server-connect-failed-toast",
        action: { label: copy.actionLabel, onClick: () => showDetails(failure) },
      });
    },
    "x_server_connect_consent"
  );

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
          frontendLog("x_server_connect_consent", `retry failed: ${errorMessage(raw)}`);
          setRawError(raw);
          setError(typed);
          setPhase("error");
        },
      });
    }

    // Backend-driven: the resumed connect emits progress and a terminal step.
    let cancelled = false;
    const dispose = subscribeGuarded(
      () =>
        onXServerProgress((p) => {
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
        }),
      "x_server_connect_consent",
      "x-server-progress"
    );
    return () => {
      cancelled = true;
      dispose();
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
      const msg = errorMessage(e);
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
      open={request !== null || detailsOpen}
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

  /** Open the dialog on the error screen for a failed connect (#5079). */
  function showDetails(failure: XServerError) {
    frontendLog("x_server_connect_consent", `showing connect failure details (${failure.kind})`);
    driverRef.current = "ensure";
    setDetailsOpen(true);
    setError(failure);
    setRawError(failure.message);
    setPhase("error");
  }

  /** Dismiss the dialog and reset local state for the next prompt. */
  function close() {
    setRequest(null);
    setDetailsOpen(false);
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
