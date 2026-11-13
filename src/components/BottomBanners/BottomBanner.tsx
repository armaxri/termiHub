import type { AriaRole, ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui";
import "./BottomBanners.css";

/** Semantic surface of a bottom banner. */
export type BottomBannerTone = "warning" | "info";

/** Props for {@link BottomBanner}. */
export interface BottomBannerProps {
  /** `warning` (crash notices) or `info` (promotional prompts). */
  tone: BottomBannerTone;
  /** Leading 16px lucide icon; colored by the tone. */
  icon: ReactNode;
  /** One-line headline, rendered bold. */
  title: ReactNode;
  /** Secondary line under the title. */
  description: ReactNode;
  /** The action row: {@link BottomBannerAction}s only. */
  actions: ReactNode;
  /** Optional landmark role (the crash notices are `status`). */
  role?: AriaRole;
  /** Test id of the banner root. */
  "data-testid"?: string;
}

/**
 * Shared shell of the app-level bottom banners (#5638): icon, title and
 * description on the left, one action row on the right. Every banner uses the
 * same layout, surface tokens and button pattern so a "Close" or a
 * "Don't show again" looks and behaves the same everywhere.
 */
export function BottomBanner({
  tone,
  icon,
  title,
  description,
  actions,
  role,
  "data-testid": testId,
}: BottomBannerProps) {
  return (
    <div className={`bottom-banner bottom-banner--${tone}`} role={role} data-testid={testId}>
      <span className="bottom-banner__icon">{icon}</span>
      <div className="bottom-banner__text">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="bottom-banner__actions">{actions}</div>
    </div>
  );
}

/** Props for {@link BottomBannerAction}. */
export interface BottomBannerActionProps extends Omit<ButtonProps, "variant" | "size"> {
  /**
   * The banner's one main action. It is a secondary (outlined) Button, never a
   * filled primary, so the view keeps a single filled primary (#5549). Every
   * other action is a ghost Button in full-contrast text.
   */
  main?: boolean;
}

/**
 * A bottom-banner action: the shared Button primitive at `sm` size, so all
 * actions in every banner share one height and hit area (#5638).
 */
export function BottomBannerAction({ main = false, className, ...rest }: BottomBannerActionProps) {
  return (
    <Button
      {...rest}
      variant={main ? "secondary" : "ghost"}
      size="sm"
      className={["bottom-banner__action", className].filter(Boolean).join(" ")}
    />
  );
}
