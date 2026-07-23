import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { Copy } from "lucide-react";
import { Modal, Button, toast } from "@/components/ui";
import type { XServerError, XServerProgress } from "@/types/xserver";
import "./XServerSetupDialog.css";

/** Which screen of the setup flow is showing. */
export type XServerSetupPhase = "consent" | "provisioning" | "error";

/**
 * Label for the manual-download fallback button, derived from the backend-supplied
 * URL's host (#1312) — e.g. `https://www.xquartz.org` → `Open xquartz.org`. Falls
 * back to generic copy if the URL can't be parsed.
 */
function fallbackButtonLabel(url: string): string {
  try {
    return `Open ${new URL(url).hostname.replace(/^www\./, "")}`;
  } catch {
    return "Open download page";
  }
}

/** Microsoft Store page for App Installer (winget) — the Windows guided prerequisite. */
const APP_INSTALLER_URL = "https://apps.microsoft.com/detail/9NBLGGH4NNS1";

/**
 * Copy the install command to the clipboard so the user can paste and run it
 * instead of retyping it by hand (#1819). Returns the promise so the Button
 * drives its success flash; a rejection surfaces via the Button's error toast.
 */
async function copyInstallCommand(command: string): Promise<void> {
  await writeClipboard(command);
  toast.success("Command copied to clipboard");
}

/**
 * Whether the recovery is a guided-terminal install (#1309): the user runs
 * `installCommand` in a terminal termiHub opens, rather than the generic
 * backend "Install {dependency}" retry. Driven by the typed `installMode`, not
 * the dependency name — so a second guided-install dependency needs no new
 * string-match here.
 */
function isGuidedTerminalInstall(error: XServerError | null): error is XServerError & {
  installCommand: string;
} {
  return (
    error?.kind === "dependencyMissing" &&
    error.installMode === "guidedTerminal" &&
    typeof error.installCommand === "string"
  );
}

/**
 * Whether the recovery is a guided-external install (#1318): a prerequisite
 * package manager is missing and isn't a terminal command, so the UI opens an
 * external page/store (Windows winget-absent → App Installer + a manual VcXsrv
 * download). Keyed on the typed `installMode`, not the dependency name.
 */
function isGuidedExternalInstall(error: XServerError | null): boolean {
  return error?.kind === "dependencyMissing" && error.installMode === "guidedExternal";
}

