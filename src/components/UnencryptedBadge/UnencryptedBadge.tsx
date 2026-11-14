import { LockOpen } from "lucide-react";
import { t } from "@/i18n/catalog";
import "./UnencryptedBadge.css";

interface UnencryptedBadgeProps {
  /** Test id of the badge element. */
  "data-testid"?: string;
  /** Extra class for placement in its host (tab strip, status bar). */
  className?: string;
}

/**
 * The "Unencrypted" state badge (#5749) shown on telnet tabs and in the
 * status-bar telnet chip: telnet sends everything, passwords included, in
 * clear text. Primary text on the warning tint with a warning border, so the
 * label meets 4.5:1 in every theme while the tint carries the warning cue
 * (#5740).
 */
export function UnencryptedBadge({ className, ...rest }: UnencryptedBadgeProps) {
  return (
    <span
      className={`unencrypted-badge${className ? ` ${className}` : ""}`}
      title={t("session.unencrypted.tooltip")}
      data-testid={rest["data-testid"]}
    >
      <LockOpen size={11} aria-hidden />
      {t("session.unencrypted.badge")}
    </span>
  );
}
