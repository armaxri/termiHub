import { Unplug } from "lucide-react";
import { Button } from "@/components/ui";
import { t, tf } from "@/i18n/catalog";
import { deletedConnectionLabel } from "@/utils/deletedConnection";
import { ICON_SIZE } from "@/components/ui/iconSize";
import "./DeletedConnections.css";

/** Props of {@link DeletedConnections}. */
export interface DeletedConnectionsProps {
  /** The referenced connections that no longer exist. */
  ids: readonly string[];
  /** Drop one from the choice. */
  onRemove: (id: string) => void;
  /** `data-testid` prefix of each row (suffixed with its position). */
  testIdPrefix: string;
}

/**
 * The connections a trigger or a schedule still names although they were deleted
 * (A-025, #6024): each is said to be gone, and can be removed. Without this a
 * list of unticked connections hides that something was chosen.
 */
export function DeletedConnections({ ids, onRemove, testIdPrefix }: DeletedConnectionsProps) {
  return (
    <>
      {ids.map((id, index) => {
        const label = deletedConnectionLabel(id);
        return (
          <div
            className="deleted-connection"
            key={id}
            data-testid={`${testIdPrefix}-deleted-${index}`}
          >
            <Unplug size={ICON_SIZE.sm} aria-hidden="true" />
            <span className="deleted-connection__name">{label}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={tf("connection.deletedRemoveLabel", { name: label })}
              onClick={() => onRemove(id)}
              data-testid={`${testIdPrefix}-deleted-remove-${index}`}
            >
              {t("connection.deletedRemove")}
            </Button>
          </div>
        );
      })}
    </>
  );
}
