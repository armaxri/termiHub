import { useState } from "react";
import type { PluginSignerChange, PluginVersionChange } from "@/types/plugin";
import { Checkbox, ConfirmDialog } from "@/components/ui";
import { versionChangeCopy } from "./PluginVersionChangeDialog";
import "./Plugins.css";

/** Props for {@link PluginSignerChangeDialog}. */
export interface PluginSignerChangeDialogProps {
  /** The publisher-key change the backend asked the user to confirm. */
  signer: PluginSignerChange;
  /**
   * A version change for the same install that also still needs confirmation
   * (e.g. a downgrade signed by a different key) — shown in the same dialog so
   * one explicit confirmation covers both.
   */
  version: PluginVersionChange | null;
  /** Re-issue the install with the confirmation flag(s) set. */
  onConfirm: () => Promise<void>;
  /** Abandon the replace; the installed plugin stays as it is. */
  onCancel: () => void;
}

/** Title, explanation and confirm-button label for one kind of signer change. */
interface SignerChangeCopy {
  title: string;
  message: string;
  confirmLabel: string;
  acknowledge: string;
}

/**
 * The prompt copy for a publisher-key change. Only the kinds the backend
 * refuses without confirmation reach this dialog; anything else falls back to
 * the "cannot verify" wording, which is the conservative reading.
 */
export function signerChangeCopy(change: PluginSignerChange): SignerChangeCopy {
  const name = change.pluginName;
  switch (change.kind) {
    case "keyChanged":
      return {
        title: `The publisher key of ${name} changed`,
        message:
          `The installed ${name} was signed by one key, but this package is signed by a ` +
          "different key. Publishers rarely change their signing key — a new key can mean " +
          "the update source was compromised and someone else built this package. Only " +
          "continue if the publisher announced a key change and you have checked the new " +
          "fingerprint with them.",
        confirmLabel: "Replace with new key",
        acknowledge: "I have verified that the publisher changed their signing key",
      };
    case "signatureRemoved":
      return {
        title: `${name} is no longer signed`,
        message:
          `The installed ${name} was signed by its publisher, but this package carries no ` +
          "signature at all, so termiHub cannot tell who built it. A signed plugin losing its " +
          "signature is a strong sign that this package did not come from the original " +
          "publisher. Do not continue unless you are certain where this file came from.",
        confirmLabel: "Replace with unsigned package",
        acknowledge: "I understand this package cannot be traced to the original publisher",
      };
    default:
      return {
        title: `Cannot verify the publisher of ${name}`,
        message:
          `termiHub could not determine which key signed the installed copy of ${name}, so ` +
          "it cannot check that this package comes from the same publisher. Only continue if " +
          "you trust where this file came from.",
        confirmLabel: "Replace anyway",
        acknowledge: "I trust where this package came from",
      };
  }
}

/** A fingerprint for display, or the reason there is none. */
function keyLabel(keyId: string | null, missing: string): string {
  return keyId ?? missing;
}

/**
 * Danger-styled confirmation shown when installing a package would replace an
 * installed plugin with one signed by a **different key**, an **unsigned**
 * package replacing a signed one, or over an installed copy whose signer is
 * unknown (#3489). The backend refused the install and changed nothing.
 *
 * Shows both fingerprints side by side and explains the risk. Confirming takes
 * two deliberate actions — ticking the acknowledgement and clicking the confirm
 * button; Enter never confirms. When the same install also needs a version
 * change confirmed (e.g. a downgrade), that is shown here too and one
 * confirmation covers both.
 */
export function PluginSignerChangeDialog({
  signer,
  version,
  onConfirm,
  onCancel,
}: PluginSignerChangeDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const copy = signerChangeCopy(signer);
  const versionCopy = version ? versionChangeCopy(version) : null;

  return (
    <ConfirmDialog
      open
      variant="danger"
      title={copy.title}
      description={`Confirm replacing ${signer.pluginName} despite a publisher key change`}
      confirmLabel={copy.confirmLabel}
      confirmVariant="danger"
      confirmDisabled={!acknowledged}
      confirmOnEnter={false}
      confirmErrorToast={false}
      testIdBase="plugin-signer-change"
      data-testid="plugin-signer-change-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p className="plugin-signer-change__message" data-testid="plugin-signer-change-message">
        {copy.message}
      </p>
      <div className="plugin-signer-change__keys" data-testid="plugin-signer-change-keys">
        <span className="plugin-install__label">Installed key</span>
        <code data-testid="plugin-signer-change-installed-key">
          {keyLabel(signer.installedKeyId, signer.kind === "unverifiable" ? "unknown" : "unsigned")}
        </code>
        <span className="plugin-install__label">New key</span>
        <code data-testid="plugin-signer-change-incoming-key">
          {keyLabel(signer.incomingKeyId, "none — package is unsigned")}
        </code>
      </div>
      {versionCopy && (
        <div className="plugin-signer-change__version" data-testid="plugin-signer-change-version">
          <span className="plugin-signer-change__version-title">{versionCopy.title}</span>{" "}
          <span>{versionCopy.message}</span>
        </div>
      )}
      <label className="plugin-install__trust-check" htmlFor="plugin-signer-change-ack">
        <Checkbox
          id="plugin-signer-change-ack"
          checked={acknowledged}
          onCheckedChange={setAcknowledged}
          data-testid="plugin-signer-change-ack"
        />
        <span>{copy.acknowledge}</span>
      </label>
    </ConfirmDialog>
  );
}
