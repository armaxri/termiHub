import { Fragment } from "react";
import { ShieldCheck, ShieldAlert, Copy } from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { toast } from "./Toast";
import "./ui.css";

/** Turn any thrown value into a human-readable string for a toast description. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One host/identity fact rendered in the {@link TrustPrompt} `<dl>` (a host,
 * a key type, a fingerprint, …). A `copyable` fact grows a copy affordance that
 * writes {@link value} to the clipboard and confirms via a toast (UX-034).
 */
export interface TrustFact {
  /** The `<dt>` label, e.g. `Host`, `Fingerprint`. */
  label: string;
  /** The `<dd>` value. */
  value: string;
  /** Render the value monospaced (fingerprints, keys). */
  mono?: boolean;
  /** Show a copy button that copies {@link value} to the clipboard. */
  copyable?: boolean;
  /** `data-testid` forwarded to the `<dd>`. */
  testId?: string;
  /** `data-testid` forwarded to the copy button (when `copyable`). */
  copyTestId?: string;
}

/**
 * Props for the shared {@link TrustPrompt} — the security-sensitive
 * trust-on-first-use dialog behind both the SSH host-key prompt (#1959) and the
 * RDP certificate prompt (#1767).
 */
export interface TrustPromptProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** `true` for a *changed* identity — the possible-MITM case warned about. */
  changed: boolean;
  /** Title (+ ShieldCheck) shown for a new / unknown identity. */
  unknownTitle: string;
  /** Title (+ ShieldAlert) shown when the identity *changed*. */
  changedTitle: string;
  /** Lead sentence for a new / unknown identity (ends with a colon). */
  unknownLead: string;
  /** Lead sentence for a *changed* identity (ends with a colon). */
  changedLead: string;
  /**
   * Subject of the MITM warning, e.g. `host key for this server` or
   * `certificate for this host`. The bold `changed` and the shared safety tail
   * are fixed by the primitive so the warning copy stays identical across
   * protocols.
   */
  changedWarningSubject: string;
  /** Host / identity facts rendered in order. */
  facts: TrustFact[];
  /** Reject the identity and abort — also the ESC / scrim / close default. */
  onReject: () => void;
  /** Accept for this session only. */
  onAcceptOnce: () => void;
  /** Accept and remember for the host. */
  onAcceptForHost: () => void;
  /** `data-testid` for the modal content node. */
  modalTestId: string;
  /** `data-testid` for the Reject button. */
  rejectTestId: string;
  /** `data-testid` for the Accept-once button. */
  acceptOnceTestId: string;
  /** `data-testid` for the Accept-for-host button. */
  acceptForHostTestId: string;
  /** `data-testid` for the MITM warning block. */
  warningTestId: string;
}

/**
 * The shared trust-on-first-use dialog for security-sensitive server identities
 * (UISF-007). An SSH host key (#1959) and an RDP certificate (#1767) are the same
 * decision — trust an unknown identity, or a *changed* one that could be a
 * man-in-the-middle — so both render through this one component to keep the MITM
 * warning, the three-verdict footer, ESC=reject, and the `role="alert"` behaviour
 * identical across protocols.
 *
 * Three verdicts, always in the same order and skins:
 * - **Reject** (ghost) — abort the connection; ESC / scrim / close do the same.
 * - **Accept once** (secondary) — trust for this session only.
 * - **Accept for host** (`changed ? danger : primary`) — trust and remember.
 *
 * Composed from the shared {@link Modal} + {@link Button} primitives; all values
 * come from design tokens. Facts marked `copyable` grow a copy button that
 * confirms via a toast (UX-034).
 */
export function TrustPrompt({
  open,
  changed,
  unknownTitle,
  changedTitle,
  unknownLead,
  changedLead,
  changedWarningSubject,
  facts,
  onReject,
  onAcceptOnce,
  onAcceptForHost,
  modalTestId,
  rejectTestId,
  acceptOnceTestId,
  acceptForHostTestId,
  warningTestId,
}: TrustPromptProps) {
  const copyFact = (fact: TrustFact): Promise<void> => {
    const noun = fact.label.toLowerCase();
    return writeClipboard(fact.value)
      .then(() => {
        toast.success(`Copied ${noun} to clipboard`);
      })
      .catch((err: unknown) => {
        toast.error(`Failed to copy ${noun}`, { description: message(err) });
      });
  };

  return (
    <Modal
      open={open}
      // ESC / scrim / close all count as a rejection — the safe default.
      onOpenChange={(next) => !next && onReject()}
      title={
        <span className="ui-trust-prompt__title">
          {changed ? (
            <ShieldAlert
              size={16}
              className="ui-trust-prompt__title-icon ui-trust-prompt__title-icon--warn"
            />
          ) : (
            <ShieldCheck size={16} className="ui-trust-prompt__title-icon" />
          )}
          {changed ? changedTitle : unknownTitle}
        </span>
      }
      data-testid={modalTestId}
      footer={
        <div className="ui-trust-prompt__actions">
          <Button variant="ghost" onClick={onReject} data-testid={rejectTestId}>
            Reject
          </Button>
          <Button variant="secondary" onClick={onAcceptOnce} data-testid={acceptOnceTestId}>
            Accept once
          </Button>
          <Button
            variant={changed ? "danger" : "primary"}
            onClick={onAcceptForHost}
            data-testid={acceptForHostTestId}
          >
            Accept for host
          </Button>
        </div>
      }
    >
      <div className="ui-trust-prompt__body">
        {changed && (
          <div className="ui-trust-prompt__warning" role="alert" data-testid={warningTestId}>
            <ShieldAlert size={16} className="ui-trust-prompt__warning-icon" aria-hidden="true" />
            <span>
              The {changedWarningSubject} <strong>changed</strong> since you last trusted it. This
              can mean the server was reinstalled — or that someone is intercepting the connection.
              Only continue if you expected this.
            </span>
          </div>
        )}
        <p className="ui-trust-prompt__lead">{changed ? changedLead : unknownLead}</p>
        <dl className="ui-trust-prompt__facts">
          {facts.map((fact, i) => (
            <Fragment key={fact.testId ?? `${fact.label}-${i}`}>
              <dt>{fact.label}</dt>
              <dd
                className={fact.mono ? "ui-trust-prompt__fact-value--mono" : undefined}
                data-testid={fact.testId}
              >
                <span className="ui-trust-prompt__fact-text">{fact.value}</span>
                {fact.copyable && (
                  <Button
                    iconOnly
                    size="xs"
                    variant="ghost"
                    className="ui-trust-prompt__copy"
                    aria-label={`Copy ${fact.label.toLowerCase()}`}
                    data-testid={fact.copyTestId}
                    icon={<Copy size={13} aria-hidden="true" />}
                    onClick={() => copyFact(fact)}
                  />
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
        <p className="ui-trust-prompt__hint">
          Verify the fingerprint matches the one your server administrator reports. &ldquo;Accept
          for host&rdquo; remembers it so you are not asked again.
        </p>
      </div>
    </Modal>
  );
}