interface XServerSetupContentProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** Called with the next open state (Modal fires `false` on ESC / close / scrim). */
  onOpenChange: (open: boolean) => void;
  /**
   * Prefix for the derived `data-testid`s (dialog, progress, error, and footer
   * buttons), e.g. `x-server-setup` (manual) or `x-server-connect-consent`
   * (connect-triggered). Keeps the two flows' hooks distinct while sharing markup.
   */
  testIdPrefix: string;
  /** Which screen to render. */
  phase: XServerSetupPhase;
  /** Progress driving the provisioning bar (indeterminate when `null` / `< 0`). */
  progress: XServerProgress | null;
  /**
   * Typed failure driving error-screen recovery: `dependencyMissing` offers an
   * install action, everything else offers a plain Retry. `null` renders the
   * plain message from {@link rawError}.
   */
  error: XServerError | null;
  /** Fallback error used for the message when no typed {@link error} is present. */
  rawError?: unknown;
  /**
   * Consent-screen copy (differs between the manual and connect flows). Owns its
   * own `data-testid` so each flow keeps its established hook.
   */
  consent: ReactNode;
  /** Enable → begin provisioning. Returning a promise opts into pending feedback. */
  onEnable: (event: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  /** Decline on the consent screen (skip / not now). */
  onNotNow: () => void;
  /** Retry provisioning from the error screen. May be async. */
  onRetry: (event: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  /** Install the missing dependency (dependencyMissing only). Async for feedback. */
  onInstallDependency: () => Promise<void>;
  /**
   * Run a guided-terminal install (#1309): opens a local terminal tab titled
   * `tabTitle` pre-loaded with `command` (e.g. the official Homebrew installer)
   * so the user can drive its interactive prompts. Used for a `guidedTerminal`
   * install-mode error.
   */
  onGuideTerminalInstall: (command: string, tabTitle: string) => void | Promise<void>;
  /** Close from the error screen. */
  onClose: () => void;
}

/**
 * Shared consent / provisioning / error body for the X server setup flows
 * (#1296). One markup surface backs both the manual "Set up X server" dialog
 * (`x_server_ensure`) and the connect-triggered consent dialog (the paused
 * connect + `x_server_connect_consent_reply`); the two differ only in who drives
 * provisioning and in the consent copy, which the container supplies. All values
 * reference design tokens; motion respects `prefers-reduced-motion`.
 */
export function XServerSetupContent({
  open,
  onOpenChange,
  testIdPrefix,
  phase,
  progress,
  error,
  rawError,
  consent,
  onEnable,
  onNotNow,
  onRetry,
  onInstallDependency,
  onGuideTerminalInstall,
  onClose,
}: XServerSetupContentProps) {
  const title = phase === "error" ? "X server setup failed" : "Set up X server";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      data-testid={`${testIdPrefix}-dialog`}
      footer={renderFooter()}
    >
      {phase === "consent" && consent}
      {phase === "provisioning" && renderProvisioning()}
      {phase === "error" && renderError()}
    </Modal>
  );

  function renderProvisioning() {
    const indeterminate = progress === null || progress.progress < 0;
    const pct = indeterminate ? 0 : Math.round(Math.min(1, Math.max(0, progress.progress)) * 100);
    return (
      <div className="x-server-setup__provisioning">
        <p className="x-server-setup__step">{progress?.message ?? "Starting…"}</p>
        <div
          className="x-server-setup__progress"
          data-testid={`${testIdPrefix}-progress`}
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
    const installCommand = isDependencyMissing ? error?.installCommand : undefined;
    return (
      <div className="x-server-setup__error">
        <p className="x-server-setup__error-message" data-testid={`${testIdPrefix}-error`}>
          {message}
        </p>
        {isDependencyMissing && error?.installHint && (
          <p className="x-server-setup__hint">{error.installHint}</p>
        )}
        {installCommand && (
          <div className="x-server-setup__command-row">
            <pre className="x-server-setup__command">
              <code>{installCommand}</code>
            </pre>
            <Button
              variant="ghost"
              iconOnly
              icon={<Copy size={16} aria-hidden />}
              aria-label="Copy command"
              title="Copy command"
              data-testid={`${testIdPrefix}-copy-command`}
              onClick={() => copyInstallCommand(installCommand)}
            />
          </div>
        )}
      </div>
    );
  }

  function renderFooter() {
    if (phase === "consent") {
      return (
        <>
          <Button variant="secondary" onClick={onNotNow} data-testid={`${testIdPrefix}-not-now`}>
            Not now
          </Button>
          <Button variant="primary" onClick={onEnable} data-testid={`${testIdPrefix}-enable`}>
            Enable
          </Button>
        </>
      );
    }
    if (phase === "error") {
      return (
        <>
          <Button variant="secondary" onClick={onClose} data-testid={`${testIdPrefix}-close`}>
            Close
          </Button>
          {renderInstallAction()}
          <Button variant="primary" onClick={onRetry} data-testid={`${testIdPrefix}-retry`}>
            Retry
          </Button>
        </>
      );
    }
    // provisioning — no footer actions (work is in flight).
    return null;
  }

  /**
   * The dependency-recovery action(s) on the error screen, keyed on the typed
   * `installMode`. `guidedTerminal` (#1309, macOS brew-absent) opens a terminal
   * running the installer; `guidedExternal` (#1318, Windows winget-absent) opens
   * the Store for App Installer; both add a manual-download fallback button when
   * the error carries an `installFallbackUrl` (#1312). `backend` is the plain
   * install-and-retry against the backend.
   */
  function renderInstallAction() {
    if (isGuidedTerminalInstall(error)) {
      const command = error.installCommand;
      const dependency = error.dependency ?? "dependency";
      const fallbackUrl = error.installFallbackUrl;
      return (
        <>
          {fallbackUrl && (
            <Button
              variant="ghost"
              onClick={() => openUrl(fallbackUrl)}
              data-testid={`${testIdPrefix}-open-fallback`}
            >
              {fallbackButtonLabel(fallbackUrl)}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => onGuideTerminalInstall(command, `Install ${dependency}`)}
            data-testid={`${testIdPrefix}-guided-install`}
          >
            Install {dependency}
          </Button>
        </>
      );
    }
    if (isGuidedExternalInstall(error)) {
      // Windows winget-absent: open the Store for App Installer, then Retry
      // re-detects winget and installs VcXsrv; the payload-driven fallback URL
      // (#1312) is the manual VcXsrv download for a user who declines (#1318).
      const fallbackUrl = error?.installFallbackUrl;
      return (
        <>
          {fallbackUrl && (
            <Button
              variant="ghost"
              onClick={() => openUrl(fallbackUrl)}
              data-testid={`${testIdPrefix}-open-fallback`}
            >
              {fallbackButtonLabel(fallbackUrl)}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => openUrl(APP_INSTALLER_URL)}
            data-testid={`${testIdPrefix}-install-app-installer`}
          >
            Install App Installer
          </Button>
        </>
      );
    }
    if (error?.kind === "dependencyMissing") {
      return (
        <Button
          variant="secondary"
          onClick={onInstallDependency}
          errorToast={false}
          data-testid={`${testIdPrefix}-install-dep`}
        >
          Install {error.dependency ?? "dependency"}
        </Button>
      );
    }
    return null;
  }
}
