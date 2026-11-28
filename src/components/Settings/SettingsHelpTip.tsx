import type { ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Button, Tooltip, TooltipProvider } from "@/components/ui";
import { ICON_SIZE } from "@/components/ui/iconSize";
import "./SettingDefaultMarker.css";

export interface SettingsHelpTipProps {
  /** The field's visible label, used in the button's accessible name. */
  name: string;
  /** The longer explanation shown on hover / focus. */
  children: ReactNode;
  /** Test id of the "?" button; the tooltip content gets `<id>-content`. */
  "data-testid"?: string;
}

/**
 * The "?" beside a setting's label (#5843). A setting's hint stays one short
 * line; the details (limits, retention, the full font fallback list) move in
 * here, shown on hover or keyboard focus, so a settings page does not read as
 * a wall of text. It carries its own {@link TooltipProvider}, so a settings
 * section renders the same whether or not the app root's provider is mounted.
 */
export function SettingsHelpTip({ name, children, "data-testid": testId }: SettingsHelpTipProps) {
  return (
    <TooltipProvider>
      <Tooltip
        content={<span className="settings-help-tip__content">{children}</span>}
        side="top"
        data-testid={testId ? `${testId}-content` : undefined}
      >
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          className="settings-help-tip"
          icon={<CircleHelp size={ICON_SIZE.xs} aria-hidden="true" />}
          aria-label={`More about ${name.charAt(0).toLowerCase()}${name.slice(1)}`}
          data-testid={testId}
        />
      </Tooltip>
    </TooltipProvider>
  );
}
