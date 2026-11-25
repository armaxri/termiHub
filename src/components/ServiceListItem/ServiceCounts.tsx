import { t } from "@/i18n/catalog";
import type { ServiceCount, ServiceHealth } from "@/utils/serviceModel";

interface ServiceCountsProps {
  counts: readonly ServiceCount[];
  /** Which rows are shown; all of them without one. */
  only: ServiceHealth | null;
  onOnly: (only: ServiceHealth | null) => void;
  "data-testid": string;
}

/**
 * The numbers of a list (#6063, #6068): how many run, and how many need a look.
 * Pressing one shows only its rows, pressing it again shows all.
 */
export function ServiceCounts({ counts, only, onOnly, ...rest }: ServiceCountsProps) {
  return (
    <div
      className="service-counts"
      role="group"
      aria-label={t("service.counts.label")}
      data-testid={rest["data-testid"]}
    >
      {counts.map((count) => (
        <button
          key={count.id}
          type="button"
          className="service-counts__count"
          aria-pressed={only === count.id}
          onClick={() => onOnly(only === count.id ? null : count.id)}
          data-testid={`service-count-${count.id}`}
        >
          {count.label}
        </button>
      ))}
    </div>
  );
}
