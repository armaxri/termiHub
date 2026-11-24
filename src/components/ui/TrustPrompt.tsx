import { Fragment, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ShieldCheck, ShieldAlert, Copy } from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { toast } from "./Toast";
import { errorMessage } from "@/utils/errorMessage";
import { FingerprintGlyph } from "./FingerprintGlyph";
import "./ui.css";

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
  /**
   * A short secondary line above the value, e.g. a fingerprint's key type
   * (#5627).
   */
  detail?: string;
  /** `data-testid` forwarded to the {@link detail} line. */
  detailTestId?: string;
  /**
   * What the copy button calls the value, e.g. `new fingerprint` (#5862): its
   * accessible name reads "Copy new fingerprint" and the toast "Copied new
   * fingerprint to clipboard". Defaults to the lower-cased {@link label}.
   */
  copyNoun?: string;
  /**
   * Draw a {@link FingerprintGlyph} beside the value (#5862, R-109), so two
   * fingerprints shown together are told apart at a glance.
   */
  glyph?: boolean;
  /** `data-testid` forwarded to the glyph (when {@link glyph}). */
  glyphTestId?: string;
}

/** The length of one display group of a long fingerprint chunk (#5862). */
const FINGERPRINT_GROUP = 4;

/**
 * Split one fingerprint chunk into display groups of
 * {@link FINGERPRINT_GROUP} characters (#5862, R-109), so an old and a new
 * fingerprint stacked under each other line up group by group and the eye can
 * compare them piece by piece. Short chunks (a hex byte, `SHA256:`) stay one
 * group. Joining the groups gives back the chunk unchanged; the groups are
 * spaced by CSS only, so the text a copy or a screen reader gets is the
 * original value.
 */
export function fingerprintGroups(chunk: string): string[] {
  if (chunk.length <= FINGERPRINT_GROUP * 2 || chunk.includes(":")) return [chunk];
  const groups: string[] = [];
  for (let i = 0; i < chunk.length; i += FINGERPRINT_GROUP) {
    groups.push(chunk.slice(i, i + FINGERPRINT_GROUP));
  }
  return groups;
}

/**
 * Split a monospaced value (a fingerprint) into the chunks it may wrap
 * between: after each `:` and at whitespace (#5662). `SHA256:<base64>` becomes
 * `SHA256:` + `<base64>`; a colon-separated hex digest becomes one chunk per
 * byte. Each chunk renders `nowrap`, so the value never breaks mid-string.
 * Joining the chunks gives back the original value unchanged.
 */
