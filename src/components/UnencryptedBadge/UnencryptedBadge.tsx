import { LockOpen } from "lucide-react";
import { t } from "@/i18n/catalog";
import "./UnencryptedBadge.css";

interface UnencryptedBadgeProps {
  /** Test id of the badge element. */
  "data-testid"?: string;
  /** Extra class for placement in its host (tab strip, status bar). */
  className?: string;
  /**
   * Icon-only marker (#5827): the open lock alone, named "Unencrypted" for
   * assistive tech and in its tooltip. Used in the tab strip, where the text
   * badge took the room the connection name needs.
   */
  compact?: boolean;
}

/**
 * The "Unencrypted" state badge (#5749) shown on telnet tabs and in the
 * status-bar telnet chip: telnet sends everything, passwords included, in
 * clear text. Primary text on the warning tint with a warning border, so the
 * label meets 4.5:1 in every theme while the tint carries the warning cue
 * (#5740). The `compact` form is the icon alone (#5827).
 */
export function UnencryptedBadge({ className, compact = false, ...rest }: UnencryptedBadgeProps) {
  const label = t("session.unencrypted.badge");
  const classes = `unencrypted-badge${compact ? " unencrypted-badge--compact" : ""}${
    className ? ` ${className}` : ""
  }`;
  if (compact) {
    return (
      <span
        className={classes}
        role="img"
        aria-label={label}
        title={`${label}: ${t("session.unencrypted.tooltip")}`}
        data-testid={rest["data-testid"]}
      >
        <LockOpen size={12} aria-hidden />
      </span>
    );
  }
  return (
    <span
      className={classes}
      title={t("session.unencrypted.tooltip")}
      data-testid={rest["data-testid"]}
    >
      <LockOpen size={11} aria-hidden />
      {label}
    </span>
  );
}
