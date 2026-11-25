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
      {counts.map((count, index) => (
        <span key={count.id}>
          {index > 0 && <span aria-hidden="true">{"· "}</span>}
          <button
            type="button"
            className="service-counts__count"
            aria-pressed={only === count.id}
            onClick={() => onOnly(only === count.id ? null : count.id)}
            data-testid={`service-count-${count.id}`}
          >
            {count.label}
          </button>
        </span>
      ))}
    </div>
  );
}

/** The rows `only` leaves; a number that is gone shows all of them again. */
export function onlyHealth<T>(
  rows: readonly T[],
  only: ServiceHealth | null,
  healthOf: (row: T) => ServiceHealth
): T[] {
  if (only === null || !rows.some((row) => healthOf(row) === only)) return [...rows];
  return rows.filter((row) => healthOf(row) === only);
}