export function fingerprintChunks(value: string): string[] {
  return value.match(/[^:\s]*(?::|\s+|$)/g)?.filter((c) => c !== "") ?? [value];
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
  /**
   * For a *changed* identity: plain sentences saying what changed (#5862,
   * R-109), e.g. "The fingerprint is different" and the key type change.
   * Rendered as a list under the facts; ignored for a new identity.
   */
  changes?: string[];
  /** `data-testid` for the {@link changes} list. */
  changesTestId?: string;
  /** Reject the identity and abort — also the ESC / scrim / close default. */
  onReject: () => void;
  /** Accept for this session only. */
  onAcceptOnce: () => void;
  /** Accept and remember for the host. */
  onAcceptForHost: () => void;
  /**
   * Label of the accept-and-remember button for a *changed* identity, e.g.
   * `Replace trusted key` (#5627). Defaults to `Accept for host`.
   */
  changedAcceptForHostLabel?: string;
  /**
   * Footer hint for a *changed* identity, saying what accepting for the host
   * does to the old identity (#5627). Defaults to the first-contact hint.
   */
  changedHint?: ReactNode;
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
 * Three verdicts. For a new identity:
 * - **Reject** (secondary) — abort the connection; ESC / scrim / close do the same.
 * - **Accept once** (secondary) — trust for this session only.
 * - **Accept for host** (primary) — trust and remember.
 *
 * For a *changed* identity the safe choice leads (#5185, #5751, #5826): **Reject**
 * is the primary action at the right end of the footer. Both accepting verdicts
 * are grouped at the left, away from it, and use the `danger` style so neither
 * reads as a harmless "continue" while the MITM warning is up: **Accept once** as
 * a quiet link-style action, **Accept for host** (e.g. "Replace trusted key") as a
 * danger button described by the hint that says what it replaces.
 *
 * In both dialogs Reject takes focus when the dialog opens (#5826), so a stray
 * Enter (typed into a terminal as the dialog appeared) never trusts a key: Enter
 * on Reject, or on any spot in the dialog that is not itself a control, rejects,
 * and so does Escape.
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
  changes,
  changesTestId,
  onReject,
  onAcceptOnce,
  onAcceptForHost,
  changedAcceptForHostLabel = "Accept for host",
  changedHint,
  modalTestId,
  rejectTestId,
  acceptOnceTestId,
  acceptForHostTestId,
  warningTestId,
}: TrustPromptProps) {
  // Reject is the default action (#5751, #5826): it takes focus on open, so
  // Enter on it rejects, and an Enter that reaches the dialog from anywhere that
  // is not itself a control rejects too.
  const hintId = useId();
  const rejectRef = useRef<HTMLButtonElement>(null);
  const rejectOnEnter = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    const control = target.closest(
      "button, a[href], input, select, textarea, [contenteditable='true']"
    );
    // Any other control (an accept verdict, a copy button) keeps its own Enter.
    if (control && control !== rejectRef.current) return;
    // Handled here, so the focused Reject's native click does not fire twice.
    e.preventDefault();
    onReject();
  };

  const copyFact = (fact: TrustFact): Promise<void> => {
    const noun = fact.copyNoun ?? fact.label.toLowerCase();
    return writeClipboard(fact.value)
      .then(() => {
        // toast-policy: no-in-place-surface — the value is on the clipboard
        toast.success(`Copied ${noun} to clipboard`);
      })
      .catch((err: unknown) => {
        toast.error(`Failed to copy ${noun}`, { description: errorMessage(err) });
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
      initialFocusRef={rejectRef}
      onKeyDown={rejectOnEnter}
      footer={
        changed ? (
          <div className="ui-trust-prompt__actions ui-trust-prompt__actions--changed">
            {/* The accepting verdicts sit together at the left, away from the
                safe Reject at the right end (#5826). */}
            <div className="ui-trust-prompt__accepts">
              <Button
                variant="danger"
                className="ui-trust-prompt__link"
                onClick={onAcceptOnce}
                data-testid={acceptOnceTestId}
              >
                Accept once
              </Button>
              <Button
                variant="danger"
                onClick={onAcceptForHost}
                aria-describedby={hintId}
                data-testid={acceptForHostTestId}
              >
                {changedAcceptForHostLabel}
              </Button>
            </div>
            <Button ref={rejectRef} variant="primary" onClick={onReject} data-testid={rejectTestId}>
              Reject
            </Button>
          </div>
        ) : (
          <div className="ui-trust-prompt__actions">
            <Button
              ref={rejectRef}
              variant="secondary"
              onClick={onReject}
              data-testid={rejectTestId}
            >
              Reject
            </Button>
            <Button variant="secondary" onClick={onAcceptOnce} data-testid={acceptOnceTestId}>
              Accept once
            </Button>
            <Button
              variant="primary"
              onClick={onAcceptForHost}
              aria-describedby={hintId}
              data-testid={acceptForHostTestId}
            >
              Accept for host
            </Button>
          </div>
        )
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
              {/* A monospaced value (a fingerprint) gets a full-width row of its
                  own under its label, so it does not have to squeeze in beside
                  the label column (#5662). */}
              <dt className={fact.mono ? "ui-trust-prompt__fact-label--block" : undefined}>
                {fact.label}
              </dt>
              <dd
                className={fact.mono ? "ui-trust-prompt__fact-value--mono" : undefined}
                data-testid={fact.testId}
              >
                {fact.glyph && <FingerprintGlyph value={fact.value} testId={fact.glyphTestId} />}
                <span className="ui-trust-prompt__fact-text">
                  {fact.detail && (
                    <span className="ui-trust-prompt__fact-detail" data-testid={fact.detailTestId}>
                      {fact.detail}
                    </span>
                  )}
                  {fact.mono
                    ? fingerprintChunks(fact.value).map((chunk, j) => (
                        // `<wbr>` marks the only places the line may break.
                        <Fragment key={j}>
                          {j > 0 && <wbr />}
                          <span className="ui-trust-prompt__fact-chunk">
                            {fingerprintGroups(chunk).map((group, k) => (
                              <span key={k} className="ui-trust-prompt__fact-group">
                                {group}
                              </span>
                            ))}
                          </span>
                        </Fragment>
                      ))
                    : fact.value}
                </span>
                {fact.copyable && (
                  <Button
                    iconOnly
                    size="xs"
                    variant="ghost"
                    className="ui-trust-prompt__copy"
                    aria-label={`Copy ${fact.copyNoun ?? fact.label.toLowerCase()}`}
                    data-testid={fact.copyTestId}
                    icon={<Copy size={13} aria-hidden="true" />}
                    onClick={() => copyFact(fact)}
                  />
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
        {changed && changes && changes.length > 0 && (
          <ul className="ui-trust-prompt__changes" data-testid={changesTestId}>
            {changes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <p className="ui-trust-prompt__hint" id={hintId}>
          {changed && changedHint ? (
            changedHint
          ) : (
            <>
              Verify the fingerprint matches the one your server administrator reports.
              &ldquo;Accept for host&rdquo; remembers it so you are not asked again.
            </>
          )}
        </p>
      </div>
    </Modal>
  );
}
