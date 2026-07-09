import type { ReactNode } from "react";
import { Modal, Button } from "@/components/ui";
import type { XServerError, XServerProgress } from "@/types/xserver";
import "./XServerSetupDialog.css";

/** Which screen of the setup flow is showing. */
export type XServerSetupPhase = "consent" | "provisioning" | "error";

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
   * Guide a Homebrew install for the macOS brew-absent case (#1117): opens a
   * local terminal tab pre-loaded with `command` (the official installer). Only
   * used when the error is the `dependency: "Homebrew"` variant.
   */
  onGuideHomebrewInstall: (command: string) => void | Promise<void>;
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
    return (
      <div className="x-server-setup__error">
        <p className="x-server-setup__error-message" data-testid={`${testIdPrefix}-error`}>
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
          {error?.kind === "dependencyMissing" && (
            <Button
              variant="secondary"
              onClick={onInstallDependency}
              errorToast={false}
              data-testid={`${testIdPrefix}-install-dep`}
            >
              Install {error.dependency ?? "dependency"}
            </Button>
          )}
          <Button variant="primary" onClick={onRetry} data-testid={`${testIdPrefix}-retry`}>
            Retry
          </Button>
        </>
      );
    }
    // provisioning — no footer actions (work is in flight).
    return null;
  }
}
